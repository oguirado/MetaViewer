#![forbid(unsafe_code)]
//! Authority core namespace reservations.
//!
//! `admission` and `journal` belong to W1-CORE-ADMIT; `supervisor` belongs to
//! W1-SUPERVISOR. The later owners are W2-AILOOP for `verify`, W2-HUMAN-INPUT
//! for `control`, W2-REC for `record`, and W2-CATALOG-CORE for `catalog`.

pub mod admission;
pub mod catalog;
pub mod control;
pub mod journal;
pub mod record;
pub mod supervisor;
pub mod verify;

pub mod replay;
pub mod transport;
pub mod wire;
pub use replay::*;
pub use transport::*;
pub use wire::*;
pub mod serve;
