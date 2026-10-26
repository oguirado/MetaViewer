#!/usr/bin/env python3
"""Deterministic stand-in for capsule CLIs (identity/holdings/srf).

Mirrors the stdout/exit contract of the real CLIs so adapter tests run
without containers: one compact JSON object per line on stdout, semantic
failures as {"error": {"code": N, "detail": ...}} on stdout, exits from
0/2/3/4/5/6/7 and never 1. The srf family keeps refused `estado --json`
on stderr with empty stdout. Seams: --fault N (any family), --refuse N
and --unreachable (srf only).
"""

import argparse
import hashlib
import json
import os
import re
import sys
import time

IDENTITY_CAPSULE_RE = re.compile(r"^srf-(id|pg|vm)-[a-z0-9][a-z0-9-]{0,39}$")
IDENTITY_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,47}$")
KEYSYM_RE = re.compile(r"^[A-Za-z0-9_+]{1,32}$")
TYPE_STDIN_CAP = 16384
FRAME_SEQ_CAP = 999999


def emit(payload):
    sys.stdout.write(json.dumps(payload, separators=(",", ":"), sort_keys=True) + "\n")


def refuse(code, detail, typed=False):
    payload = {"error": {"code": code, "detail": detail}}
    if typed:
        payload["result"] = None
    emit(payload)
    return code


def digest(*parts):
    blob = "\n".join(str(part) for part in parts).encode()
    return hashlib.sha256(blob).hexdigest()


def parse_timeout(raw, parser):
    match = re.fullmatch(r"(\d+)(s|m)?", raw or "")
    if not match:
        parser.error("timeout must match <n>[s|m]")
    seconds = int(match.group(1)) * (60 if match.group(2) == "m" else 1)
    if seconds <= 0 or seconds > 180:
        parser.error("timeout must be within (0,3m]")
    return seconds


def add_shared(parser):
    parser.add_argument("--timeout", default="30s")
    parser.add_argument("--store-root", default=None)
    parser.add_argument("--registry", default=None)
    parser.add_argument("--proxy", default=None)
    parser.add_argument("--state-dir", default=None)


def check_timeout(args, parser):
    parse_timeout(args.timeout, parser)


def check_stores(args):
    if not args.store_root or not args.registry:
        return refuse(3, "store root or registry unavailable")
    return None


def check_fault(args):
    if args.fault is None:
        return None
    try:
        code = int(args.fault)
    except (TypeError, ValueError):
        sys.stderr.write("fake-capsule: --fault accepts 2..7 only\n")
        return 2
    if code not in (2, 3, 4, 5, 6, 7):
        sys.stderr.write("fake-capsule: --fault accepts 2..7 only\n")
        return 2
    if args.family == "srf":
        emit({"error": "injected fault", "ok": False, "rc": code})
    else:
        emit({"error": {"code": code, "detail": "injected fault"}})
    return code


# --- identity family ------------------------------------------------------


def identity_start(args, parser):
    check_timeout(args, parser)
    hit = check_stores(args)
    if hit is not None:
        return hit
    if not args.identity or not IDENTITY_NAME_RE.fullmatch(args.identity):
        parser.error("--identity must match ^[a-z0-9][a-z0-9-]{1,47}$")
    if args.windows < 1 or args.windows > 16:
        parser.error("--windows must be within 1..16")
    if args.kind not in ("browser", "program", "vm"):
        parser.error("--kind must be browser, program or vm")
    if args.kind in ("program", "vm") and not args.program:
        parser.error("--program is required for program/vm kinds")
    if args.program and args.program not in ("notepad", "notepad-vm"):
        return refuse(4, "program unavailable", typed=True)
    container = args.capsule
    if not container:
        slug = re.sub(r"[^a-z0-9-]", "-", args.identity.lower())[:39]
        container = "srf-id-" + (slug if slug else "fake")
    if not IDENTITY_CAPSULE_RE.fullmatch(container):
        parser.error("--capsule must match ^srf-(id|pg|vm)-[a-z0-9][a-z0-9-]{0,39}$")
    run_id = "run-" + digest(args.identity, container, args.kind)[:12]
    windows = [{"h": 900, "id": "w%d" % (i + 1), "title": "fake",
                "url": "about:blank", "w": 1280, "x": 0, "y": 0}
               for i in range(args.windows)]
    emit({"container": container, "kind": args.kind, "run_id": run_id,
          "windows": windows})
    return 0


def identity_frame(args, parser):
    check_timeout(args, parser)
    hit = check_stores(args)
    if hit is not None:
        return hit
    if not args.container:
        parser.error("--container is required")
    if not args.window:
        parser.error("--window is required")
    if args.seq < 1:
        parser.error("--seq must be >= 1")
    if args.seq > FRAME_SEQ_CAP:
        return refuse(4, "frame sequence exhausted", typed=True)
    emit({"capture_mono_ns": time.monotonic_ns(),
          "generation": 1,
          "height": 900,
          "path": "/dev/shm/fake/%s/%s/f%06d.png"
                  % (args.container, args.window, args.seq),
          "seq": args.seq,
          "sha256_rgb24": digest(args.container, args.window, args.seq),
          "width": 1280,
          "window": args.window})
    return 0


def identity_ax(args, parser):
    check_timeout(args, parser)
    hit = check_stores(args)
    if hit is not None:
        return hit
    if not args.container:
        parser.error("--container is required")
    if not args.window:
        parser.error("--window is required")
    if args.kind == "program":
        return refuse(4, "program ax unavailable", typed=True)
    emit({"elements": [{"actionable": True, "box": [10, 10, 80, 30],
                        "container": args.window, "focused": False,
                        "id": "e1", "name": "OK", "region": "main",
                        "role": "button", "states": [], "value_len": 0}],
          "frame_seq": 1,
          "scroll": {"x": 0, "y": 0},
          "skipped_frames": 0,
          "truncated": False,
          "window": args.window})
    return 0


def identity_input(args, parser):
    check_timeout(args, parser)
    hit = check_stores(args)
    if hit is not None:
        return hit
    if not args.container:
        parser.error("--container is required")
    if not args.window:
        parser.error("--window is required")
    picked = [name for name, flag in
              (("key", args.key), ("type", args.type),
               ("type-stdin", args.type_stdin), ("click", args.click),
               ("scroll", args.scroll), ("drag", args.drag))
              if flag]
    if len(picked) != 1:
        parser.error("input needs exactly one action flag")
    if args.paste and picked[0] not in ("type", "type-stdin"):
        parser.error("--paste needs --type or --type-stdin")
    kind = {"key": "key", "type": "text", "type-stdin": "text",
            "click": "click", "scroll": "scroll", "drag": "drag"}[picked[0]]
    if args.key is not None and not args.key:
        parser.error("--key must be nonempty")
    if args.type is not None and not args.type:
        parser.error("--type must be nonempty")
    if args.type_stdin:
        raw = sys.stdin.buffer.read()
        if raw.endswith(b"\n"):
            raw = raw[:-1]
        if len(raw) > TYPE_STDIN_CAP:
            return refuse(5, "stdin text over cap", typed=True)
    if args.click and not re.fullmatch(r"-?\d+,-?\d+", args.click):
        parser.error("--click must be X,Y")
    if args.scroll:
        if not re.fullmatch(r"-?\d+,-?\d+", args.scroll):
            parser.error("--scroll must be X,Y")
        if not args.dir:
            parser.error("--scroll needs --dir")
        if args.count < 1 or args.count > 20:
            parser.error("--count must be within 1..20")
    if args.drag and not re.fullmatch(r"-?\d+,-?\d+:-?\d+,-?\d+", args.drag):
        parser.error("--drag must be X1,Y1:X2,Y2")
    if args.expect_focus != args.have_focus:
        return refuse(6, "focus mismatch", typed=True)
    emit({"focus_verified": True,
          "input_mono_ns": time.monotonic_ns(),
          "kind": kind,
          "result": {"applied": True},
          "surface_id": "%s/%s" % (args.container, args.window)})
    return 0


def identity_stop(args, parser):
    check_timeout(args, parser)
    hit = check_stores(args)
    if hit is not None:
        return hit
    if not args.container:
        parser.error("--container is required")
    emit({"removed_verified": True, "stopped": args.container})
    return 0


def identity_capabilities(args, parser):
    check_timeout(args, parser)
    sys.stdout.write("srf-identity-surface capabilities v1\n")
    sys.stdout.write("--paste --type-stdin --scroll --drag downloads\n")
    return 0


# --- holdings family ------------------------------------------------------

def holdings_start(args, parser):
    if args.slots < 1 or args.slots > 4:
        parser.error("--slots must be within 1..4")
    if not args.app:
        parser.error("--app is required")
    if args.ui not in ("", "lit", "v2"):
        parser.error("--ui must be lit, v2 or empty")
    if not os.path.isdir(args.app):
        return refuse(4, "app folder unavailable")
    capsules = []
    for slot in range(1, args.slots + 1):
        run_id = "hc-" + digest(args.seed, args.scenario, slot)[:12]
        capsules.append({
            "container": "srf-ng-hcap-%s-%d" % (run_id, slot),
            "display": ":100",
            "frames_dir": "/dev/shm/vqa-ramws/fake/%s/frames/%d"
                          % (run_id, slot),
            "height": 900,
            "lane_socket": "/workspace/holdings/agent.sock",
            "ready_line": "HOLDINGS_READY %d 0" % args.seed,
            "ready_ms": 600 + slot,
            "run_id": run_id,
            "slot": slot,
            "width": 1280})
    emit(capsules)
    return 0


def holdings_frame(args, parser):
    if not args.container:
        parser.error("--container is required")
    if not args.state:
        parser.error("--state is required")
    emit({"capture_mono_ns": time.monotonic_ns(),
          "generation": args.container,
          "height": 900,
          "path": "/dev/shm/vqa-ramws/fake/%s/f000001.png" % args.container,
          "seq": 1,
          "sha256_rgb24": digest(args.container, args.state),
          "state": args.state,
          "width": 1280})
    return 0


def holdings_observe(args, parser):
    if not args.container:
        parser.error("--container is required")
    emit({"elements": [],
          "frame_state_sha256": digest(args.container, "frame"),
          "revision": 1,
          "state_sha256": digest(args.container, "state"),
          "tick": 1})
    return 0


def holdings_input(args, parser):
    if args.type or args.type_stdin or args.paste or args.scroll or args.drag:
        parser.error("holdings input accepts only --key or --click")
    if bool(args.key) == bool(args.click):
        parser.error("input needs exactly one of --key or --click")
    if args.button < 1 or args.button > 3:
        parser.error("--button must be within 1..3")
    if args.key and not KEYSYM_RE.fullmatch(args.key):
        parser.error("--key must match ^[A-Za-z0-9_+]{1,32}$")
    if args.click:
        match = re.fullmatch(r"(\d+),(\d+)", args.click)
        if not match:
            parser.error("--click must be X,Y")
        if int(match.group(1)) >= 1280 or int(match.group(2)) >= 900:
            parser.error("--click is outside 1280x900")
    emit({"input_mono_ns": time.monotonic_ns()})
    return 0


def holdings_stop(args, parser):
    if not args.container:
        parser.error("--container is required")
    emit({"stopped": args.container})
    return 0


# --- srf family -----------------------------------------------------------

SRF_EXITS = (1, 2, 3, 9, 69)


def srf_surface_info(slot, clase):
    return {"clase": clase, "contenedor": "srf-%s-%d" % (clase, slot),
            "estado": "listo", "id": "id-%d" % slot, "slot": slot}


def srf_check_common(args, parser):
    if args.unreachable:
        sys.stderr.write("srf: dial %s: no daemon\n" % args.socket)
        return 1
    if args.slot is not None and args.slot < 0:
        parser.error("--slot must be >= 0")
    if args.clase not in ("browser", "desktop", "microvm"):
        parser.error("--clase must be browser, desktop or microvm")
    if args.refuse is not None:
        if args.refuse not in SRF_EXITS[1:]:
            parser.error("--refuse must be one of 2, 3, 9, 69")
        return "refused"
    return None


def srf_estado(args, parser):
    hit = srf_check_common(args, parser)
    if hit == "refused":
        # Refused estado --json stays on stderr with empty stdout.
        sys.stderr.write("srf: estado: refused\n")
        return args.refuse
    if hit is not None:
        return hit
    datos = {"disponible_mib": 1024, "estado": "running", "parada": False,
             "reservado_mib": 64, "soberana_mib": 128, "vivas": 1}
    if args.json:
        emit(datos)
    else:
        sys.stdout.write("srfd: running (parada: False, vivas: 1, "
                         "disp: 1024 MiB)\n")
    return 0


def srf_fail_json(args, context):
    if args.json:
        emit({"error": "refused", "ok": False, "rc": args.refuse})
    else:
        sys.stderr.write("srf: %s: refused\n" % context)
    return args.refuse


def srf_iniciar(args, parser):
    hit = srf_check_common(args, parser)
    if hit == "refused":
        return srf_fail_json(args, "capsula iniciar")
    if hit is not None:
        return hit
    if args.json:
        emit(srf_surface_info(args.slot, args.clase))
    else:
        sys.stdout.write("slot %d (%s) started\n" % (args.slot, args.clase))
    return 0


def srf_detener(args, parser):
    hit = srf_check_common(args, parser)
    if hit == "refused":
        return srf_fail_json(args, "capsula detener")
    if hit is not None:
        return hit
    if args.json:
        emit({"estado": "detenido", "ok": True, "rc": 0, "slot": args.slot})
    else:
        sys.stdout.write("slot %d stopped\n" % args.slot)
    return 0


def srf_listar(args, parser):
    hit = srf_check_common(args, parser)
    if hit == "refused":
        return srf_fail_json(args, "listar")
    if hit is not None:
        return hit
    emit([srf_surface_info(1, "browser")])
    return 0


# --- argument wiring ------------------------------------------------------

def add_srf_common(parser):
    parser.add_argument("--socket", default="fake.sock")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--refuse", type=int, default=None)
    parser.add_argument("--unreachable", action="store_true")
    parser.add_argument("--slot", type=int, default=1)
    parser.add_argument("--clase", default="browser")


def build_parser():
    parser = argparse.ArgumentParser(prog="fake-capsule")
    parser.add_argument("--family", default="identity",
                        choices=("identity", "holdings", "srf"))
    parser.add_argument("--fault", default=None,
                        help="test seam: emit a fault envelope and exit N")
    sub = parser.add_subparsers(dest="verb", required=True)
    caps = sub.add_parser("capabilities")
    add_shared(caps)
    caps.set_defaults(func=identity_capabilities)
    start = sub.add_parser("start")
    add_shared(start)
    start.add_argument("--identity", default=None)
    start.add_argument("--windows", type=int, default=1)
    start.add_argument("--capsule", default=None)
    start.add_argument("--kind", default="browser")
    start.add_argument("--program", default=None)
    start.add_argument("--slots", type=int, default=1)
    start.add_argument("--app", default=None)
    start.add_argument("--scenario", default="h3-core-journey")
    start.add_argument("--seed", type=int, default=4242)
    start.add_argument("--ui", default="")
    start.set_defaults(func=None)
    frame = sub.add_parser("frame")
    add_shared(frame)
    frame.add_argument("--container", default=None)
    frame.add_argument("--window", default=None)
    frame.add_argument("--state", default=None)
    frame.add_argument("--seq", type=int, default=1)
    frame.set_defaults(func=None)
    ax = sub.add_parser("ax")
    add_shared(ax)
    ax.add_argument("--container", default=None)
    ax.add_argument("--window", default=None)
    ax.add_argument("--text-container", default=None)
    ax.add_argument("--kind", default="browser")
    ax.set_defaults(func=identity_ax)
    inp = sub.add_parser("input")
    add_shared(inp)
    inp.add_argument("--container", default=None)
    inp.add_argument("--window", default=None)
    inp.add_argument("--key", default=None)
    inp.add_argument("--type", default=None)
    inp.add_argument("--type-stdin", action="store_true")
    inp.add_argument("--paste", action="store_true")
    inp.add_argument("--click", default=None)
    inp.add_argument("--button", type=int, default=1)
    inp.add_argument("--scroll", default=None)
    inp.add_argument("--dir", default=None)
    inp.add_argument("--count", type=int, default=1)
    inp.add_argument("--modifier", default=None)
    inp.add_argument("--drag", default=None)
    inp.add_argument("--expect-focus", default="w1")
    inp.add_argument("--have-focus", default="w1")
    inp.set_defaults(func=None)
    stop = sub.add_parser("stop")
    add_shared(stop)
    stop.add_argument("--container", default=None)
    stop.set_defaults(func=None)
    observe = sub.add_parser("observe")
    observe.add_argument("--container", default=None)
    observe.set_defaults(func=holdings_observe)
    estado = sub.add_parser("estado")
    add_srf_common(estado)
    estado.set_defaults(func=srf_estado)
    capsula = sub.add_parser("capsula")
    add_srf_common(capsula)
    capsula.add_argument("action", choices=("iniciar", "detener"))
    capsula.set_defaults(func=None)
    listar = sub.add_parser("listar")
    add_srf_common(listar)
    listar.set_defaults(func=srf_listar)
    return parser


def dispatch(args, parser):
    if args.family == "identity":
        table = {"capabilities": identity_capabilities, "start": identity_start,
                 "frame": identity_frame, "ax": identity_ax,
                 "input": identity_input, "stop": identity_stop}
    elif args.family == "holdings":
        table = {"start": holdings_start, "frame": holdings_frame,
                 "observe": holdings_observe, "input": holdings_input,
                 "stop": holdings_stop}
    else:
        if args.verb == "capsula":
            return srf_iniciar(args, parser) if args.action == "iniciar" \
                else srf_detener(args, parser)
        table = {"estado": srf_estado, "listar": srf_listar}
    func = table.get(args.verb)
    if func is None:
        parser.error("verb %s is not in family %s" % (args.verb, args.family))
    return func(args, parser)


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    hit = check_fault(args)
    if hit is not None:
        return hit
    return dispatch(args, parser)


if __name__ == "__main__":
    sys.exit(main())
