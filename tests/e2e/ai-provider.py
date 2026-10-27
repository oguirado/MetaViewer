"""[TARGET, unit decision] Deterministic offline proposal provider for U07.

Reads a real observation on stdin; never supplies verdicts or verified claims.
The optional stale flag is a deliberately faulty provider output.
"""
import argparse
import json
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--proposal-id", required=True)
    parser.add_argument("--stale", action="store_true")
    args = parser.parse_args()
    observed = json.load(sys.stdin)
    if observed["schema"] != "observation/v0.2":
        raise ValueError("E2E_PROVIDER: observation required")
    frame = observed["frame_ref"]
    print(json.dumps({"schema": "action_proposal/v0.2", "proposal_id": args.proposal_id,
                      "surface_id": frame["surface_id"],
                      "based_on_frame": {"sha256": frame["sha256"],
                                         "generation": frame["generation"] - int(args.stale)},
                      "action": {"type": "key", "keys": ["Escape"]},
                      "expectation": {"type": "changed_region",
                                      "bbox": {"x": 0, "y": 0, "w": 1, "h": 1}},
                      "budget": {"max_ms": 1000, "max_retries": 0}}))


if __name__ == "__main__":
    main()
