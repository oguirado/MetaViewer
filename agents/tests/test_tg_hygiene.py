"""U3-AG-05: process/credential pins and real timeout reaping on both paths."""
import ast
from collections import Counter
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from metaviewer_agents.perception.base import Frame, PerceptionError
from metaviewer_agents.perception.vcore import VCorePerceptionAdapter

PRODUCT = Path(__file__).resolve().parents[1] / "metaviewer_agents"
VCORE = "perception/vcore.py"
SITES = {"VCorePerceptionAdapter.perceive", "VCorePerceptionAdapter.run_vcore"}
ENV_KEYS = {"PATH", "HOME", "LANG", "VQA_VE_ROOT", "MV_CORE_CONFIG", "XDG_RUNTIME_DIR"}
# The pinned-component resolver alone inspects Git provenance through _git.
DEPS_LOCK = "perception/deps_lock.py"
# Each key selects the checkout whose revision must match the dependency lock.
COMPONENT_ROOT_KEYS = {"vision-engine": "VQA_VE_ROOT", "wender-agent": "MV_WENDER_ROOT"}
# Wender's bounded pipe helper executes the explicitly validated planner argv.
WENDER = "wender_bridge.py"


def process_audit(source, filename):
    """Allow only explicit list-argv, bounded, scrubbed vcore run calls."""
    tree = ast.parse(source)
    parents = {child: parent for parent in ast.walk(tree) for child in ast.iter_child_nodes(parent)}
    violations, sites = [], []
    aliases = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                aliases[alias.asname or alias.name] = alias.name
                if alias.name == "subprocess" and (filename not in {VCORE, DEPS_LOCK, WENDER} or alias.asname):
                    violations.append("subprocess import")
        if isinstance(node, ast.ImportFrom):
            if node.module == "subprocess":
                violations.append("subprocess from-import")
            for alias in node.names:
                aliases[alias.asname or alias.name] = (node.module or "") + "." + alias.name

    def qualified(node):
        text = ast.unparse(node)
        root, dot, rest = text.partition(".")
        return aliases.get(root, root) + (dot + rest if dot else "")

    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        name = qualified(node.func)
        if any(keyword.arg == "shell" and not (
                isinstance(keyword.value, ast.Constant) and keyword.value.value is False)
               for keyword in node.keywords):
            violations.append("shell enabled")
        if name.startswith("os.") and name.split(".")[-1].startswith(
                ("kill", "fork", "exec", "spawn", "posix_spawn", "system", "popen")):
            violations.append("os process control")
        if not name.startswith("subprocess.") and not (
                filename == VCORE and name == "_run_bounded"):
            continue
        if name in {"subprocess.TimeoutExpired", "subprocess.CalledProcessError"}:
            continue
        scope, function = [], None
        parent = parents.get(node)
        while parent is not None:
            if isinstance(parent, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                scope.append(parent.name)
                if function is None and isinstance(parent, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    function = parent
            parent = parents.get(parent)
        site = ".".join(reversed(scope))
        if filename == VCORE and site == "_run_bounded":
            allowed_vcore_calls = (
                '''subprocess.run(command, cwd=cwd, env=env, capture_output=True,
                    stdin=stdin, timeout=timeout, pass_fds=pass_fds)''',
                '''subprocess.run(command, cwd=cwd, env=env, capture_output=True,
                    stdin=stdin, timeout=timeout)''',
                '''subprocess.Popen(command, cwd=cwd, env=env, stdin=stdin,
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, pass_fds=pass_fds)''',
                '''subprocess.CompletedProcess(command, proc.returncode,
                    b"".join(stdout_chunks), b"".join(stderr_chunks))''',
            )
            if any(ast.dump(node) == ast.dump(ast.parse(expr).body[0].value)
                   for expr in allowed_vcore_calls):
                continue
        if filename == WENDER and site == "_run_bounded":
            expected_calls = {
                "subprocess.Popen": '''subprocess.Popen(command, cwd=cwd, env=env,
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)''',
                "subprocess.CompletedProcess": '''subprocess.CompletedProcess(command,
                    process.returncode, bytes(outputs[process.stdout]), b"")''',
            }
            expected = expected_calls.get(name)
            if expected is not None and ast.dump(node) == ast.dump(ast.parse(expected).body[0].value):
                if name == "subprocess.Popen":
                    sites.append(site)
                continue
        if filename == DEPS_LOCK and name == "subprocess.run" and site == "_git":
            sites.append(site)
            # Admit only the existing bounded, scrubbed Git provenance call.
            expected = ast.parse('''subprocess.run(
                ["git", "-c", "core.fsmonitor=false", "-C", str(root), *arguments],
                env=environment, stdin=subprocess.DEVNULL, capture_output=True,
                text=True, encoding="utf-8", errors="strict", timeout=2.0,
                check=False)''').body[0].value
            if ast.dump(node) != ast.dump(expected):
                violations.append("unbounded Git spawn")
            environments = [child.value for child in ast.walk(function)
                            if isinstance(child, ast.Assign)
                            and any(isinstance(target, ast.Name) and target.id == "environment"
                                    for target in child.targets)]
            scrubbed = ast.parse('''{"PATH": os.environ.get("PATH", os.defpath),
                "HOME": os.devnull, "LANG": "C", "GIT_CONFIG_NOSYSTEM": "1"}''',
                                 mode="eval").body
            if len(environments) != 1 or ast.dump(environments[0]) != ast.dump(scrubbed):
                violations.append("unscrubbed Git environment")
            continue
        if filename != VCORE or name != "_run_bounded" or site not in SITES:
            violations.append("unapproved spawn")
            continue
        sites.append(site)
        keywords = {keyword.arg: keyword.value for keyword in node.keywords}
        if None in keywords or not {"timeout", "env", "cwd", "stdin"} <= keywords.keys():
            violations.append("unbounded spawn")
        timeout_expr = ast.unparse(keywords.get("timeout", ast.Constant(None)))
        has_shared_deadline = (
            site == "VCorePerceptionAdapter.perceive"
            and timeout_expr == "timeout"
            and any(
                isinstance(child, ast.Assign)
                and any(isinstance(t, ast.Name) and t.id == "deadline" for t in child.targets)
                and ast.unparse(child.value) == "time.monotonic() + self.timeout"
                for child in ast.walk(function)
            )
            and any(
                isinstance(child, ast.Assign)
                and any(isinstance(t, ast.Name) and t.id == "timeout" for t in child.targets)
                and ast.unparse(child.value) == "_remaining_timeout(deadline)"
                for child in ast.walk(function)
            )
        )
        if timeout_expr != "self.timeout" and not has_shared_deadline:
            violations.append("missing adapter deadline")
        if not node.args or not isinstance(node.args[0], ast.Name):
            violations.append("argv is not an explicit local list")
        else:
            variable = node.args[0].id
            assignments = [child.value for child in ast.walk(function)
                           if isinstance(child, ast.Assign)
                           and any(isinstance(target, ast.Name) and target.id == variable
                                   for target in child.targets)]
            if not assignments or any(not isinstance(value, ast.List) for value in assignments):
                violations.append("argv is not an explicit local list")
    return violations, Counter(sites)


def environment_audit(source, filename=None):
    """Reject credential keys, dynamic lookup and wholesale env inheritance."""
    tree = ast.parse(source)
    parents = {child: parent for parent in ast.walk(tree) for child in ast.iter_child_nodes(parent)}
    aliases = {alias.asname or alias.name: alias.name for node in ast.walk(tree)
               if isinstance(node, ast.Import) for alias in node.names}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module == "os":
            aliases.update({alias.asname or alias.name: "os." + alias.name for alias in node.names})

    def name(node):
        text = ast.unparse(node)
        root, dot, tail = text.partition(".")
        return aliases.get(root, root) + (dot + tail if dot else "")

    violations = []
    for node in ast.walk(tree):
        expression = None
        if isinstance(node, ast.Call) and name(node.func) in {"os.getenv", "os.environ.get"}:
            expression = node.args[0] if node.args else None
        elif isinstance(node, ast.Subscript) and name(node.value) == "os.environ":
            expression = node.slice
        elif isinstance(node, (ast.Attribute, ast.Name)) and name(node) == "os.environ":
            parent = parents.get(node)
            if isinstance(parent, ast.Subscript) and parent.value is node:
                continue
            if isinstance(parent, ast.Attribute) and parent.attr == "get":
                call = parents.get(parent)
                if isinstance(call, ast.Call) and call.func is parent:
                    continue
            violations.append("whole environment access")
            continue
        else:
            continue
        keys = set()
        if isinstance(expression, ast.Constant) and isinstance(expression.value, str):
            keys.add(expression.value)
        elif (filename == DEPS_LOCK and isinstance(expression, ast.Subscript)
              and ast.unparse(expression) == "_ROOT_VARIABLES[name]"):
            # Admit the resolver's literal component mapping, never arbitrary dynamic keys.
            mappings = [child.value for child in tree.body if isinstance(child, ast.Assign)
                        and any(isinstance(target, ast.Name) and target.id == "_ROOT_VARIABLES"
                                for target in child.targets)]
            if len(mappings) == 1 and isinstance(mappings[0], ast.Dict):
                try:
                    mapping = ast.literal_eval(mappings[0])
                except (ValueError, TypeError):
                    mapping = None
                if mapping == COMPONENT_ROOT_KEYS:
                    continue
        elif isinstance(expression, ast.Name):
            # The only admitted dynamic key is a lexical loop over literal keys.
            parent = parents.get(node)
            while parent is not None:
                if isinstance(parent, ast.For) and isinstance(parent.target, ast.Name) and parent.target.id == expression.id:
                    if isinstance(parent.iter, (ast.Tuple, ast.List)) and all(
                            isinstance(item, ast.Constant) and isinstance(item.value, str)
                            for item in parent.iter.elts):
                        keys.update(item.value for item in parent.iter.elts)
                    break
                parent = parents.get(parent)
        # Wender alone may select its locked planner checkout from this key.
        allowed = ENV_KEYS | ({"MV_WENDER_ROOT"} if filename == WENDER else set())
        if filename == VCORE:
            allowed |= {"MV_VCORE_SITE"}
        # verify.py reads a JSON planner argv array, never a credential or shell command.
        if filename == "verify.py":
            allowed |= {"MV_WENDER_PLANNER_CMD"}
        if not keys or not keys <= allowed:
            violations.append("unapproved environment key")
    return violations


class HygieneGapTests(unittest.TestCase):
    def test_only_allowlisted_bounded_argv_spawn_sites_exist(self):
        # Mutation: change either vcore subprocess.run call to subprocess.Popen.
        sites = Counter()
        files = sorted(PRODUCT.rglob("*.py"))
        self.assertTrue(files)
        for path in files:
            relative = path.relative_to(PRODUCT).as_posix()
            violations, found = process_audit(path.read_text(encoding="utf-8"), relative)
            self.assertEqual(violations, [], relative)
            sites.update(found)
        self.assertEqual(sites, Counter({site: 1 for site in SITES | {"_git", "_run_bounded"}}))
        source = (PRODUCT / VCORE).read_text(encoding="utf-8")
        for old, new in (("result = _run_bounded(", "result = subprocess.Popen("),
                         ("timeout=self.timeout", "shell=True, timeout=self.timeout")):
            self.assertTrue(process_audit(source.replace(old, new), VCORE)[0])
        for bad in ("import os\nos.kill(123, 0)",
                    "from subprocess import run\nrun(['x'])",
                    "import subprocess as sp\nsp.run(['x'])",
                    "import subprocess\nsubprocess.run('x', shell=True)"):
            self.assertTrue(process_audit(bad, "other.py")[0])
        string_argv = source.replace('command = [self.python, "-m", "visioncore.cli", verb, *args]',
                                     'command = "unsafe command"')
        self.assertNotEqual(source, string_argv)
        self.assertTrue(process_audit(string_argv, VCORE)[0])

    def test_environment_reads_are_explicit_and_never_credentials(self):
        # Mutation: replace MV_CORE_CONFIG lookup in mvctl with OPENAI_API_KEY.
        for path in sorted(PRODUCT.rglob("*.py")):
            self.assertEqual(environment_audit(path.read_text(encoding="utf-8"),
                                              path.relative_to(PRODUCT).as_posix()), [], str(path))
        for key in ("OPENAI_API_KEY", "ACCESS_TOKEN", "CLIENT_SECRET"):
            for expression in (f'os.getenv("{key}")', f'os.environ.get("{key}")',
                               f'os.environ["{key}"]'):
                self.assertTrue(environment_audit("import os\n" + expression))
        for code in ("import os\ndict(os.environ)", "import os\nos.environ.get(key)",
                     "from os import environ as env\nenv.get('ACCESS_TOKEN')"):
            self.assertTrue(environment_audit(code))

    def test_vcore_site_exception_remains_exact_and_file_scoped(self):
        for expression in ('os.getenv("MV_VCORE_SITE")',
                           'os.environ.get("MV_VCORE_SITE")',
                           'os.environ["MV_VCORE_SITE"]'):
            source = "import os\n" + expression
            self.assertEqual(environment_audit(source, VCORE), [])
            for filename in (None, "other.py", WENDER, DEPS_LOCK, "verify.py"):
                self.assertIn("unapproved environment key", environment_audit(source, filename))
        self.assertIn("unapproved environment key", environment_audit(
            'import os\nos.environ.get("MV_VCORE_SITE_OTHER")', VCORE))

    def test_planner_command_exception_remains_exact_and_file_scoped(self):
        source = (PRODUCT / "verify.py").read_text(encoding="utf-8")
        self.assertEqual(environment_audit(source, "verify.py"), [])
        mutant = source.replace("MV_WENDER_PLANNER_CMD", "NEW_UNAPPROVED_KEY")
        self.assertNotEqual(mutant, source)
        self.assertIn("unapproved environment key", environment_audit(mutant, "verify.py"))
        for filename in (None, "other.py", WENDER, DEPS_LOCK):
            self.assertIn("unapproved environment key", environment_audit(
                'import os\nos.environ.get("MV_WENDER_PLANNER_CMD")', filename))

    def test_dependency_lock_exceptions_remain_exact_and_file_scoped(self):
        source = (PRODUCT / DEPS_LOCK).read_text(encoding="utf-8")
        self.assertEqual(process_audit(source, DEPS_LOCK), ([], Counter({"_git": 1})))
        self.assertEqual(environment_audit(source, DEPS_LOCK), [])
        self.assertIn("unapproved spawn", process_audit(source, "other.py")[0])
        self.assertIn("subprocess import", process_audit(source, "other.py")[0])
        self.assertTrue(environment_audit(source, "other.py"))
        for old, new in (("timeout=2.0", "timeout=None"),
                         ('["git",', '["other",'),
                         ("env=environment", "env=None"),
                         ('"HOME": os.devnull', '"HOME": os.environ.get("HOME")'),
                         ("def _git(", "def another_spawn("),
                         ("subprocess.run(", "subprocess.Popen(")):
            mutant = source.replace(old, new)
            self.assertNotEqual(mutant, source)
            with self.subTest(mutation=new):
                self.assertTrue(process_audit(mutant, DEPS_LOCK)[0])
        mutant = source.replace('"MV_WENDER_ROOT"', '"NEW_UNAPPROVED_ROOT"')
        self.assertNotEqual(mutant, source)
        self.assertTrue(environment_audit(mutant, DEPS_LOCK))
        for filename in (DEPS_LOCK, "other.py"):
            self.assertTrue(environment_audit(
                'import os\nos.getenv("NEW_UNAPPROVED_ROOT")', filename))

    def test_wender_pipe_exception_remains_exact_and_file_scoped(self):
        source = (PRODUCT / WENDER).read_text(encoding="utf-8")
        self.assertEqual(process_audit(source, WENDER), ([], Counter({"_run_bounded": 1})))
        self.assertEqual(environment_audit(source, WENDER), [])
        self.assertIn("unapproved spawn", process_audit(source, "other.py")[0])
        for old, new in (("env=env", "env=None"),
                         ("stdin=subprocess.PIPE", "stdin=None"),
                         ("subprocess.Popen(command,", "subprocess.Popen('shell string',"),
                         ("def _run_bounded(", "def another_spawn(")):
            mutant = source.replace(old, new)
            self.assertNotEqual(source, mutant)
            self.assertTrue(process_audit(mutant, WENDER)[0])
        self.assertTrue(environment_audit(source.replace(
            '"MV_WENDER_ROOT"', '"NEW_UNAPPROVED_ROOT"'), WENDER))

    def test_timeout_kills_and_reaps_actual_engine_on_both_spawn_paths(self):
        # Mutation: timeout=self.timeout -> timeout=None at either spawn site.
        # The child exits after a bounded delay if that mutation is applied, so
        # this test fails cleanly instead of leaving a runaway sleeper behind.
        code = '''import json, os, pathlib, sys, time
pathlib.Path('child.pid').write_text(str(os.getpid()))
if '--quick' in sys.argv:
    print(json.dumps({'code': 'OK'}))
else:
    time.sleep(4)
    print('{}')
'''
        with tempfile.TemporaryDirectory(prefix="tg-reap-") as directory:
            root = Path(directory)
            for package, module in (("visioncore", "cli"), ("vadapt", "cu_describe")):
                target = root / package
                target.mkdir()
                (target / "__init__.py").write_text("", encoding="utf-8")
                (target / (module + ".py")).write_text(code, encoding="utf-8")
            adapter = VCorePerceptionAdapter(root, python=sys.executable, timeout=1)
            self.assertEqual(adapter.run_vcore("selftest", ["--quick"]), {"code": "OK"})
            real_popen = subprocess.Popen
            for method in ("run_vcore", "perceive"):
                with self.subTest(method=method):
                    (root / "child.pid").unlink()
                    children = []

                    def spawn(*args, **kwargs):
                        child = real_popen(*args, **kwargs)
                        children.append(child)
                        return child

                    with patch("subprocess.Popen", side_effect=spawn):
                        with self.assertRaises(PerceptionError) as caught:
                            if method == "run_vcore":
                                adapter.run_vcore("selftest")
                            else:
                                adapter.perceive(
                                    {"width": 4, "height": 4, "sha256": hashlib.sha256(bytes(48)).hexdigest()},
                                    Frame(4, 4, bytes(48)),
                                )
                    self.assertEqual(caught.exception.code, "timeout")
                    self.assertEqual(len(children), 1)
                    child = children[0]
                    self.assertEqual(int((root / "child.pid").read_text()), child.pid)
                    self.assertIsNotNone(child.returncode)
                    self.assertLess(child.returncode, 0)
                    with self.assertRaises(ChildProcessError):
                        os.waitpid(child.pid, os.WNOHANG)


if __name__ == "__main__":
    unittest.main()
