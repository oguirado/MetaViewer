//! Authenticated graphical QEMU rewind session routing.
use super::*;
use crate::wire::graphical_session::{GraphicalSessionEvent, GraphicalSessionRequest};

impl Server {
    pub(super) fn graphical_session_request_at(
        &mut self,
        now_ns: u64,
        env: &Envelope,
        request: &GraphicalSessionRequest,
        boundary: Witness,
    ) -> Result<()> {
        let agent = self.agent()?;
        let daemon = self.config.peers.iter().find(|p| p.endpoint.component == Component::Daemon)
            .map(|p| p.endpoint.clone()).ok_or_else(|| invalid("no daemon"))?;
        let surface_id = request.0["surface_id"].as_str().unwrap_or("");
        let enabled = self.graphical_session_enabled && self.connections.contains_key(&daemon);
        let capture_busy = self.capture.has_active_recording(surface_id);
        let out = self.authority.apply_with_witnesses(
            Input::GraphicalSessionRequest {
                request: request.clone(), caller: env.from.clone(), agent, daemon: daemon.clone(),
                enabled, capture_busy, received_ns: now_ns,
            },
            vec![boundary],
        )?;
        self.authority.flush_sync()?;
        if let Some(reason) = out.reason {
            let code = if !enabled { "UNAVAILABLE" } else { graphical_refusal_code(reason) };
            let event = self.authority.state().graphical_session.refusal_event(
                &request.0, &env.from, code, out.core_seq,
            );
            let event: GraphicalSessionEvent = serde_json::from_value(event)?;
            return self.send_at(now_ns, &env.from, Command::GraphicalSessionEvent(Box::new(event)));
        }
        let request_id = request.0["request_id"].as_str().ok_or_else(|| invalid("graphical request id"))?;
        let reply = self.authority.state().graphical_session.saved_reply(request_id)
            .cloned().ok_or_else(|| invalid("graphical session reply missing"))?;
        let event: GraphicalSessionEvent = serde_json::from_value(reply)?;
        if let Err(error) = self.send_at(now_ns, &env.from, Command::GraphicalSessionEvent(Box::new(event))) {
            if error.downcast_ref::<SendFailure>().is_none() { return Err(error); }
            self.mark_graphical_session_unknown_at(now_ns)?;
            return Ok(());
        }
        if out.dispatch {
            if let Err(error) = self.send_at(now_ns, &daemon, env.body.clone()) {
                if error.downcast_ref::<SendFailure>().is_none() { return Err(error); }
                self.mark_graphical_session_unknown_at(now_ns)?;
            }
        }
        Ok(())
    }

    pub(super) fn graphical_session_event_at(
        &mut self,
        now_ns: u64,
        env: &Envelope,
        event: &GraphicalSessionEvent,
        epoch: u64,
        boundary: Witness,
    ) -> Result<()> {
        if let Some(previous) = self.authority.state().graphical_session.events.get(event.0["event_id"].as_str().unwrap_or("")) {
            if previous == &event.0 { return Ok(()); }
        }
        let recipient = self.authority.state().graphical_session.pending.as_ref().map(|p| p.caller.clone());
        let out = self.authority.apply_with_witnesses(
            Input::GraphicalSessionEvent { notice: event.clone(), sender: env.from.clone(), executor_epoch: epoch },
            vec![boundary],
        )?;
        if out.reason.is_some() { return Ok(()); }
        self.authority.flush_sync()?;
        if let Some(recipient) = recipient.filter(|p| self.connections.contains_key(p)) {
            self.send_at(now_ns, &recipient, Command::GraphicalSessionEvent(Box::new(event.clone())))?;
        }
        Ok(())
    }

    pub(super) fn poll_graphical_session_at(&mut self, now_ns: u64) -> Result<()> {
        let expired = self.authority.state().graphical_session.pending.as_ref()
            .is_some_and(|p| !p.uncertain && now_ns >= p.deadline_ns);
        if expired { self.mark_graphical_session_unknown_at(now_ns)?; }
        Ok(())
    }

    pub(super) fn mark_graphical_session_unknown_at(&mut self, now_ns: u64) -> Result<()> {
        let Some(pending) = self.authority.state().graphical_session.pending.clone() else { return Ok(()); };
        if !pending.uncertain {
            self.authority.apply(Input::GraphicalSessionUncertain)?;
            self.authority.flush_sync()?;
        }
        if let Some(reply) = self.authority.state().graphical_session.saved_reply(
            pending.request["request_id"].as_str().unwrap_or(""),
        ).cloned() {
            let event: GraphicalSessionEvent = serde_json::from_value(reply)?;
            if self.connections.contains_key(&pending.caller) {
                let _ = self.send_at(now_ns, &pending.caller, Command::GraphicalSessionEvent(Box::new(event)));
            }
        }
        Ok(())
    }

    pub(super) fn notify_graphical_lost_at(&mut self, now_ns: u64, surface_id: &str) -> Result<()> {
        let Some(pending) = self.authority.state().graphical_session.pending.as_ref()
            .filter(|p| p.uncertain && p.request["surface_id"] == surface_id).cloned() else { return Ok(()); };
        let Some(reply) = self.authority.state().graphical_session.saved_reply(
            pending.request["request_id"].as_str().unwrap_or(""),
        ).cloned() else { return Ok(()); };
        let event: GraphicalSessionEvent = serde_json::from_value(reply)?;
        if self.connections.contains_key(&pending.caller) {
            let _ = self.send_at(now_ns, &pending.caller, Command::GraphicalSessionEvent(Box::new(event)));
        }
        Ok(())
    }
}

fn graphical_refusal_code(reason: Refusal) -> &'static str {
    match reason {
        Refusal::BudgetExceeded => "CAPACITY",
        Refusal::StaleFrame => "STALE",
        Refusal::LockedByOther | Refusal::SurfaceNotAgentControlled => "BUSY",
        Refusal::OutOfBounds | Refusal::Policy => "POLICY",
    }
}
