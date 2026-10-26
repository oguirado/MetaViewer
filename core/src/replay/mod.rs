//! Bounded session and authenticated sender-instance replay evidence.
use crate::wire::error_type;
use crate::{Endpoint, LimitError};
use std::collections::{BTreeMap, BTreeSet};
error_type!(ReplayError {
    InvalidIdentity,
    ZeroSequence,
    DuplicateNonce,
    NonIncreasingSequence,
    Exhausted,
    CapacityExceeded
});
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplaySnapshot {
    pub entries: BTreeSet<(String, Endpoint, String)>,
    pub sequences: BTreeMap<(String, Endpoint), u64>,
}
pub struct ReplayTable {
    capacity: usize,
    state: ReplaySnapshot,
}
impl ReplayTable {
    pub fn new(max_entries: usize) -> Result<Self, LimitError> {
        if max_entries == 0 {
            return Err(LimitError::MissingOrZero);
        }
        Ok(Self {
            capacity: max_entries,
            state: ReplaySnapshot {
                entries: BTreeSet::new(),
                sequences: BTreeMap::new(),
            },
        })
    }
    pub fn record(
        &mut self,
        session_id: &str,
        sender: &Endpoint,
        nonce: &str,
        seq: u64,
    ) -> Result<(), ReplayError> {
        if [session_id, &sender.instance, nonce]
            .iter()
            .any(|s| s.is_empty() || s.chars().count() > 128)
        {
            return Err(ReplayError::InvalidIdentity);
        }
        if seq == 0 {
            return Err(ReplayError::ZeroSequence);
        }
        if self.contains(session_id, sender, nonce) {
            return Err(ReplayError::DuplicateNonce);
        }
        let key = (session_id.to_owned(), sender.clone());
        if let Some(previous) = self.state.sequences.get(&key) {
            let next = previous.checked_add(1).ok_or(ReplayError::Exhausted)?;
            if seq < next {
                return Err(ReplayError::NonIncreasingSequence);
            }
        }
        if self.state.entries.len() >= self.capacity {
            return Err(ReplayError::CapacityExceeded);
        }
        self.state
            .entries
            .insert((session_id.to_owned(), sender.clone(), nonce.to_owned()));
        self.state.sequences.insert(key, seq);
        Ok(())
    }
    pub fn contains(&self, session_id: &str, sender: &Endpoint, nonce: &str) -> bool {
        self.state
            .entries
            .contains(&(session_id.to_owned(), sender.clone(), nonce.to_owned()))
    }
    pub fn snapshot(&self) -> ReplaySnapshot {
        self.state.clone()
    }
}
