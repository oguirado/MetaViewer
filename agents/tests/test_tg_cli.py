"""U3-AG-01: exercise the CLI boundary, including real hello exchanges.

Invalid startup registration is a usage_error, distinct from a malformed
proposal or reply, and must never echo its path or contents.
[TARGET, unit decision] CLI list requires --limit and accepts optional --cursor,
mapping directly to the admitted single-page tools.list_surfaces arguments.
"""
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import test_mvctl_v02 as fixture
import test_tools as tool_fixture
from metaviewer_agents import mvctl


class CliGapTests(unittest.TestCase):
    core = fixture.MvctlV02Tests.core

    def argv(self, path, *extra, command="observe"):
        return [command, "--socket", str(path), "--session-id", "sess-1",
                "--agent-instance", "agent-1", "--core-instance", "core-1",
                "--timeout-ms", "2000", "--max-line-bytes", "65536",
                "--max-reply-bytes", "65536",
                *(["--surface-id", "surf-1"] if command == "observe" else []), *extra]

    def invoke(self, path, env_config, *extra, command="observe"):
        env = dict(os.environ, PYTHONPATH=str(fixture.ROOT),
                   MV_CORE_CONFIG=str(env_config))
        return subprocess.run([sys.executable, "-m", "metaviewer_agents.mvctl",
                               *self.argv(path, *extra, command=command)], env=env,
                              capture_output=True, text=True, timeout=8)

    def registration(self, path):
        target = path.parent / "trusted.json"
        target.write_text(json.dumps(fixture.config()), encoding="utf-8")
        return target

    def test_list_cli_dispatches_existing_tool_protocol_page(self):
        # Mutation: remove "list" from the default v0.2 parser command choices.
        page = tool_fixture._ok_list("unused", [tool_fixture._surface(state="destroyed")],
                                     next_cursor="next-page")
        with tempfile.TemporaryDirectory(prefix="tg-list-") as directory:
            path = Path(directory) / "core.sock"
            client = tool_fixture._FakeClient([tool_fixture._reply(page)])
            with patch.dict(os.environ, {"MV_CORE_CONFIG": str(self.registration(path))}), \
                    patch("metaviewer_agents.client.ToolClient") as transport:
                transport.return_value.__enter__.return_value = client
                out, err = io.StringIO(), io.StringIO()
                with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                    rc = mvctl.run(self.argv(path, "--limit", "10", "--cursor", "current-page", command="list"))
                self.assertEqual((rc, err.getvalue()), (0, ""))
                result = json.loads(out.getvalue())
                self.assertEqual(result["surfaces"], page["surfaces"])
                self.assertEqual(result["next_cursor"], "next-page")
                self.assertEqual(len(out.getvalue().splitlines()), 1)
                self.assertEqual(len(client.calls), 1)
                self.assertEqual(client.calls[0][0]["args"], {"cursor": "current-page", "limit": 10})
        # Repeat through the production transport and a real hello/socket pair.
        reply = lambda call: dict(page, request_id=call["request_id"])
        with self.core([[reply]]) as (path, calls):
            completed = self.invoke(path, self.registration(path), "--limit", "10",
                                    "--cursor", "current-page", command="list")
        self.assertEqual((completed.returncode, completed.stderr), (0, ""))
        self.assertEqual(json.loads(completed.stdout)["surfaces"], page["surfaces"])
        self.assertEqual(json.loads(completed.stdout)["next_cursor"], "next-page")
        self.assertEqual([row["body"]["op"] for row in calls], ["list"])
        self.assertEqual(calls[0]["body"]["args"], {"cursor": "current-page", "limit": 10})

    def test_list_argument_rails_and_other_verbs_refuse_before_tool_dispatch(self):
        # Mutation: remove the list-only limit/cursor validation in _run_v02.
        cases = [("list", [], "usage_error"),
                 ("list", ["--limit", "0"], "usage_error"),
                 ("list", ["--limit", "257"], "schema_error"),
                 ("list", ["--limit", "10", "--cursor", "CURSOR CANARY"], "schema_error"),
                 ("list", ["--limit", "10", "--surface-id", "surf-1"], "usage_error"),
                 ("observe", ["--limit", "10"], "usage_error"),
                 ("observe", ["--cursor", "CURSOR-CANARY"], "usage_error")]
        with tempfile.TemporaryDirectory(prefix="tg-list-") as directory:
            path = Path(directory) / "core.sock"
            for command, flags, code in cases:
                with self.subTest(command=command, flags=flags), patch.dict(
                        os.environ, {"MV_CORE_CONFIG": str(self.registration(path))}), patch(
                        "metaviewer_agents.client.ToolClient") as transport:
                    client = tool_fixture._FakeClient([])
                    transport.return_value.__enter__.return_value = client
                    out, err = io.StringIO(), io.StringIO()
                    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                        rc = mvctl.run(self.argv(path, *flags, command=command))
                    self.assertEqual((rc, out.getvalue()), (2, ""))
                    self.assertEqual(json.loads(err.getvalue())["code"], code)
                    self.assertNotIn("CANARY", err.getvalue())
                    self.assertEqual(client.calls, [])
                    if code == "usage_error":
                        transport.assert_not_called()

    def test_list_malformed_page_is_local_error_without_partial_stdout(self):
        # Mutation: skip _check_surface on list results.
        page = tool_fixture._ok_list("unused", [tool_fixture._surface(),
            tool_fixture._surface(surface_id="bad", state="invalid")])
        with tempfile.TemporaryDirectory(prefix="tg-list-") as directory:
            path = Path(directory) / "core.sock"
            client = tool_fixture._FakeClient([tool_fixture._reply(page)])
            with patch.dict(os.environ, {"MV_CORE_CONFIG": str(self.registration(path))}), \
                    patch("metaviewer_agents.client.ToolClient") as transport:
                transport.return_value.__enter__.return_value = client
                out, err = io.StringIO(), io.StringIO()
                with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                    rc = mvctl.run(self.argv(path, "--limit", "10", command="list"))
                self.assertEqual((rc, out.getvalue()), (2, ""))
                self.assertEqual(json.loads(err.getvalue())["code"], "schema_error")
                self.assertEqual(len(client.calls), 1)

    def test_env_registration_completes_handshake_and_observe(self):
        # Mutation: default=os.environ.get("MV_CORE_CONFIG") -> default=None.
        reply = fixture.MvctlV02Tests.reply("observe", status="ok",
                                         observation=fixture.OBSERVATION)
        with self.core([[reply]]) as (path, calls):
            result = self.invoke(path, self.registration(path))
        self.assertEqual((result.returncode, result.stderr), (0, ""))
        self.assertEqual(json.loads(result.stdout), fixture.OBSERVATION)
        self.assertEqual(len(result.stdout.splitlines()), 1)
        self.assertEqual([call["body"]["op"] for call in calls], ["observe"])

    def test_explicit_registration_wins_over_invalid_env(self):
        # Mutation: config = _read_request(args.config, ...) -> read MV_CORE_CONFIG.
        reply = fixture.MvctlV02Tests.reply("observe", status="ok",
                                         observation=fixture.OBSERVATION)
        with self.core([[reply]]) as (path, calls):
            result = self.invoke(path, path.parent / "ENV-CANARY-missing",
                                 "--config", str(self.registration(path)))
        self.assertEqual((result.returncode, result.stderr), (0, ""))
        self.assertEqual(json.loads(result.stdout), fixture.OBSERVATION)
        self.assertEqual(len(calls), 1)

    def test_hello_pin_failure_is_one_stderr_line_and_no_tool_calls(self):
        # Mutation: _client_refusal returns "schema_error" for code == "version".
        self._bad_hello = True
        with self.core([[]]) as (path, calls):
            result = self.invoke(path, self.registration(path))
        self.assertEqual((result.returncode, result.stdout), (2, ""))
        self.assertEqual(len(result.stderr.splitlines()), 1)
        error = json.loads(result.stderr)
        self.assertEqual(error["code"], "version")
        self.assertEqual(error["verdict"], "refuse")
        self.assertNotIn("f" * 40, result.stderr)
        self.assertEqual(calls, [])

    def test_invalid_env_registration_refuses_locally_without_echo(self):
        # Mutation: the config-load handler calls _refuse("schema_error") instead.
        with tempfile.TemporaryDirectory(prefix="tg-config-") as directory:
            root = Path(directory)
            invalid = root / "CONFIG-CANARY.json"
            invalid.write_text("CONFIG-CONTENT-CANARY", encoding="utf-8")
            for path in (invalid, root / "CONFIG-PATH-CANARY", root):
                with self.subTest(path=path.name), patch.dict(
                        os.environ, {"MV_CORE_CONFIG": str(path)}), patch(
                        "metaviewer_agents.client.ToolClient") as transport:
                    out, err = io.StringIO(), io.StringIO()
                    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                        rc = mvctl.run(self.argv(root / "core.sock"))
                    self.assertEqual((rc, out.getvalue()), (2, ""))
                    self.assertEqual(len(err.getvalue().splitlines()), 1)
                    self.assertEqual(json.loads(err.getvalue())["code"], "usage_error")
                    self.assertNotIn("CANARY", err.getvalue())
                    transport.assert_not_called()

    def test_invalid_explicit_config_does_not_fall_back_to_valid_env(self):
        # Mutation: args.config = os.environ.get("MV_CORE_CONFIG") after parse_args.
        with tempfile.TemporaryDirectory(prefix="tg-config-") as directory:
            path = Path(directory) / "core.sock"
            with patch.dict(os.environ, {"MV_CORE_CONFIG": str(self.registration(path))}), \
                    patch("metaviewer_agents.client.ToolClient") as transport:
                out, err = io.StringIO(), io.StringIO()
                with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                    rc = mvctl.run(self.argv(path, "--config", str(path.parent / "BAD-CANARY")))
                self.assertEqual((rc, out.getvalue()), (2, ""))
                self.assertEqual(json.loads(err.getvalue())["code"], "usage_error")
                transport.assert_not_called()


if __name__ == "__main__":
    unittest.main()
