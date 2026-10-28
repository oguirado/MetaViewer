//! [TARGET, unit decision] Best-effort diagnostic clock, independent of authority.
//! The writer truncates before exceeding 4 MiB (drop all oldest rows), including
//! on the first accepted frame after restart. A bounded queue holds 256 rows; saturation disables this clock
//! once rather than delaying frames. I/O failures log once and stop the worker.
//! Durations are disjoint wall-clock stages, not background fsync completion.
use super::{frame_open_flags, FrameRef};
use crate::journal::VerifiedPixels;
use serde::Serialize;
use std::fs::OpenOptions;
use std::io::{self, BufWriter, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::sync::mpsc::{self, SyncSender};
use std::thread::{self, JoinHandle};
use std::time::Instant;

const MAX_BYTES: usize = 4 * 1024 * 1024;

#[derive(Default, Serialize)]
pub(super) struct Row {
    surface_id: String,
    generation: u64,
    width: u64,
    height: u64,
    pub byte_len: u64,
    shm_read_ns: u128,
    hash_ns: u128,
    pub witness_journal_ns: u128,
    pub capture_ns: u128,
    pub fanout_ns: u128,
    total_ns: u128,
}

pub(super) struct Clock {
    started: Instant,
    pub row: Row,
    pub accepted: bool,
}
impl Clock {
    pub fn new(frame: &FrameRef) -> Self {
        Self {
            started: Instant::now(),
            accepted: false,
            row: Row {
                surface_id: frame.surface_id.clone(),
                generation: frame.generation,
                width: frame.width,
                height: frame.height,
                ..Row::default()
            },
        }
    }
    pub fn read(&mut self, pixels: &VerifiedPixels) {
        if let Some(started) = pixels.read_started {
            self.started = self.started.min(started);
        }
        self.row.shm_read_ns = pixels.shm_read_ns;
        self.row.hash_ns = pixels.hash_ns;
    }
    pub fn finish(mut self) -> Row {
        self.row.total_ns = self.started.elapsed().as_nanos();
        self.row
    }
}

pub(super) struct Writer {
    sender: Option<SyncSender<Row>>,
    worker: Option<JoinHandle<()>>,
}
impl Writer {
    pub fn start(path: PathBuf) -> Self {
        let (sender, receiver) = mpsc::sync_channel::<Row>(256);
        let worker = thread::Builder::new()
            .name("frame-timings".into())
            .spawn(move || {
                let run = || -> io::Result<()> {
                    // Unauthenticated/refused traffic must not create artifacts.
                    let Ok(first) = receiver.recv() else {
                        return Ok(());
                    };
                    let flags = frame_open_flags().map_err(io::Error::other)?;
                    let file = OpenOptions::new()
                        .write(true)
                        .create(true)
                        .truncate(false)
                        .custom_flags(flags)
                        .mode(0o600)
                        .open(path)?;
                    if !file.metadata()?.is_file() {
                        return Err(io::Error::other("timing destination is not a regular file"));
                    }
                    file.set_len(0)?;
                    let mut output = BufWriter::new(file);
                    let mut size = 0;
                    for row in std::iter::once(first).chain(receiver) {
                        let mut bytes = serde_json::to_vec(&row)?;
                        bytes.push(b'\n');
                        write_row(&mut output, &mut size, &bytes)?;
                    }
                    output.flush()
                };
                if let Err(error) = run() {
                    eprintln!("frame timings disabled: {error}");
                }
            });
        match worker {
            Ok(worker) => Self {
                sender: Some(sender),
                worker: Some(worker),
            },
            Err(error) => {
                eprintln!("frame timings disabled: {error}");
                Self {
                    sender: None,
                    worker: None,
                }
            }
        }
    }
    pub fn submit(&mut self, row: Row) {
        if let Some(sender) = &self.sender {
            match sender.try_send(row) {
                Ok(()) => {}
                Err(mpsc::TrySendError::Full(_)) => {
                    eprintln!("frame timings disabled: queue saturated");
                    self.sender = None;
                }
                // The worker already logged its I/O failure.
                Err(mpsc::TrySendError::Disconnected(_)) => self.sender = None,
            }
        }
    }
    pub fn close(&mut self) {
        self.sender = None;
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
impl Drop for Writer {
    fn drop(&mut self) {
        self.close();
    }
}
fn write_row(
    output: &mut BufWriter<std::fs::File>,
    size: &mut usize,
    bytes: &[u8],
) -> io::Result<()> {
    if bytes.len() > MAX_BYTES {
        return Err(io::Error::other("timing row exceeds file cap"));
    }
    if *size + bytes.len() > MAX_BYTES {
        use std::io::{Seek, SeekFrom};
        output.flush()?;
        output.get_mut().set_len(0)?;
        output.seek(SeekFrom::Start(0))?;
        *size = 0;
    }
    output.write_all(bytes)?;
    // Flush only on the writer thread: readers see complete rows promptly.
    output.flush()?;
    *size += bytes.len();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "mv-timing-writer-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }
    #[test]
    fn rotation_is_bounded_and_retains_only_complete_rows() {
        let temp = Temp::new();
        let path = temp.0.join("frame_timings.jsonl");
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        let mut writer = BufWriter::new(file);
        let mut size = 0;
        for value in ['a', 'b', 'c'] {
            let mut bytes = serde_json::to_vec(
                &serde_json::json!({"padding": value.to_string().repeat(MAX_BYTES / 2)}),
            )
            .unwrap();
            bytes.push(b'\n');
            write_row(&mut writer, &mut size, &bytes).unwrap();
            assert!(std::fs::metadata(&path).unwrap().len() <= MAX_BYTES as u64);
        }
        let text = std::fs::read_to_string(path).unwrap();
        assert_eq!(text.lines().count(), 1);
        let row: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert!(row["padding"].as_str().unwrap().bytes().all(|b| b == b'c'));
    }
    #[test]
    fn no_accepted_frames_leave_no_artifact() {
        let temp = Temp::new();
        let path = temp.0.join("frame_timings.jsonl");
        let mut writer = Writer::start(path.clone());
        writer.close();
        assert!(!path.exists());
    }
    #[test]
    fn io_failure_disconnects_without_affecting_submit() {
        let temp = Temp::new();
        // A directory cannot be a timing file. Joining proves the worker has
        // handled its I/O failure; submission thereafter must remain harmless.
        let mut writer = Writer::start(temp.0.clone());
        writer.submit(Row::default());
        writer.worker.take().unwrap().join().unwrap();
        writer.submit(Row::default());
        assert!(writer.sender.is_none());
        writer.submit(Row::default());
        writer.close();
    }
    #[test]
    fn queue_saturation_permanently_disables_sender_and_live_submit_rotates_at_4_mib() {
        let (sender, receiver) = mpsc::sync_channel::<Row>(256);
        let mut writer = Writer {
            sender: Some(sender),
            worker: None,
        };
        for i in 0..256 {
            writer.submit(Row {
                generation: i,
                ..Row::default()
            });
            assert!(writer.sender.is_some());
        }
        // 257th submission hits Full(_) and permanently sets self.sender = None.
        writer.submit(Row {
            generation: 256,
            ..Row::default()
        });
        assert!(writer.sender.is_none());

        // Negative control: pop one item after saturation so the channel has capacity again,
        // then submit another row and prove it is not sent because self.sender stayed None.
        assert_eq!(receiver.try_recv().unwrap().generation, 0);
        writer.submit(Row {
            generation: 999,
            ..Row::default()
        });
        let remaining: Vec<u64> = receiver.try_iter().map(|r| r.generation).collect();
        assert_eq!(remaining.len(), 255);
        assert_eq!(*remaining.last().unwrap(), 255);
        assert!(!remaining.contains(&999));

        // Exercise live Writer::submit across the 4 MiB rotation boundary.
        let temp = Temp::new();
        let path = temp.0.join("live_timings.jsonl");
        let mut live = Writer::start(path.clone());
        let pad = "s".repeat(MAX_BYTES / 2);
        for gen in [1_u64, 2, 3] {
            live.submit(Row {
                surface_id: pad.clone(),
                generation: gen,
                ..Row::default()
            });
        }
        live.close();
        let meta = std::fs::metadata(&path).unwrap();
        assert!(meta.len() <= MAX_BYTES as u64);
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(text.lines().count(), 1);
        let row: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(row["generation"], 3);
    }
}
