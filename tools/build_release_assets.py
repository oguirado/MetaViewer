#!/usr/bin/env python3
"""Build MetaViewer judge-kit release assets and SHA256SUMS from local artifacts.

Produces the release asset set expected by `scripts/judge/metaviewer-judge.sh`:
  - metaviewer-linux-<arch>.tar.gz
  - node-linux-<arch>.tar.xz
  - opensuperficies-linux-<arch>.tar.gz
  - vision-engine.tar.gz
  - wender-agent.tar.gz
  - images-linux-<arch>.tar
  - SHA256SUMS

Invariants:
  - Standard library only; no network calls.
  - Every generated tar archive normalizes uid/gid (0/0), uname/gname (root/root),
    and mtime (0), and writes only regular files and directories (`-` and `d` in
    `tar -tvf`) so `tar_members_ok` in `metaviewer-judge.sh` accepts them.
  - Fails closed if any asset exceeds GitHub's 2 GB release asset limit
    (2,147,483,648 bytes) or embeds the caller's home directory path in tar
    member names or text metadata.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import lzma
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import subprocess
import sys
import tarfile

GITHUB_ASSET_LIMIT_BYTES = 2 * 1024 * 1024 * 1024  # 2 GiB (GitHub release asset ceiling)
REPO_ROOT = Path(__file__).resolve().parent.parent

ARCH_MAP = {
    "x86_64": "x64",
    "amd64": "x64",
    "x64": "x64",
    "aarch64": "arm64",
    "arm64": "arm64",
}


class AssetBuildError(RuntimeError):
    """Typed failure when building or validating release assets."""


def detect_arch(raw: str | None = None) -> str:
    key = (raw or platform.machine()).strip().lower()
    if key not in ARCH_MAP:
        raise AssetBuildError(f"unsupported architecture: {raw or key!r} (expected x64 or arm64)")
    return ARCH_MAP[key]


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def load_deps_lock(repo_root: Path = REPO_ROOT) -> dict[str, dict[str, str]]:
    lock_path = repo_root / "deps.lock"
    if not lock_path.is_file():
        return {}
    data = json.loads(lock_path.read_text(encoding="utf-8"))
    out: dict[str, dict[str, str]] = {}
    for item in data.get("components", []):
        name = item.get("name")
        if isinstance(name, str):
            out[name] = item
    return out


def _clean_tarinfo(name: str, mode: int, is_dir: bool = False, size: int = 0) -> tarfile.TarInfo:
    info = tarfile.TarInfo(name=name)
    info.type = tarfile.DIRTYPE if is_dir else tarfile.REGTYPE
    info.mode = mode & 0o777
    info.uid = 0
    info.gid = 0
    info.uname = "root"
    info.gname = "root"
    info.mtime = 0
    info.size = 0 if is_dir else size
    return info


def _add_bytes(tf: tarfile.TarFile, name: str, payload: bytes, mode: int = 0o644) -> None:
    info = _clean_tarinfo(name, mode=mode, is_dir=False, size=len(payload))
    tf.addfile(info, io.BytesIO(payload))


def _add_dir(tf: tarfile.TarFile, name: str, mode: int = 0o755) -> None:
    clean = name.rstrip("/") + "/"
    info = _clean_tarinfo(clean, mode=mode, is_dir=True, size=0)
    tf.addfile(info)


def _add_file_from_disk(tf: tarfile.TarFile, arcname: str, src: Path, mode: int | None = None) -> None:
    st = src.lstat()
    if stat.S_ISLNK(st.st_mode):
        raise AssetBuildError(f"symlink refused in release archive: {src} -> {arcname}")
    if not stat.S_ISREG(st.st_mode):
        raise AssetBuildError(f"non-regular file refused in release archive: {src}")
    fmode = (st.st_mode & 0o777) if mode is None else mode
    info = _clean_tarinfo(arcname, mode=fmode, is_dir=False, size=st.st_size)
    with src.open("rb") as f:
        tf.addfile(info, f)


def _open_deterministic_tar_gz(dest: Path):
    """Return a context-managed (raw_file, gzip_file, TarFile) tuple with mtime=0."""
    raw = dest.open("wb")
    gz = gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0)
    tf = tarfile.open(mode="w", fileobj=gz, format=tarfile.GNU_FORMAT)
    return raw, gz, tf


def compute_app_manifest(app_dir: Path) -> bytes:
    """Compute MetaViewer-linux-<arch>.sha256 matching ui/tools/package.js."""
    entries: list[tuple[str, int, Path]] = []
    for root, dirs, files in os.walk(app_dir, followlinks=False):
        dirs.sort()
        files.sort()
        rel_root = Path(root).relative_to(app_dir)
        for d in dirs:
            p = Path(root) / d
            if p.is_symlink():
                raise AssetBuildError(f"symlink directory refused in app bundle: {p}")
        for fname in files:
            p = Path(root) / fname
            st = p.lstat()
            if stat.S_ISLNK(st.st_mode):
                raise AssetBuildError(f"symlink file refused in app bundle: {p}")
            if not stat.S_ISREG(st.st_mode):
                raise AssetBuildError(f"non-regular file refused in app bundle: {p}")
            rel = (rel_root / fname).as_posix() if rel_root != Path(".") else fname
            entries.append((rel, st.st_mode & 0o777, p))
    entries.sort(key=lambda item: item[0])
    lines: list[str] = []
    for rel, mode, p in entries:
        digest = sha256_file(p)
        marker = " *" if mode == 0o755 else "  "
        lines.append(f"{digest}{marker}{rel}\n")
    return "".join(lines).encode("utf-8")


def build_app_asset(app_dir: Path, out_dir: Path, arch: str) -> Path:
    bundle_name = f"MetaViewer-linux-{arch}"
    if app_dir.name != bundle_name and (app_dir / bundle_name).is_dir():
        app_dir = app_dir / bundle_name
    if not app_dir.is_dir():
        raise AssetBuildError(f"packaged app directory not found: {app_dir}")
    exe = app_dir / "metaviewer"
    if not exe.is_file() or not os.access(exe, os.X_OK):
        raise AssetBuildError(f"packaged app directory has no executable metaviewer binary: {exe}")

    sibling_sha = app_dir.parent / f"{bundle_name}.sha256"
    manifest_bytes = sibling_sha.read_bytes() if sibling_sha.is_file() else compute_app_manifest(app_dir)

    out_path = out_dir / f"metaviewer-linux-{arch}.tar.gz"
    raw, gz, tf = _open_deterministic_tar_gz(out_path)
    try:
        _add_dir(tf, bundle_name, 0o755)
        for root, dirs, files in os.walk(app_dir, followlinks=False):
            dirs.sort()
            files.sort()
            rel_root = Path(root).relative_to(app_dir)
            for d in dirs:
                rel_d = (rel_root / d).as_posix() if rel_root != Path(".") else d
                st = (Path(root) / d).lstat()
                if stat.S_ISLNK(st.st_mode):
                    raise AssetBuildError(f"symlink refused in app bundle: {Path(root) / d}")
                _add_dir(tf, f"{bundle_name}/{rel_d}", st.st_mode & 0o777)
            for fname in files:
                src = Path(root) / fname
                rel_f = (rel_root / fname).as_posix() if rel_root != Path(".") else fname
                _add_file_from_disk(tf, f"{bundle_name}/{rel_f}", src)
        _add_bytes(tf, f"{bundle_name}.sha256", manifest_bytes, 0o644)
    finally:
        tf.close()
        gz.close()
        raw.close()
    return out_path


def build_node_asset(
    out_dir: Path,
    arch: str,
    node_tarball: Path | None = None,
    node_bin: Path | None = None,
) -> Path:
    out_path = out_dir / f"node-linux-{arch}.tar.xz"
    if node_tarball is not None:
        if not node_tarball.is_file():
            raise AssetBuildError(f"node tarball not found: {node_tarball}")
        with tarfile.open(node_tarball, mode="r:*") as tf:
            names = tf.getnames()
            if not names:
                raise AssetBuildError(f"node tarball is empty: {node_tarball}")
            for n in names:
                if n.startswith("/") or ".." in Path(n).parts or not re.match(r"^[^/]+/", n if n.endswith("/") else n + "/"):
                    raise AssetBuildError(f"unsafe member name in node tarball: {n}")
            if not any(n.endswith("/bin/node") for n in names):
                raise AssetBuildError(f"node tarball has no */bin/node member: {node_tarball}")
        if node_tarball.resolve() != out_path.resolve():
            shutil.copyfile(node_tarball, out_path)
        return out_path

    if node_bin is None:
        found = shutil.which("node")
        if not found:
            raise AssetBuildError("neither --node-tarball nor --node-bin supplied and node not on PATH")
        node_bin = Path(found)
    if not node_bin.is_file():
        raise AssetBuildError(f"node binary not found: {node_bin}")

    top = f"node-v24-linux-{arch}"
    with lzma.open(out_path, mode="wb", preset=6) as xz:
        with tarfile.open(mode="w", fileobj=xz, format=tarfile.GNU_FORMAT) as tf:
            _add_dir(tf, top, 0o755)
            _add_dir(tf, f"{top}/bin", 0o755)
            _add_file_from_disk(tf, f"{top}/bin/node", node_bin.resolve(), mode=0o755)
    return out_path


def build_opensuperficies_asset(
    srf_bin_dir: Path,
    out_dir: Path,
    arch: str,
    firewall_dir: Path | None = None,
) -> Path:
    if (srf_bin_dir / "bin" / "srf-identity-surface").is_file():
        if firewall_dir is None and (srf_bin_dir / "firewall").is_dir():
            firewall_dir = srf_bin_dir / "firewall"
        srf_bin_dir = srf_bin_dir / "bin"
    if not (srf_bin_dir / "srf-identity-surface").is_file():
        raise AssetBuildError(f"srf-identity-surface not found in {srf_bin_dir}")

    out_path = out_dir / f"opensuperficies-linux-{arch}.tar.gz"
    raw, gz, tf = _open_deterministic_tar_gz(out_path)
    try:
        _add_dir(tf, "opensuperficies", 0o755)
        _add_dir(tf, "opensuperficies/bin", 0o755)
        for item in sorted(srf_bin_dir.iterdir(), key=lambda p: p.name):
            if not item.is_file() or item.is_symlink():
                continue
            if item.name.startswith("srf"):
                _add_file_from_disk(tf, f"opensuperficies/bin/{item.name}", item, mode=0o755)
        if firewall_dir is not None and firewall_dir.is_dir():
            _add_dir(tf, "opensuperficies/firewall", 0o755)
            for fname in ("apply.sh", "srf-open-egress.rules", "srf-open-egress6.rules", "srf-open-egress.service"):
                fpath = firewall_dir / fname
                if not fpath.is_file():
                    raise AssetBuildError(f"missing firewall file: {fpath}")
                fmode = 0o755 if fname.endswith(".sh") else 0o644
                _add_file_from_disk(tf, f"opensuperficies/firewall/{fname}", fpath, mode=fmode)
    finally:
        tf.close()
        gz.close()
        raw.close()
    return out_path


def build_git_component_asset(
    comp_name: str,
    source_dir: Path,
    out_dir: Path,
    expected_commit: str | None = None,
) -> Path:
    if not source_dir.is_dir():
        raise AssetBuildError(f"{comp_name} directory not found: {source_dir}")
    out_path = out_dir / f"{comp_name}.tar.gz"

    commit = expected_commit
    if (source_dir / ".git").exists() and shutil.which("git"):
        head = subprocess.run(
            ["git", "-C", str(source_dir), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        if expected_commit and head != expected_commit:
            raise AssetBuildError(f"{comp_name} HEAD {head} does not match pinned commit {expected_commit}")
        commit = head
        proc = subprocess.run(
            ["git", "-C", str(source_dir), "archive", "--format=tar", commit],
            check=True,
            capture_output=True,
        )
        raw, gz, tf = _open_deterministic_tar_gz(out_path)
        try:
            _add_dir(tf, comp_name, 0o755)
            with tarfile.open(fileobj=io.BytesIO(proc.stdout), mode="r:") as src_tf:
                for member in sorted(src_tf.getmembers(), key=lambda m: m.name):
                    if member.name in ("", ".", "pax_global_header") or member.type in (tarfile.XGLTYPE, tarfile.XHDTYPE):
                        continue
                    rel = member.name.lstrip("./")
                    if not rel:
                        continue
                    arcname = f"{comp_name}/{rel.rstrip('/')}"
                    if member.isdir():
                        _add_dir(tf, arcname, 0o755)
                    elif member.isfile():
                        extracted = src_tf.extractfile(member)
                        payload = extracted.read() if extracted is not None else b""
                        fmode = 0o755 if (member.mode & 0o111) else 0o644
                        _add_bytes(tf, arcname, payload, fmode)
                    else:
                        raise AssetBuildError(f"unsupported git archive entry type in {comp_name}: {member.name}")
            if commit:
                _add_dir(tf, f"{comp_name}/.git", 0o755)
                _add_bytes(tf, f"{comp_name}/.git/HEAD", f"{commit}\n".encode("ascii"), 0o644)
        finally:
            tf.close()
            gz.close()
            raw.close()
        return out_path

    # Fallback when source_dir is an unpacked directory without .git metadata.
    raw, gz, tf = _open_deterministic_tar_gz(out_path)
    try:
        _add_dir(tf, comp_name, 0o755)
        for root, dirs, files in os.walk(source_dir, followlinks=False):
            dirs[:] = sorted(d for d in dirs if d not in (".git", "__pycache__", ".pytest_cache"))
            files.sort()
            rel_root = Path(root).relative_to(source_dir)
            for d in dirs:
                rel_d = (rel_root / d).as_posix() if rel_root != Path(".") else d
                _add_dir(tf, f"{comp_name}/{rel_d}", 0o755)
            for fname in files:
                if fname.endswith((".pyc", ".pyo")):
                    continue
                src = Path(root) / fname
                rel_f = (rel_root / fname).as_posix() if rel_root != Path(".") else fname
                _add_file_from_disk(tf, f"{comp_name}/{rel_f}", src)
        if commit:
            _add_dir(tf, f"{comp_name}/.git", 0o755)
            _add_bytes(tf, f"{comp_name}/.git/HEAD", f"{commit}\n".encode("ascii"), 0o644)
    finally:
        tf.close()
        gz.close()
        raw.close()
    return out_path


def build_compiled_component_asset(comp_name: str, source_dir: Path,
                                   out_dir: Path, arch: str) -> Path:
    """[TARGET, unit decision] Export only the pinned, source-free distribution.

    Pins live in the public runtime; export metadata cannot authorize new bytes.
    Never synthesize Git metadata for compiled executables.
    """
    if arch != 'x64':
        raise AssetBuildError('compiled private sidecars are available only for linux-x64')
    pins = json.loads((REPO_ROOT / 'agents/metaviewer_agents/perception/compiled.lock.json').read_text())['components'][comp_name]
    if load_deps_lock().get(comp_name, {}).get('commit') != pins['commit']:
        raise AssetBuildError(f'{comp_name}: compiled source commit differs from deps.lock')
    archive = source_dir / f'{comp_name}-linux-{arch}.tar.gz'
    if not archive.is_file() or sha256_file(archive) != pins['archive_sha256']:
        raise AssetBuildError(f'{comp_name}: compiled archive missing or hash mismatch')
    seen = set()
    with tarfile.open(archive, 'r:gz') as tf:
        for member in tf:
            path = Path(member.name)
            if path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0] != comp_name:
                raise AssetBuildError(f'{comp_name}: unsafe compiled member {member.name}')
            if member.isdir():
                continue
            relative = path.relative_to(comp_name).as_posix()
            if (not member.isfile() or relative not in pins['files'] or relative in seen or
                    path.suffix.lower() in ('.py', '.pyc', '.pyo', '.pyi')):
                raise AssetBuildError(f'{comp_name}: unpinned compiled member {member.name}')
            stream = tf.extractfile(member)
            if stream is None or hashlib.file_digest(stream, 'sha256').hexdigest() != pins['files'][relative]:
                raise AssetBuildError(f'{comp_name}: compiled member hash mismatch: {relative}')
            seen.add(relative)
    if seen != set(pins['files']):
        raise AssetBuildError(f'{comp_name}: missing compiled files')
    dest = out_dir / f'{comp_name}.tar.gz'
    if archive.resolve() != dest.resolve():
        shutil.copyfile(archive, dest)
    return dest


def default_image_tags(arch: str, include_open_020: bool = False) -> list[str]:
    tags = [
        f"opensuperficies-identity-browser-{arch}:0.1.1",
        f"opensuperficies-program-host-{arch}:0.1.0",
        f"opensuperficies-desktop-{arch}:1.1.0",
    ]
    if include_open_020:
        tags.append(f"opensuperficies-identity-browser-{arch}:0.2.0")
    return tags


def build_images_asset(
    out_dir: Path,
    arch: str,
    images_tar: Path | None = None,
    image_tags: list[str] | None = None,
) -> Path:
    out_path = out_dir / f"images-linux-{arch}.tar"
    if images_tar is not None:
        if not images_tar.is_file():
            raise AssetBuildError(f"images tar not found: {images_tar}")
        if images_tar.resolve() != out_path.resolve():
            shutil.copyfile(images_tar, out_path)
        return out_path

    tags = image_tags or default_image_tags(arch)
    docker_bin = shutil.which("docker")
    if not docker_bin:
        raise AssetBuildError("docker not found on PATH and --images-tar was not provided")
    for tag in tags:
        res = subprocess.run([docker_bin, "image", "inspect", tag], capture_output=True, text=True)
        if res.returncode != 0:
            raise AssetBuildError(f"required Docker image is not present locally: {tag}")
    res = subprocess.run([docker_bin, "save", "-o", str(out_path), *tags], capture_output=True, text=True)
    if res.returncode != 0:
        raise AssetBuildError(f"docker save failed: {res.stderr.strip()}")
    return out_path


def verify_tar_asset_hygiene(asset_path: Path, expected_regex: str | None, forbidden_substrings: list[str]) -> None:
    """Verify tar member names, entry types, and absence of host path leaks."""
    with tarfile.open(asset_path, mode="r:*") as tf:
        members = tf.getmembers()
        if not members:
            raise AssetBuildError(f"archive has no members: {asset_path.name}")
        rx = re.compile(expected_regex) if expected_regex else None
        for m in members:
            name = m.name.rstrip("/") if not m.isdir() else m.name.rstrip("/") + "/"
            if m.name.startswith("/") or ".." in Path(m.name).parts:
                raise AssetBuildError(f"unsafe path in {asset_path.name}: {m.name}")
            for bad in forbidden_substrings:
                if bad and bad in m.name:
                    raise AssetBuildError(f"host path leaked in member name of {asset_path.name}: {m.name}")
            if rx is not None:
                check_name = m.name.rstrip("/")
                if not rx.match(check_name) and not rx.match(m.name):
                    raise AssetBuildError(f"unexpected member {m.name!r} in {asset_path.name} (expected {expected_regex})")
                if not (m.isfile() or m.isdir()):
                    raise AssetBuildError(f"non-regular/non-dir member {m.name!r} in {asset_path.name} (type={m.type!r})")


def write_sha256sums(out_dir: Path, asset_paths: list[Path]) -> Path:
    lines: list[str] = []
    for p in sorted(asset_paths, key=lambda item: item.name):
        if not p.is_file():
            raise AssetBuildError(f"missing built asset: {p}")
        size = p.stat().st_size
        if size <= 0:
            raise AssetBuildError(f"empty built asset: {p.name}")
        if size > GITHUB_ASSET_LIMIT_BYTES:
            raise AssetBuildError(
                f"{p.name} is {size} bytes, exceeding GitHub's 2 GiB release asset limit ({GITHUB_ASSET_LIMIT_BYTES})"
            )
        lines.append(f"{sha256_file(p)}  {p.name}\n")
    sums_path = out_dir / "SHA256SUMS"
    sums_path.write_text("".join(lines), encoding="utf-8")
    return sums_path


def build_all_assets(
    *,
    out_dir: Path,
    arch: str,
    app_dir: Path,
    node_tarball: Path | None = None,
    node_bin: Path | None = None,
    srf_dir: Path,
    firewall_dir: Path | None = None,
    vision_engine_dir: Path | None = None,
    wender_agent_dir: Path | None = None,
    compiled_sidecars_dir: Path | None = None,
    images_tar: Path | None = None,
    image_tags: list[str] | None = None,
    repo_root: Path = REPO_ROOT,
) -> dict[str, object]:
    arch = detect_arch(arch)
    out_dir.mkdir(parents=True, exist_ok=True)
    locks = load_deps_lock(repo_root)
    ve_commit = locks.get("vision-engine", {}).get("commit")
    wa_commit = locks.get("wender-agent", {}).get("commit")

    built: list[Path] = []
    app_asset = build_app_asset(app_dir, out_dir, arch)
    built.append(app_asset)

    node_asset = build_node_asset(out_dir, arch, node_tarball=node_tarball, node_bin=node_bin)
    built.append(node_asset)

    srf_asset = build_opensuperficies_asset(srf_dir, out_dir, arch, firewall_dir=firewall_dir)
    built.append(srf_asset)

    if compiled_sidecars_dir is None and (vision_engine_dir is None or wender_agent_dir is None):
        raise AssetBuildError('supply --compiled-sidecars-dir or both component checkout directories')
    ve_asset = (build_compiled_component_asset('vision-engine', compiled_sidecars_dir, out_dir, arch)
                if compiled_sidecars_dir is not None else
                build_git_component_asset("vision-engine", vision_engine_dir, out_dir, expected_commit=ve_commit))
    built.append(ve_asset)

    wa_asset = (build_compiled_component_asset('wender-agent', compiled_sidecars_dir, out_dir, arch)
                if compiled_sidecars_dir is not None else
                build_git_component_asset("wender-agent", wender_agent_dir, out_dir, expected_commit=wa_commit))
    built.append(wa_asset)

    img_asset = build_images_asset(out_dir, arch, images_tar=images_tar, image_tags=image_tags)
    built.append(img_asset)

    home_str = str(Path.home())
    forbidden = [home_str] if home_str and home_str != "/" else []
    verify_tar_asset_hygiene(
        app_asset,
        rf"^(MetaViewer-linux-{arch}(/.*)?|MetaViewer-linux-{arch}\.sha256)$",
        forbidden,
    )
    verify_tar_asset_hygiene(node_asset, None, forbidden)
    verify_tar_asset_hygiene(srf_asset, r"^opensuperficies(/.*)?$", forbidden)
    verify_tar_asset_hygiene(ve_asset, r"^vision-engine(/.*)?$", forbidden)
    verify_tar_asset_hygiene(wa_asset, r"^wender-agent(/.*)?$", forbidden)

    sums_path = write_sha256sums(out_dir, built)
    report_assets = []
    for p in sorted(built, key=lambda item: item.name):
        size = p.stat().st_size
        report_assets.append(
            {
                "name": p.name,
                "size_bytes": size,
                "size_mib": round(size / (1024 * 1024), 2),
                "sha256": sha256_file(p),
                "within_github_2gib_limit": size <= GITHUB_ASSET_LIMIT_BYTES,
            }
        )
    return {
        "schema": "metaviewer.release_assets/v1",
        "arch": arch,
        "github_asset_limit_bytes": GITHUB_ASSET_LIMIT_BYTES,
        "sha256sums": str(sums_path.name),
        "sha256sums_digest": sha256_file(sums_path),
        "assets": report_assets,
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        description="Build MetaViewer judge-kit release assets and SHA256SUMS from local artifacts."
    )
    ap.add_argument("--out-dir", required=True, type=Path, help="Output directory for release assets and SHA256SUMS")
    ap.add_argument("--arch", default=os.environ.get("MV_RELEASE_ARCH"), help="Target architecture: x64 or arm64")
    ap.add_argument('--compiled-sidecars-dir', type=Path,
                    help='Directory containing pinned source-free linux-x64 component archives')
    ap.add_argument(
        "--app-dir",
        type=Path,
        default=os.environ.get("MV_RELEASE_APP_DIR"),
        help="Path to packaged MetaViewer-linux-<arch> directory",
    )
    ap.add_argument(
        "--node-tarball",
        type=Path,
        default=os.environ.get("MV_RELEASE_NODE_TARBALL"),
        help="Existing node-v24*-linux-<arch>.tar.xz archive",
    )
    ap.add_argument(
        "--node-bin",
        type=Path,
        default=os.environ.get("MV_RELEASE_NODE_BIN"),
        help="Fallback Node 24 executable if --node-tarball is not supplied",
    )
    ap.add_argument(
        "--opensuperficies-dir",
        type=Path,
        default=os.environ.get("MV_RELEASE_SRF_DIR"),
        help="Directory holding OpenSuperficies srf* binaries",
    )
    ap.add_argument(
        "--firewall-dir",
        type=Path,
        default=os.environ.get("MV_RELEASE_FIREWALL_DIR"),
        help="Optional directory holding OpenSuperficies deploy/firewall files",
    )
    ap.add_argument(
        "--vision-engine-dir",
        type=Path,
        default=os.environ.get("MV_RELEASE_VE_DIR"),
        help="Local checkout of vision-engine at the deps.lock commit",
    )
    ap.add_argument(
        "--wender-agent-dir",
        type=Path,
        default=os.environ.get("MV_RELEASE_WA_DIR"),
        help="Local checkout of wender-agent at the deps.lock commit",
    )
    ap.add_argument(
        "--images-tar",
        type=Path,
        default=os.environ.get("MV_RELEASE_IMAGES_TAR"),
        help="Pre-saved Docker image archive (otherwise runs docker save)",
    )
    return ap.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    try:
        args = parse_args(argv)
        missing = [
            flag
            for flag, val in (
                ("--app-dir", args.app_dir),
                ("--opensuperficies-dir", args.opensuperficies_dir),
            )
            if val is None
        ]
        if missing:
            raise AssetBuildError(f"missing required source paths: {', '.join(missing)}")
        summary = build_all_assets(
            out_dir=args.out_dir,
            arch=args.arch,
            app_dir=args.app_dir,
            node_tarball=args.node_tarball,
            node_bin=args.node_bin,
            srf_dir=args.opensuperficies_dir,
            firewall_dir=args.firewall_dir,
            vision_engine_dir=args.vision_engine_dir,
            wender_agent_dir=args.wender_agent_dir,
            compiled_sidecars_dir=args.compiled_sidecars_dir,
            images_tar=args.images_tar,
        )
        print(json.dumps(summary, indent=2, sort_keys=True))
        return 0
    except AssetBuildError as exc:
        print(f"RELEASE_ASSET_ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
