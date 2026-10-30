"""Engine entry for the Use MetaViewer button; host capabilities live in tools."""
import argparse
import importlib.util
from pathlib import Path
import sys


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__, add_help=False, allow_abbrev=False)
    for flag in ('identity', 'site', 'workflow'):
        parser.add_argument('--' + flag, required=True)
    parser.add_argument('--slot', action='append', default=[])
    return parser


def main(argv=None, *, runner=None):
    args = build_parser().parse_args(argv)
    if runner is None:
        path = Path(__file__).resolve().parents[2] / 'tools' / 'mw_run_backend.py'
        spec = importlib.util.spec_from_file_location('mv_mw_run_backend', path)
        host = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(host)
        runner = host.run_entry
    return runner(args)


if __name__ == '__main__':
    sys.exit(main())
