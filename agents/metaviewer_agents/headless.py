"""One fixed guest job over the authenticated core mailbox; never a shell.

The client consumes intermediate accepted events. A timeout or unknown outcome
consumes the attempt; this module never reconnects or repeats guest commands.
"""
from __future__ import annotations

import copy
import hashlib
import secrets


class HeadlessError(RuntimeError):
    pass


class HeadlessSession:
    def __init__(self, client):
        self.client = client
        self.session = None
        self.create_attempted = False
        self.job_attempted = False
        self.closed = False
        self.uncertain = False

    def _request(self, op, params, timeout_ms):
        body = {"schema": "headless_request/v0.2",
                "request_id": "request-" + secrets.token_hex(16),
                "op": op, "params": params}
        try:
            event = self.client.request(body, "headless_event/v0.2", timeout_ms=timeout_ms)
            if (event.get("schema") != "headless_event/v0.2"
                    or event.get("request_id") != body["request_id"]):
                raise HeadlessError("uncorrelated headless response")
            if event.get("event") == "refused":
                raise HeadlessError("headless request refused: " + event["data"]["code"])
            incoming = event.get("data", {}).get("session")
            if not isinstance(incoming, dict):
                raise HeadlessError("headless session missing")
            if self.session is not None and any(
                    incoming.get(key) != self.session.get(key)
                    for key in ("workload_id", "generation", "owner_id")):
                raise HeadlessError("headless identity changed")
            expected_owner = "actor-" + hashlib.sha256(
                ("agent:" + self.client.local["endpoint"]["instance"]).encode()).hexdigest()
            if incoming.get("owner_id") != expected_owner:
                raise HeadlessError("headless owner mismatch")
            self.session = copy.deepcopy(incoming)
            if event.get("event") == "outcome_unknown":
                raise HeadlessError("headless outcome unknown; do not replay")
            return event
        except BaseException:
            self.uncertain = True
            raise

    def create(self, *, timeout_ms=30000):
        if self.create_attempted:
            raise HeadlessError("create already attempted")
        self.create_attempted = True
        event = self._request("create", {"template": "headless-sumsq"}, timeout_ms)
        if event["event"] != "state_changed" or self.session["phase"] != "ready":
            self.uncertain = True
            raise HeadlessError("headless guest is not ready")
        return copy.deepcopy(self.session)

    def run(self, n, *, timeout_ms=10000):
        if type(n) is not int or not 0 <= n <= 10000:
            raise ValueError("n must be an integer from 0 through 10000")
        if (self.closed or self.uncertain or self.job_attempted or self.session is None
                or self.session.get("phase") != "ready"):
            raise HeadlessError("guest job is not available")
        self.job_attempted = True
        params = {key: self.session[key] for key in ("workload_id", "generation")}
        params.update(job_id="job-" + secrets.token_hex(16), operation="sumsq", n=n)
        event = self._request("run", params, timeout_ms)
        job = self.session.get("job", {})
        if (event["event"] != "completed" or job.get("job_id") != params["job_id"]
                or type(job.get("n")) is not int or job.get("n") != n
                or type(job.get("value")) is not int
                or job.get("value") != n * (n + 1) * (2 * n + 1) // 6):
            self.uncertain = True
            raise HeadlessError("unverified guest job result")
        return copy.deepcopy(job)

    def stop(self, *, timeout_ms=30000):
        if self.closed:
            return copy.deepcopy(self.session)
        if self.session is None:
            raise HeadlessError("no correlated guest identity to stop")
        params = {key: self.session[key] for key in ("workload_id", "generation")}
        event = self._request("stop", params, timeout_ms)
        if (event["event"] != "state_changed" or self.session["phase"] != "stopped"
                or self.session["ownership"] != "released"):
            self.uncertain = True
            raise HeadlessError("guest closure not confirmed")
        self.closed = True
        return copy.deepcopy(self.session)
