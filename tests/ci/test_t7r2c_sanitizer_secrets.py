"""T7 round-2: log sanitizer secret prefix coverage and parity across workflows."""
import pathlib
import re
import subprocess
import tempfile
import textwrap
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
WF_DIR = ROOT / ".github" / "workflows"


def extract_sanitize_blocks(wf_name: str) -> list[str]:
    text = (WF_DIR / wf_name).read_text(encoding="utf-8")
    pattern = re.compile(r"^([ \t]*)sanitize\(\) \{\n.*?\n\1\}", re.M | re.S)
    return [textwrap.dedent(m.group(0)) for m in pattern.finditer(text)]


def run_sanitize_shell(func_body: str, raw_bytes: bytes) -> bytes:
    with tempfile.TemporaryDirectory(prefix="t7r2c-san-") as tmp:
        raw_p = pathlib.Path(tmp) / "raw.log"
        sane_p = pathlib.Path(tmp) / "sane.log"
        raw_p.write_bytes(raw_bytes)
        res = subprocess.run(
            ["bash", "-c", func_body + '\nsanitize "$1" "$2"', "sanitize", str(raw_p), str(sane_p)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=10,
        )
        if res.returncode != 0:
            raise RuntimeError(f"sanitize failed: {res.stderr}")
        return sane_p.read_bytes()


class TestT7R2CSanitizerSecrets(unittest.TestCase):
    def test_o2_ci_yml_all_blocks_redact_all_token_families_and_encodings(self):
        blocks = extract_sanitize_blocks("ci.yml")
        self.assertEqual(len(blocks), 13)
        families = ("ghp_", "ghs_", "gho_", "ghu_", "ghr_", "github_pat_", "AKIA", "xoxb-", "MV0-SYNTHETIC-SENTINEL-")
        for idx, block in enumerate(blocks):
            for fam in families:
                for variant in (fam, fam.upper(), fam.replace("_", "%5F"), fam.replace("_", "%5f")):
                    secret = (variant + "AbCd1234EfGh5678").encode("utf-8")
                    out = run_sanitize_shell(block, b"prefix " + secret + b" suffix\n")
                    self.assertEqual(
                        out,
                        b"prefix [REDACTED] suffix\n",
                        f"ci.yml block {idx} leaked {variant}",
                    )
            out_priv = run_sanitize_shell(block, b"leak __MV0_PRIVATE_SOURCE_SENTINEL__ here\n")
            self.assertEqual(out_priv, b"leak [REDACTED] here\n")

    def test_o2_package_and_build_other_blocks_redact_all_token_families(self):
        for wf in ("package.yml", "build-other.yml"):
            blocks = extract_sanitize_blocks(wf)
            self.assertEqual(len(blocks), 1, wf)
            for fam in ("ghp_", "ghs_", "gho_", "ghu_", "ghr_", "github_pat_", "AKIA", "xoxb-"):
                secret = (fam + "AbCd1234EfGh5678").encode("utf-8")
                out = run_sanitize_shell(blocks[0], secret)
                self.assertEqual(out, b"[REDACTED]", f"{wf} leaked {fam}")

    def test_o2_benign_logs_remain_byte_identical(self):
        benign = (
            b"PASS unit\n"
            b"ghosts_of_tokens prose\n"
            b"ghs_abc gho_ab ghu_a ghr_\n"
            b"sha256: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n"
        )
        for wf in ("ci.yml", "package.yml", "build-other.yml", "volume.yml"):
            for block in extract_sanitize_blocks(wf):
                self.assertEqual(run_sanitize_shell(block, benign), benign)

    def test_o2_t7r2c_001_volume_yml_redacts_ghs_gho_ghu_ghr_with_negative_control(self):
        """Regression test for T7R2C-001 (R1-014): volume.yml must redact ghs_/gho_/ghu_/ghr_ across all 3 blocks."""
        blocks = extract_sanitize_blocks("volume.yml")
        self.assertEqual(len(blocks), 3)
        for idx, block in enumerate(blocks):
            for fam in ("ghs_", "gho_", "ghu_", "ghr_"):
                for sep in ("_", "%5F", "%5f"):
                    token = (fam[:-1] + sep + "SecretTokenValue1234").encode("utf-8")
                    out = run_sanitize_shell(block, b"Authorization: Bearer " + token + b"\n")
                    self.assertEqual(
                        out,
                        b"Authorization: Bearer [REDACTED]\n",
                        f"volume.yml block {idx} leaked {fam} with separator {sep}",
                    )
        # Negative control: removing ghs_ from the sanitizer pattern leaks ghs_ tokens.
        drifted_block = blocks[0].replace("'gh' + 's_', ", "")
        leaked = run_sanitize_shell(drifted_block, b"Authorization: Bearer ghs_SecretTokenValue1234\n")
        self.assertIn(b"ghs_SecretTokenValue1234", leaked)

    def test_t7r3_005_double_encoded_hex_encoded_and_split_tokens_redacted_across_all_workflows(self):
        """Regression test for T7R3-005: all 18 sanitize() blocks redact double-encoded, hex-encoded, and split tokens."""
        expected_counts = {"ci.yml": 13, "volume.yml": 3, "package.yml": 1, "build-other.yml": 1}
        unique_blocks = set()
        for wf, exp_count in expected_counts.items():
            blocks = extract_sanitize_blocks(wf)
            self.assertEqual(len(blocks), exp_count, wf)
            unique_blocks.update(blocks)
            for idx, block in enumerate(blocks):
                for raw_token in (
                    b"ghs%255FSecretTokenValue1234",
                    b"g%68s_SecretTokenValue1234",
                    b"g%2568s%255FSecretTokenValue1234",
                    b"gh\ns_SecretTokenValue1234",
                    b"github_\npat_SecretTokenValue1234",
                    b"ghs_Secret\\\nTokenValue1234",
                ):
                    payload = b"header: " + raw_token + b"\nplain line 42\n"
                    out = run_sanitize_shell(block, payload)
                    self.assertEqual(
                        out,
                        b"header: [REDACTED]\nplain line 42\n",
                        f"{wf} block {idx} failed to redact {raw_token!r}",
                    )
        self.assertEqual(len(unique_blocks), 1, "All 18 sanitize() blocks across 4 workflows must be identical")


if __name__ == "__main__":
    unittest.main()
