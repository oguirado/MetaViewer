"""Pipe boundary for explicitly requested Wender ModelClient/Muse decisions."""
import json
import os
from pathlib import Path
import sys
import tempfile
import stat


def private_ram_path(value, *, directory=False):
    candidate=Path(value)
    resolved=candidate.resolve(strict=True)
    if (not candidate.is_absolute() or candidate!=resolved or
            not resolved.is_relative_to('/dev/shm/vqa-cu') or
            any(p.is_symlink() for p in (candidate,*candidate.parents))):
        raise ValueError('model path must be canonical RAM without symlink ancestors')
    info=candidate.lstat()
    required=0o700 if directory else 0o600
    kind=stat.S_ISDIR if directory else stat.S_ISREG
    if not kind(info.st_mode) or info.st_uid!=os.getuid() or stat.S_IMODE(info.st_mode)!=required:
        raise ValueError('model path must have private ownership and mode')
    return candidate


def main():
    request = json.load(sys.stdin)
    root=private_ram_path(request['workspace'],directory=True)
    marks=private_ram_path(request['c2']['marks_png'])
    frame=private_ram_path(request['frame_png'])
    private_ram_path(marks.parent,directory=True)
    if root.parent!=marks.parent or frame.parent!=marks.parent:
        raise ValueError('model images and workspace must share the private RAM run')
    os.environ['MV_HOSTED'] = '1'
    os.environ['TMPDIR'] = str(root)
    tempfile.tempdir = str(root)
    # [TARGET, unit decision] Program runner keeps this public helper boundary.
    # Its scrubbed child env carries the verified runtime directory in PYTHONPATH.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'agents'))
    from metaviewer_agents.perception.compiled import compiled_executable
    runtime = compiled_executable('wender-agent', root=os.environ.get('PYTHONPATH'))
    if runtime is not None:
        import subprocess
        result = subprocess.run([str(runtime), 'model'], input=json.dumps(request),
                                text=True, timeout=request['timeout_s'])
        if result.returncode:
            raise SystemExit(result.returncode)
        return
    from wender.learn.model_client import ModelClient, MuseBackend
    backend = MuseBackend(workspace=root, effort='low', timeout=request['timeout_s'])
    client = ModelClient(backend)
    c3 = client.act(goal=request['goal'], frame_path=request['frame_png'],
        describe=request['c2'], capabilities=['click'], marks_png=request['c2']['marks_png'])
    print(json.dumps(dict(c3=c3, model_metadata=client.last_model)))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps(dict(error=dict(type=type(error).__name__, message=str(error)[:1000]))))
        sys.exit(6)
