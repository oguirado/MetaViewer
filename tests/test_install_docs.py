"""Verify docs/INSTALL.md against repository paths, runnable commands, and version pins."""

from __future__ import annotations

import json
from pathlib import Path
import re
import shlex
import tomllib
import unittest

ROOT = Path(__file__).resolve().parents[1]
INSTALL_DOC = ROOT / "docs/INSTALL.md"
README_DOC = ROOT / "README.md"

FORBIDDEN_TERMS = (
    "co-authored-by",
    "generated with",
    "claude",
    "anthropic",
    "chatgpt",
    "openai",
    "gpt-",
    "gemini",
    "codex",
    "copilot",
    "muse spark",
    "llama",
    "assistant",
    "ai-generated",
)

HOST_PATH_PATTERNS = (
    re.compile(r"/home/[A-Za-z0-9_.-]+"),
    re.compile(r"/Users/[A-Za-z0-9_.-]+"),
    re.compile(r"/usr/local/go\b"),
    re.compile(r"~/\.(?:cargo|nvm|local)\b"),
)

REPO_PREFIXES = (
    "scripts/",
    "ui/",
    "tools/",
    "docs/",
    "core/",
    "daemon-adapter/",
    "agents/",
    ".github/",
    "contracts/",
    "tests/",
)

REPO_EXACT_FILES = {
    "VERSION",
    "Cargo.toml",
    "Cargo.lock",
    "deps.lock",
    "LAWS.md",
    "README.md",
    "CHANGELOG.md",
}

SHELL_BUILTINS_AND_SYSTEM_TOOLS = {
    "cd",
    "export",
    "mkdir",
    "rm",
    "tar",
    "sha256sum",
    "xvfb-run",
    "./metaviewer",
}

CARGO_SUBCOMMANDS = {"build", "test", "clippy", "fmt", "check", "run"}
GO_SUBCOMMANDS = {"build", "test", "vet", "run"}


def extract_fenced_bash_blocks(markdown: str) -> list[str]:
    """Return the body of every fenced bash/sh block in markdown."""
    pattern = re.compile(r"^```(?:bash|sh)\n(.*?)^```", re.M | re.S)
    return pattern.findall(markdown)


def split_logical_commands(block: str) -> list[list[str]]:
    """Parse a shell block into logical argv lists after joining line continuations."""
    joined_lines: list[str] = []
    accumulator = ""
    for raw_line in block.splitlines():
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.endswith("\\"):
            accumulator += stripped[:-1].rstrip() + " "
            continue
        accumulator += stripped
        joined_lines.append(accumulator)
        accumulator = ""
    if accumulator:
        joined_lines.append(accumulator)

    commands: list[list[str]] = []
    for line in joined_lines:
        tokens = shlex.split(line, posix=True)
        while tokens and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", tokens[0]):
            if len(tokens) == 1:
                break
            tokens = tokens[1:]
        if tokens:
            commands.append(tokens)
    return commands


def load_sources_of_truth(root: Path) -> dict[str, object]:
    """Read authoritative version pins and command tables from repository manifests."""
    version = (root / "VERSION").read_text(encoding="utf-8").strip()
    cargo_toml = tomllib.loads((root / "Cargo.toml").read_text(encoding="utf-8"))
    core_cargo_toml = tomllib.loads((root / "core/Cargo.toml").read_text(encoding="utf-8"))
    pyproject = tomllib.loads((root / "agents/pyproject.toml").read_text(encoding="utf-8"))
    ui_pkg = json.loads((root / "ui/package.json").read_text(encoding="utf-8"))
    kit_lock = json.loads((root / "ui/kit.lock.json").read_text(encoding="utf-8"))
    deps_lock = json.loads((root / "deps.lock").read_text(encoding="utf-8"))
    go_mod = (root / "daemon-adapter/go.mod").read_text(encoding="utf-8")
    gate_sh = (root / "tools/gate.sh").read_text(encoding="utf-8")
    package_js = (root / "ui/tools/package.js").read_text(encoding="utf-8")

    go_match = re.search(r"^go\s+(\S+)$", go_mod, re.M)
    if not go_match:
        raise ValueError("daemon-adapter/go.mod missing go directive")

    fmt_match = re.search(r"tools\['rustup'\],\s*'run',\s*'([^']+)',\s*'cargo',\s*'fmt'", gate_sh)
    if not fmt_match:
        raise ValueError("tools/gate.sh missing pinned rustup formatter version")

    cargo_packages = {core_cargo_toml["package"]["name"]}
    cargo_bins = {entry["name"] for entry in core_cargo_toml.get("bin", [])}

    return {
        "version": version,
        "rust_version": cargo_toml["workspace"]["package"]["rust-version"],
        "rust_fmt_version": fmt_match.group(1),
        "go_version": go_match.group(1),
        "python_requires": pyproject["project"]["requires-python"],
        "node_engine": ui_pkg["engines"]["node"],
        "electron_version": ui_pkg["dependencies"]["electron"],
        "npm_scripts": set(ui_pkg.get("scripts", {}).keys()),
        "kit_lock": kit_lock,
        "deps_lock": {c["name"]: c for c in deps_lock["components"]},
        "cargo_packages": cargo_packages,
        "cargo_bins": cargo_bins,
        "package_js": package_js,
    }


def validate_command_in_tree(tokens: list[str], cwd_rel: str, root: Path, truth: dict[str, object]) -> tuple[str, list[str]]:
    """Validate one command from a fenced bash block and return (next_cwd_rel, errors)."""
    errors: list[str] = []
    head = tokens[0]

    if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", head):
        return cwd_rel, errors

    if head == "cd":
        if len(tokens) != 2:
            return cwd_rel, [f"unsupported cd invocation: {tokens!r}"]
        target = tokens[1]
        if target.startswith("/path/to/"):
            return cwd_rel, errors
        candidate = (root / cwd_rel / target).resolve()
        try:
            rel = candidate.relative_to(root.resolve())
        except ValueError:
            return cwd_rel, [f"cd escapes repository: {target}"]
        if not candidate.is_dir():
            return cwd_rel, [f"cd target directory does not exist in tree: {target}"]
        return ("" if str(rel) == "." else str(rel)), errors

    if head in SHELL_BUILTINS_AND_SYSTEM_TOOLS:
        return cwd_rel, errors

    base_dir = root / cwd_rel if cwd_rel else root

    if head == "bash":
        if len(tokens) < 2:
            return cwd_rel, ["bash invocation missing script path"]
        script_rel = tokens[1]
        script_path = base_dir / script_rel
        if not script_path.is_file():
            errors.append(f"missing bash script in tree: {script_rel}")
        return cwd_rel, errors

    if head == "node":
        args = tokens[1:]
        if not args:
            return cwd_rel, ["node invocation missing script"]
        if args[0] == "--test":
            if len(args) < 2:
                return cwd_rel, ["node --test missing file"]
            target_rel = args[1]
        else:
            target_rel = args[0]
        target_path = base_dir / target_rel
        if not target_path.is_file():
            errors.append(f"missing node script in tree: {target_rel}")
        return cwd_rel, errors

    if head == "python3":
        args = tokens[1:]
        if not args:
            return cwd_rel, ["python3 invocation missing arguments"]
        if args[0] == "-m":
            if len(args) >= 2 and args[1] == "unittest":
                if "-s" in args:
                    idx = args.index("-s")
                    if idx + 1 >= len(args):
                        errors.append("python3 -m unittest -s missing directory")
                    else:
                        suite_dir = base_dir / args[idx + 1]
                        if not suite_dir.is_dir():
                            errors.append(f"missing unittest directory in tree: {args[idx + 1]}")
            elif len(args) >= 2:
                module_parts = args[1].split(".")
                module_candidate = root / "agents" / Path(*module_parts).with_suffix(".py")
                if not module_candidate.is_file():
                    errors.append(f"missing python module in tree: {args[1]}")
        else:
            script_rel = args[0]
            if not (base_dir / script_rel).is_file():
                errors.append(f"missing python3 script in tree: {script_rel}")
        return cwd_rel, errors

    if head == "rustup":
        if len(tokens) < 5 or tokens[1] != "run" or tokens[3] != "cargo":
            return cwd_rel, [f"unsupported rustup invocation: {tokens!r}"]
        toolchain = tokens[2]
        if toolchain != truth["rust_fmt_version"]:
            errors.append(
                f"rustup toolchain {toolchain!r} does not match pinned formatter {truth['rust_fmt_version']!r}"
            )
        return validate_command_in_tree(tokens[3:], cwd_rel, root, truth)

    if head == "cargo":
        if len(tokens) < 2 or tokens[1] not in CARGO_SUBCOMMANDS:
            return cwd_rel, [f"unknown or non-runnable cargo command: {tokens!r}"]
        if "-p" in tokens:
            idx = tokens.index("-p")
            if idx + 1 >= len(tokens) or tokens[idx + 1] not in truth["cargo_packages"]:
                pkg = tokens[idx + 1] if idx + 1 < len(tokens) else "<missing>"
                errors.append(f"unknown cargo package in tree: {pkg}")
        if "--bin" in tokens:
            idx = tokens.index("--bin")
            if idx + 1 >= len(tokens) or tokens[idx + 1] not in truth["cargo_bins"]:
                binary = tokens[idx + 1] if idx + 1 < len(tokens) else "<missing>"
                errors.append(f"unknown cargo binary in tree: {binary}")
        return cwd_rel, errors

    if head == "go":
        args = tokens[1:]
        go_dir = base_dir
        if len(args) >= 2 and args[0] == "-C":
            go_dir = base_dir / args[1]
            args = args[2:]
        if not go_dir.is_dir() or not (go_dir / "go.mod").is_file():
            errors.append(f"missing Go module directory in tree: {go_dir}")
            return cwd_rel, errors
        if not args or args[0] not in GO_SUBCOMMANDS:
            errors.append(f"unknown or non-runnable go subcommand: {tokens!r}")
            return cwd_rel, errors
        target = args[-1]
        if target != "./...":
            target_dir = go_dir / target
            if not target_dir.exists():
                errors.append(f"missing Go package path in tree: {target}")
        return cwd_rel, errors

    if head == "npm":
        args = tokens[1:]
        npm_dir = base_dir
        if len(args) >= 2 and args[0] in ("--prefix", "-C"):
            npm_dir = base_dir / args[1]
            args = args[2:]
        if not (npm_dir / "package.json").is_file():
            errors.append(f"npm command run outside package directory: {npm_dir}")
            return cwd_rel, errors
        if not args:
            errors.append("empty npm command")
            return cwd_rel, errors
        sub = args[0]
        if sub in ("ci", "install"):
            return cwd_rel, errors
        if sub == "test":
            if "test" not in truth["npm_scripts"]:
                errors.append("npm test script missing from ui/package.json")
            return cwd_rel, errors
        if sub == "run":
            if len(args) < 2 or args[1] not in truth["npm_scripts"]:
                script_name = args[1] if len(args) >= 2 else "<missing>"
                errors.append(f"unknown npm script in ui/package.json: {script_name}")
            return cwd_rel, errors
        errors.append(f"unsupported npm subcommand: {tokens!r}")
        return cwd_rel, errors

    errors.append(f"unrecognized command in fenced bash block: {tokens!r}")
    return cwd_rel, errors


def extract_inline_repo_paths(markdown: str) -> set[str]:
    """Extract repository-relative paths from inline backtick spans outside fenced blocks."""
    stripped = re.sub(r"^```.*?^```", "", markdown, flags=re.M | re.S)
    paths: set[str] = set()
    for span in re.findall(r"`([^`\n]+)`", stripped):
        token = span.strip()
        if " " in token or token.startswith(("$", "<", "-", "/")):
            continue
        if token in REPO_EXACT_FILES or token.startswith(REPO_PREFIXES):
            paths.add(token)
    return paths


def validate_install_doc(markdown: str, root: Path = ROOT, readme_text: str | None = None) -> list[str]:
    """Validate docs/INSTALL.md contents, commands, paths, versions, and error codes."""
    errors: list[str] = []
    truth = load_sources_of_truth(root)

    if readme_text is None and (root / "README.md").is_file():
        readme_text = (root / "README.md").read_text(encoding="utf-8")
    if readme_text is not None:
        if "[docs/INSTALL.md](docs/INSTALL.md)" not in readme_text:
            errors.append("README.md is missing the link to docs/INSTALL.md")

    lower = markdown.lower()
    for word in FORBIDDEN_TERMS:
        if word in lower:
            errors.append(f"forbidden term in INSTALL.md: {word}")

    for pattern in HOST_PATH_PATTERNS:
        match = pattern.search(markdown)
        if match:
            errors.append(f"host path in INSTALL.md: {match.group(0)}")

    blocks = extract_fenced_bash_blocks(markdown)
    if not blocks:
        errors.append("INSTALL.md contains no fenced bash blocks")

    for block in blocks:
        cwd_rel = ""
        for tokens in split_logical_commands(block):
            cwd_rel, cmd_errors = validate_command_in_tree(tokens, cwd_rel, root, truth)
            errors.extend(cmd_errors)

    for rel_path in sorted(extract_inline_repo_paths(markdown)):
        clean = rel_path.rstrip("/")
        if "*" in clean or "<" in clean:
            continue
        target = root / clean
        if not target.exists():
            errors.append(f"missing repository path referenced in INSTALL.md: {rel_path}")

    kit_lock = truth["kit_lock"]
    assert isinstance(kit_lock, dict)
    required_versions = {
        "release version": str(truth["version"]),
        "Rust rust-version": str(truth["rust_version"]),
        "Rust formatter": str(truth["rust_fmt_version"]),
        "Go version": str(truth["go_version"]),
        "Python requires-python": str(truth["python_requires"]),
        "Node engine": str(truth["node_engine"]),
        "Electron version": str(truth["electron_version"]),
        "kit version": str(kit_lock["version"]),
        "kit commit": str(kit_lock["commit"]),
        "kit contentHash": str(kit_lock["contentHash"]),
    }
    for label, expected_val in required_versions.items():
        if f"`{expected_val}`" not in markdown and expected_val not in markdown:
            errors.append(f"INSTALL.md missing authoritative {label}: {expected_val}")

    deps_lock = truth["deps_lock"]
    assert isinstance(deps_lock, dict)
    for comp_name, comp in deps_lock.items():
        for field in ("version", "commit", "repo"):
            val = comp[field]
            if f"`{val}`" not in markdown and val not in markdown:
                errors.append(f"INSTALL.md missing {comp_name} {field}: {val}")

    pkg_codes = set(re.findall(r"\bPKG_[A-Z0-9_]+\b", markdown))
    if "PKG_MANIFEST_MISMATCH" not in pkg_codes:
        errors.append("INSTALL.md must document PKG_MANIFEST_MISMATCH")
    package_js = str(truth["package_js"])
    for code in sorted(pkg_codes):
        if code not in package_js:
            errors.append(f"PKG error code in INSTALL.md not found in ui/tools/package.js: {code}")

    return errors


class InstallDocsTests(unittest.TestCase):
    """Verify docs/INSTALL.md and its negative controls."""

    def setUp(self) -> None:
        self.markdown = INSTALL_DOC.read_text(encoding="utf-8")
        self.readme = README_DOC.read_text(encoding="utf-8")

    def test_install_doc_passes_all_checks(self) -> None:
        errors = validate_install_doc(self.markdown, ROOT, self.readme)
        self.assertEqual(errors, [], "\n".join(errors))

    def test_fenced_bash_blocks_cover_bootstrap_gate_and_package_cli(self) -> None:
        blocks = extract_fenced_bash_blocks(self.markdown)
        self.assertGreaterEqual(len(blocks), 4)
        joined = "\n".join(blocks)
        for required_snippet in (
            "bash scripts/bootstrap.sh",
            "bash tools/gate.sh",
            " bash tools/gate.sh --self-test",
            "node ui/tools/package.js --verify-install",
            "node ui/tools/package.js --smoke",
            "node tools/sync_kit.mjs",
            "cargo build --offline -p metaviewer-core",
            "rustup run 1.92.0 cargo fmt --all --check",
            "npm ci --offline",
        ):
            self.assertIn(required_snippet.strip(), joined)

    def test_negative_control_planted_missing_path_in_bash_block_fails(self) -> None:
        planted_bash = self.markdown + "\n```bash\nbash scripts/missing_install_helper.sh\n```\n"
        errors = validate_install_doc(planted_bash, ROOT, self.readme)
        self.assertTrue(
            any("missing bash script in tree: scripts/missing_install_helper.sh" in e for e in errors),
            errors,
        )

    def test_negative_control_planted_missing_inline_repo_path_fails(self) -> None:
        planted_inline = self.markdown + "\nSee `tools/nonexistent_verifier.py` for details.\n"
        errors = validate_install_doc(planted_inline, ROOT, self.readme)
        self.assertTrue(
            any("missing repository path referenced in INSTALL.md: tools/nonexistent_verifier.py" in e for e in errors),
            errors,
        )

    def test_negative_control_planted_invalid_npm_cargo_and_go_commands_fail(self) -> None:
        bad_npm = self.markdown + "\n```bash\ncd ui\nnpm run nonexistent-script\n```\n"
        self.assertTrue(
            any("unknown npm script in ui/package.json: nonexistent-script" in e
                for e in validate_install_doc(bad_npm, ROOT, self.readme))
        )

        bad_cargo = self.markdown + "\n```bash\ncargo build --offline -p nonexistent-crate\n```\n"
        self.assertTrue(
            any("unknown cargo package in tree: nonexistent-crate" in e
                for e in validate_install_doc(bad_cargo, ROOT, self.readme))
        )

        bad_go = self.markdown + "\n```bash\ngo -C daemon-adapter build ./cmd/nonexistent\n```\n"
        self.assertTrue(
            any("missing Go package path in tree: ./cmd/nonexistent" in e
                for e in validate_install_doc(bad_go, ROOT, self.readme))
        )

    def test_negative_control_version_drift_fails(self) -> None:
        truth = load_sources_of_truth(ROOT)
        kit_lock = truth["kit_lock"]
        assert isinstance(kit_lock, dict)
        for label, actual, drifted in (
            ("kit version", str(kit_lock["version"]), "0.0.9-drifted"),
            ("Electron version", str(truth["electron_version"]), "44.0.0-drifted"),
            ("Node engine", str(truth["node_engine"]), ">=22"),
            ("Go version", str(truth["go_version"]), "1.25.0"),
            ("Rust rust-version", str(truth["rust_version"]), "1.80"),
        ):
            with self.subTest(label=label):
                mutated = self.markdown.replace(actual, drifted)
                errors = validate_install_doc(mutated, ROOT, self.readme)
                self.assertTrue(
                    any(label in e for e in errors),
                    f"expected {label} drift to fail, got {errors!r}",
                )

    def test_negative_control_fake_pkg_error_code_and_host_path_fail(self) -> None:
        bad_code = self.markdown + "\n| `PKG_NONEXISTENT_CODE` | Fake code |\n"
        self.assertTrue(
            any("PKG_NONEXISTENT_CODE" in e for e in validate_install_doc(bad_code, ROOT, self.readme))
        )

        bad_host = self.markdown + "\nExport `/home/alice/custom-path` before running.\n"
        self.assertTrue(
            any("host path in INSTALL.md" in e for e in validate_install_doc(bad_host, ROOT, self.readme))
        )


AI_GUIDE_DOC = ROOT / "docs/AI_OPERATOR_GUIDE.md"
JUDGE_QUICKSTART_DOC = ROOT / "docs/JUDGE_QUICKSTART.md"


def split_logical_commands_with_heredocs(block: str) -> list[list[str]]:
    """Parse a shell block into logical argv lists, skipping heredoc bodies."""
    cleaned_lines: list[str] = []
    heredoc_delim: str | None = None
    for raw_line in block.splitlines():
        if heredoc_delim is not None:
            if raw_line.strip() == heredoc_delim:
                heredoc_delim = None
            continue
        m = re.search(r"<<-?\s*['\"]?([A-Za-z0-9_]+)['\"]?", raw_line)
        if m:
            heredoc_delim = m.group(1)
            raw_line = raw_line[: m.start()].rstrip()
        cleaned_lines.append(raw_line)
    return split_logical_commands("\n".join(cleaned_lines))


def validate_operator_guide_doc(markdown: str, root: Path = ROOT, doc_name: str = "AI_OPERATOR_GUIDE.md") -> list[str]:
    """Validate docs/AI_OPERATOR_GUIDE.md or docs/JUDGE_QUICKSTART.md against repo truth."""
    errors: list[str] = []
    truth = load_sources_of_truth(root)

    lower = markdown.lower()
    for word in FORBIDDEN_TERMS:
        if word in lower:
            errors.append(f"forbidden term in {doc_name}: {word}")

    for pattern in HOST_PATH_PATTERNS:
        match = pattern.search(markdown)
        if match:
            errors.append(f"host path in {doc_name}: {match.group(0)}")

    for rel_path in sorted(extract_inline_repo_paths(markdown)):
        clean = rel_path.rstrip("/")
        if "*" in clean or "<" in clean:
            continue
        if not (root / clean).exists():
            errors.append(f"missing repository path referenced in {doc_name}: {rel_path}")

    blocks = extract_fenced_bash_blocks(markdown)
    if not blocks:
        errors.append(f"{doc_name} contains no fenced bash blocks")

    judge_subs = {"doctor", "install", "run", "stop"}
    judge_flags = {"--capsules", "--yes", "--no-firewall"}

    for block in blocks:
        cwd_rel = ""
        for tokens in split_logical_commands_with_heredocs(block):
            while tokens and tokens[0] in ("sudo", "env"):
                tokens = tokens[1:]
                while tokens and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", tokens[0]):
                    tokens = tokens[1:]
            if tokens and tokens[0] == "systemd-run":
                if "--" in tokens:
                    tokens = tokens[tokens.index("--") + 1 :]
                    while tokens and tokens[0] == "env":
                        tokens = tokens[1:]
                        while tokens and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", tokens[0]):
                            tokens = tokens[1:]
                else:
                    continue
            if not tokens or tokens[0] in (".", "mount"):
                continue
            if tokens[0] == "python3" and len(tokens) >= 2 and tokens[1] == "-":
                continue
            if tokens[0] == "bash" and len(tokens) >= 2 and tokens[1] == "scripts/judge/metaviewer-judge.sh":
                if len(tokens) < 3 or tokens[2] not in judge_subs:
                    errors.append(f"invalid metaviewer-judge.sh subcommand in {doc_name}: {tokens!r}")
                for flag in tokens[3:]:
                    if flag not in judge_flags:
                        errors.append(f"unknown metaviewer-judge.sh flag in {doc_name}: {flag}")
                continue
            cwd_rel, cmd_errors = validate_command_in_tree(tokens, cwd_rel, root, truth)
            errors.extend(cmd_errors)

    return errors


class AiOperatorGuideAndJudgeQuickstartTests(unittest.TestCase):
    """Verify docs/AI_OPERATOR_GUIDE.md, docs/JUDGE_QUICKSTART.md, and links."""

    def setUp(self) -> None:
        self.guide = AI_GUIDE_DOC.read_text(encoding="utf-8")
        self.quickstart = JUDGE_QUICKSTART_DOC.read_text(encoding="utf-8")
        self.install = INSTALL_DOC.read_text(encoding="utf-8")
        self.readme = README_DOC.read_text(encoding="utf-8")

    def test_ai_operator_guide_passes_all_validation_checks(self) -> None:
        errors = validate_operator_guide_doc(self.guide, ROOT, "AI_OPERATOR_GUIDE.md")
        self.assertEqual(errors, [], "\n".join(errors))

    def test_judge_quickstart_passes_all_validation_checks(self) -> None:
        errors = validate_operator_guide_doc(self.quickstart, ROOT, "JUDGE_QUICKSTART.md")
        self.assertEqual(errors, [], "\n".join(errors))
        self.assertNotIn("are being finished", self.quickstart)
        self.assertNotIn("at least 15 logical CPUs", self.quickstart)
        self.assertNotIn("at least 15 logical CPUs", self.install)
        self.assertIn("[AI_OPERATOR_GUIDE.md](AI_OPERATOR_GUIDE.md)", self.quickstart)
        self.assertIn("[docs/AI_OPERATOR_GUIDE.md](docs/AI_OPERATOR_GUIDE.md)", self.readme)

    def test_ai_operator_guide_covers_all_required_features_and_limitations(self) -> None:
        required_items = (
            "Humans",
            "Agents",
            "Ctrl+Tab",
            "Ctrl+1",
            "Single",
            "Side by side",
            "Grid",
            "Focus + strip",
            "Floating",
            "Manual",
            "Add capsule",
            "Identity browser",
            "Program",
            "Desktop window",
            "Mark as logged in",
            "Take control (emergency)",
            "Watch read-only",
            "Switch to agent mode",
            "Switch to human mode",
            "Copy ID for AI",
            "🚀 Bootstrap",
            "＋ New terminal",
            "Open in multislot",
            "Identities",
            "Use MetaViewer",
            "docs/AGENT_ENTRY.md",
            "Automate from a demo",
            "metaviewer_agents.mw_run",
            "MemoryWeb",
            "tools/build_release_assets.py",
            "opensuperficies-identity-browser-",
            "opensuperficies-program-host-",
            "macOS",
            "X11",
        )
        for item in required_items:
            with self.subTest(item=item):
                self.assertIn(item, self.guide)

    def test_negative_control_unknown_judge_flag_or_missing_script_in_guide_fails(self) -> None:
        bad_flag = self.guide + "\n```bash\nbash scripts/judge/metaviewer-judge.sh install --invented-flag\n```\n"
        errors = validate_operator_guide_doc(bad_flag, ROOT, "AI_OPERATOR_GUIDE.md")
        self.assertTrue(any("unknown metaviewer-judge.sh flag" in e for e in errors), errors)

        bad_script = self.guide + "\n```bash\npython3 tools/invented_nonexistent_tool.py\n```\n"
        errors2 = validate_operator_guide_doc(bad_script, ROOT, "AI_OPERATOR_GUIDE.md")
        self.assertTrue(any("missing python3 script in tree" in e for e in errors2), errors2)


class BuildReleaseAssetsToolTests(unittest.TestCase):
    """Verify tools/build_release_assets.py builds clean archives and refuses unsafe inputs."""

    def test_build_all_assets_and_negative_controls(self) -> None:
        import sys
        import tarfile
        import tempfile

        sys.path.insert(0, str(ROOT / "tools"))
        import build_release_assets as bra

        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            app_dir = base / "MetaViewer-linux-x64"
            app_dir.mkdir()
            exe = app_dir / "metaviewer"
            exe.write_bytes(b"#!/bin/sh\nexit 0\n")
            exe.chmod(0o755)

            node_bin = base / "node"
            node_bin.write_bytes(b"#!/bin/sh\necho v24.14.0\n")
            node_bin.chmod(0o755)

            srf_dir = base / "srf-bin"
            srf_dir.mkdir()
            for name in ("srf-identity-surface", "srf-identity-admin"):
                p = srf_dir / name
                p.write_bytes(b"#!/bin/sh\nexit 0\n")
                p.chmod(0o755)

            fw_dir = base / "fw"
            fw_dir.mkdir()
            for name in ("apply.sh", "srf-open-egress.rules", "srf-open-egress6.rules", "srf-open-egress.service"):
                (fw_dir / name).write_bytes(b"# fixture\n")

            ve_dir = base / "ve"
            ve_dir.mkdir()
            (ve_dir / "README.md").write_text("vision-engine\n", encoding="utf-8")

            wa_dir = base / "wa"
            wa_dir.mkdir()
            (wa_dir / "README.md").write_text("wender-agent\n", encoding="utf-8")

            img_tar = base / "images.tar"
            with tarfile.open(img_tar, "w") as tf:
                bra._add_bytes(tf, "manifest.json", b"[]\n", 0o644)

            out_dir = base / "out"
            summary = bra.build_all_assets(
                out_dir=out_dir,
                arch="x64",
                app_dir=app_dir,
                node_bin=node_bin,
                srf_dir=srf_dir,
                firewall_dir=fw_dir,
                vision_engine_dir=ve_dir,
                wender_agent_dir=wa_dir,
                images_tar=img_tar,
            )
            self.assertEqual(summary["arch"], "x64")
            names = [a["name"] for a in summary["assets"]]
            self.assertEqual(
                names,
                [
                    "images-linux-x64.tar",
                    "metaviewer-linux-x64.tar.gz",
                    "node-linux-x64.tar.xz",
                    "opensuperficies-linux-x64.tar.gz",
                    "vision-engine.tar.gz",
                    "wender-agent.tar.gz",
                ],
            )
            self.assertTrue((out_dir / "SHA256SUMS").is_file())

            # Negative control: symlink inside app_dir must be refused.
            (app_dir / "bad-link").symlink_to(exe)
            with self.assertRaises(bra.AssetBuildError):
                bra.build_app_asset(app_dir, out_dir, "x64")


if __name__ == "__main__":
    unittest.main()
