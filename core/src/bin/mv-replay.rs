#![forbid(unsafe_code)]
use metaviewer_core::journal::{scan, sha256_hex, JournalError};
use std::path::PathBuf;
fn run() -> Result<(), JournalError> {
    let mut args = std::env::args_os().skip(1);
    let mut journal = None;
    let mut root = None;
    let mut verify = false;
    while let Some(arg) = args.next() {
        match arg.to_str() {
            Some("--journal") if journal.is_none() => {
                journal = Some(PathBuf::from(args.next().ok_or(JournalError::Invalid)?))
            }
            Some("--witness-root") if root.is_none() => {
                root = Some(PathBuf::from(args.next().ok_or(JournalError::Invalid)?))
            }
            Some("--verify-only") if !verify => verify = true,
            _ => return Err(JournalError::Invalid),
        }
    }
    let replay = scan(
        &journal.ok_or(JournalError::Invalid)?,
        &root.ok_or(JournalError::Invalid)?,
    )?;
    if !verify {
        println!(
            "{}",
            sha256_hex(&replay.state.snapshot().map_err(|_| JournalError::Corrupt)?)
        );
    }
    Ok(())
}
fn main() {
    if let Err(e) = run() {
        eprintln!("{e}");
        std::process::exit(match e {
            JournalError::Duplicate => 3,
            JournalError::Witness => 4,
            _ => 2,
        });
    }
}
