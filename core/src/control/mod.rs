#![forbid(unsafe_code)]
//! [TARGET, unit decision] Frame publication only. Operator control transitions
//! belong exclusively to serve, including cancellation notices and daemon forwarding.
//! Refusals are journal entries too; a resumed surface needs a newer frame.
//!
//! Control transitions must use serve's authenticated routing:
//! ```compile_fail
//! use metaviewer_core::control::transition;
//! ```
use crate::admission::{Authority, Frame, Input, Outcome};
use crate::journal::JournalError;
use crate::Refusal;

#[cfg(test)]
mod tests;

/// Publish only a strictly newer generation across a control refresh fence.
pub fn publish_frame(
    authority: &mut Authority,
    surface_id: &str,
    frame: Frame,
    witnesses: Vec<crate::journal::Witness>,
) -> Result<Outcome, JournalError> {
    let refusal = match authority.state().surfaces.get(surface_id) {
        None => Some(Refusal::Policy),
        Some(surface) if !surface.live => Some(Refusal::SurfaceNotAgentControlled),
        Some(surface)
            if frame.generation == 0
                || surface
                    .frame
                    .as_ref()
                    .is_some_and(|previous| frame.generation <= previous.generation) =>
        {
            Some(Refusal::StaleFrame)
        }
        _ if frame.width == 0
            || frame.height == 0
            || frame.sha256.len() != 64
            || !frame
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || !witnesses.iter().any(|w| w.sha256 == frame.sha256) =>
        {
            Some(Refusal::Policy)
        }
        _ => None,
    };
    if let Some(reason) = refusal {
        return authority.apply(Input::Refuse { reason });
    }
    match authority.apply_with_witnesses(
        Input::Frame {
            surface_id: surface_id.into(),
            frame,
        },
        witnesses,
    ) {
        // [TARGET, unit decision] Any rejected publication attempts a durable
        // refusal. Storage failure/poisoning may also prevent that refusal;
        // propagate its error rather than claiming an unjournalled success.
        Err(_) => authority.apply(Input::Refuse {
            reason: Refusal::Policy,
        }),
        result => result,
    }
}
