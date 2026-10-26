"""CI revision selection; fail closed when a required ref cannot be resolved."""
import os
import subprocess
import sys

ZERO = "0" * 40


def select_range(event, before, head, pr_base, pr_head):
    if event == "pull_request":
        base, tip = pr_base, pr_head
    elif event == "push":
        tip = head
        base = before
        if not base or base == ZERO:
            base = subprocess.check_output(
                ["git", "merge-base", "origin/main", tip], text=True).strip()
    else:
        return None
    if not base or not tip or base == ZERO or tip == ZERO:
        raise ValueError("missing revision for laws range")
    return base + ".." + tip


if __name__ == "__main__":
    try:
        e = os.environ
        revision = select_range(*(e.get(k, "") for k in
                                  ("EVENT_NAME", "BEFORE", "HEAD", "PR_BASE", "PR_HEAD")))
        print(revision or "")
    except (ValueError, subprocess.CalledProcessError) as exc:
        print("laws range: " + str(exc), file=sys.stderr)
        sys.exit(1)
