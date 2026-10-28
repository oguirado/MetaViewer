//! [TARGET, unit decision] Best-effort diagnostic clock, independent of authority.
//! The writer truncates before exceeding 4 MiB (drop all oldest rows), including
//! on the first accepted frame after restart. A bounded queue holds 256 rows; saturation disables this clock
//! once rather than delaying frames. I/O failures log once and stop the worker.
//! Durations are disjoint wall-clock stages, not background fsync completion.
//! [TARGET, unit decision] Skipped-hash and parallel-wait stage accounting are
//! recorded as additive optional row fields without altering existing keys or
//! 4 MiB rotation; Writer maintains per-surface queue-depth evidence and
//! disable-once saturation state under multi-capsule load.
use super::{frame_open_flags, FrameRef};
use crate::journal::VerifiedPixels;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::OpenOptions;
use std::io::{self, BufWriter, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Instant;

const MAX_BYTES: usize = 4 * 1024 * 1024;
const QUEUE_CAPACITY: usize = 256;
pub(super) const SATURATION_DISABLE_MARKER: &str = "frame timings disabled: queue saturated";

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct SurfaceQueueDepth {
    pub queued: usize,
    pub peak_queued: usize,
    pub submitted: u64,
    pub drained: u64,
}

#[derive(Default)]
struct QueueTelemetry {
    per_surface: Mutex<BTreeMap<String, SurfaceQueueDepth>>,
    saturation_disabled: AtomicBool,
    saturation_disable_count: AtomicU64,
    io_failed: AtomicBool,
    io_failure_count: AtomicU64,
}

impl QueueTelemetry {
    fn on_enqueue(&self, surface_id: &str) -> usize {
        if surface_id.is_empty() {
            return 0;
        }
        let mut map = self.per_surface.lock().unwrap_or_else(|e| e.into_inner());
        let entry = map.entry(surface_id.to_owned()).or_default();
        entry.queued += 1;
        entry.peak_queued = entry.peak_queued.max(entry.queued);
        entry.submitted += 1;
        entry.queued
    }

    fn on_rollback(&self, surface_id: &str) {
        if surface_id.is_empty() {
            return;
        }
        let mut map = self.per_surface.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = map.get_mut(surface_id) {
            entry.queued = entry.queued.saturating_sub(1);
            entry.submitted = entry.submitted.saturating_sub(1);
        }
    }

    fn on_drain(&self, surface_id: &str) {
        if surface_id.is_empty() {
            return;
        }
        let mut map = self.per_surface.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = map.get_mut(surface_id) {
            entry.queued = entry.queued.saturating_sub(1);
            entry.drained += 1;
        }
    }

    fn clear_in_flight(&self) {
        let mut map = self.per_surface.lock().unwrap_or_else(|e| e.into_inner());
        for entry in map.values_mut() {
            entry.queued = 0;
        }
    }

    fn record_saturation_disable(&self) -> bool {
        let first = !self.saturation_disabled.swap(true, Ordering::AcqRel);
        if first {
            self.saturation_disable_count
                .fetch_add(1, Ordering::Relaxed);
        }
        first
    }

    fn record_io_failure(&self) -> bool {
        let first = !self.io_failed.swap(true, Ordering::AcqRel);
        if first {
            self.io_failure_count.fetch_add(1, Ordering::Relaxed);
        }
        first
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skipped_hash_ns: Option<u128>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hash_skipped: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parallel_wait_ns: Option<u128>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surface_queue_depth: Option<u64>,
}

#[allow(dead_code)]
impl Row {
    pub fn with_skipped_hash(mut self, skipped_hash_ns: u128, hash_skipped: bool) -> Self {
        self.skipped_hash_ns = Some(skipped_hash_ns);
        self.hash_skipped = Some(hash_skipped);
        self
    }

    pub fn with_parallel_wait(mut self, parallel_wait_ns: u128) -> Self {
        self.parallel_wait_ns = Some(parallel_wait_ns);
        self
    }

    pub fn with_surface_queue_depth(mut self, depth: u64) -> Self {
        self.surface_queue_depth = Some(depth);
        self
    }
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
        self.row.skipped_hash_ns = Some(pixels.skipped_hash_ns);
        self.row.hash_skipped = Some(pixels.hash_skipped);
    }
    #[allow(dead_code)]
    pub fn read_with_stages(&mut self, pixels: &VerifiedPixels) {
        self.read(pixels);
    }
    #[allow(dead_code)]
    pub fn record_skipped_hash(&mut self, skipped_hash_ns: u128, hash_skipped: bool) {
        self.row.skipped_hash_ns = Some(skipped_hash_ns);
        self.row.hash_skipped = Some(hash_skipped);
    }
    #[allow(dead_code)]
    pub fn record_parallel_wait(&mut self, wait_ns: u128) {
        self.row.parallel_wait_ns = Some(
            self.row
                .parallel_wait_ns
                .unwrap_or(0)
                .saturating_add(wait_ns),
        );
    }
    #[allow(dead_code)]
    pub fn record_surface_queue_depth(&mut self, depth: u64) {
        self.row.surface_queue_depth = Some(depth);
    }
    pub fn finish(mut self) -> Row {
        self.row.total_ns = self.started.elapsed().as_nanos();
        self.row
    }
}

pub(super) struct Writer {
    sender: Option<SyncSender<Row>>,
    worker: Option<JoinHandle<()>>,
    telemetry: Arc<QueueTelemetry>,
}
impl Writer {
    pub fn start(path: PathBuf) -> Self {
        let (sender, receiver) = mpsc::sync_channel::<Row>(QUEUE_CAPACITY);
        let telemetry = Arc::new(QueueTelemetry::default());
        let worker_telemetry = telemetry.clone();
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
                        let surface_id = row.surface_id.clone();
                        let mut bytes = serde_json::to_vec(&row)?;
                        bytes.push(b'\n');
                        write_row(&mut output, &mut size, &bytes)?;
                        worker_telemetry.on_drain(&surface_id);
                    }
                    output.flush()
                };
                if let Err(error) = run() {
                    worker_telemetry.clear_in_flight();
                    if worker_telemetry.record_io_failure() {
                        eprintln!("frame timings disabled: {error}");
                    }
                }
            });
        match worker {
            Ok(worker) => Self {
                sender: Some(sender),
                worker: Some(worker),
                telemetry,
            },
            Err(error) => {
                if telemetry.record_io_failure() {
                    eprintln!("frame timings disabled: {error}");
                }
                Self {
                    sender: None,
                    worker: None,
                    telemetry,
                }
            }
        }
    }
    pub fn submit(&mut self, row: Row) {
        if let Some(sender) = &self.sender {
            let surface_id = row.surface_id.clone();
            self.telemetry.on_enqueue(&surface_id);
            match sender.try_send(row) {
                Ok(()) => {}
                Err(mpsc::TrySendError::Full(_)) => {
                    self.telemetry.on_rollback(&surface_id);
                    if self.telemetry.record_saturation_disable() {
                        eprintln!("{SATURATION_DISABLE_MARKER}");
                    }
                    self.sender = None;
                }
                // The worker already logged its I/O failure.
                Err(mpsc::TrySendError::Disconnected(_)) => {
                    self.telemetry.on_rollback(&surface_id);
                    self.sender = None;
                }
            }
        }
    }
    #[allow(dead_code)]
    pub fn surface_queue_depth(&self, surface_id: &str) -> usize {
        self.telemetry
            .per_surface
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(surface_id)
            .map_or(0, |d| d.queued)
    }
    #[allow(dead_code)]
    pub fn peak_surface_queue_depth(&self, surface_id: &str) -> usize {
        self.telemetry
            .per_surface
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(surface_id)
            .map_or(0, |d| d.peak_queued)
    }
    #[allow(dead_code)]
    pub fn surface_queue_snapshot(&self) -> BTreeMap<String, SurfaceQueueDepth> {
        self.telemetry
            .per_surface
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
    #[allow(dead_code)]
    pub fn is_saturation_disabled(&self) -> bool {
        self.telemetry.saturation_disabled.load(Ordering::Acquire)
    }
    #[allow(dead_code)]
    pub fn saturation_disable_count(&self) -> u64 {
        self.telemetry
            .saturation_disable_count
            .load(Ordering::Acquire)
    }
    #[allow(dead_code)]
    pub fn saturation_disable_marker(&self) -> Option<&'static str> {
        self.is_saturation_disabled()
            .then_some(SATURATION_DISABLE_MARKER)
    }
    #[allow(dead_code)]
    pub fn io_failure_count(&self) -> u64 {
        self.telemetry.io_failure_count.load(Ordering::Acquire)
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
            telemetry: Arc::new(QueueTelemetry::default()),
        };
        for i in 0..256 {
            writer.submit(Row {
                surface_id: format!("srf-{}", i % 4),
                generation: i,
                ..Row::default()
            });
            assert!(writer.sender.is_some());
            assert!(!writer.is_saturation_disabled());
        }
        // 257th submission hits Full(_) and permanently sets self.sender = None.
        writer.submit(Row {
            surface_id: "srf-0".into(),
            generation: 256,
            ..Row::default()
        });
        assert!(writer.sender.is_none());
        assert!(writer.is_saturation_disabled());
        assert_eq!(writer.saturation_disable_count(), 1);
        assert_eq!(
            writer.saturation_disable_marker(),
            Some(SATURATION_DISABLE_MARKER)
        );

        // Negative control: pop one item after saturation so the channel has capacity again,
        // then submit another row and prove it is not sent because self.sender stayed None.
        assert_eq!(receiver.try_recv().unwrap().generation, 0);
        writer.submit(Row {
            surface_id: "srf-0".into(),
            generation: 999,
            ..Row::default()
        });
        assert_eq!(writer.saturation_disable_count(), 1);
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

    #[test]
    fn skipped_hash_and_parallel_wait_are_additive_without_altering_existing_keys() {
        let mut frame: FrameRef = serde_json::from_str(include_str!(
            "../../../contracts/examples/v0.2/frame_ref.valid.json"
        ))
        .unwrap();
        frame.surface_id = "srf-cap-1".into();
        frame.generation = 7;
        frame.width = 1280;
        frame.height = 900;

        let payload = vec![0x5a_u8; 4096];
        let sha = crate::journal::sha256_hex(&payload);
        let verified = VerifiedPixels::read_verified(&payload[..], payload.len(), &sha).unwrap();

        // Production Clock::read sets skipped_hash_ns and hash_skipped alongside the 11 base keys.
        let mut prod_clock = Clock::new(&frame);
        prod_clock.read(&verified);
        prod_clock.row.byte_len = payload.len() as u64;
        let prod_row = prod_clock.finish();
        let prod_json = serde_json::to_value(&prod_row).unwrap();
        let prod_keys: Vec<&str> = prod_json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            prod_keys,
            [
                "byte_len",
                "capture_ns",
                "fanout_ns",
                "generation",
                "hash_ns",
                "hash_skipped",
                "height",
                "shm_read_ns",
                "skipped_hash_ns",
                "surface_id",
                "total_ns",
                "width",
                "witness_journal_ns"
            ]
        );
        assert_eq!(prod_json["hash_skipped"], false);
        assert_eq!(prod_json["skipped_hash_ns"], 0);
        assert!(prod_json["hash_ns"].as_u64().unwrap() > 0);

        // Additive stage accounting records skipped_hash_ns, hash_skipped, parallel_wait_ns,
        // and surface_queue_depth without altering existing keys or 4 MiB rotation.
        let mut stage_clock = Clock::new(&frame);
        stage_clock.read(&verified);
        stage_clock.record_skipped_hash(1_450, true);
        stage_clock.record_parallel_wait(3_200);
        stage_clock.record_parallel_wait(800);
        stage_clock.record_surface_queue_depth(4);
        stage_clock.row.byte_len = 3_456_000;
        stage_clock.row.witness_journal_ns = 900;
        stage_clock.row.capture_ns = 500;
        stage_clock.row.fanout_ns = 300;
        let stage_row = stage_clock.finish();
        let stage_json = serde_json::to_value(&stage_row).unwrap();
        for key in &prod_keys {
            assert!(
                stage_json.get(*key).is_some(),
                "missing existing base key {key}"
            );
        }
        assert_eq!(stage_json["surface_id"], "srf-cap-1");
        assert_eq!(stage_json["generation"], 7);
        assert_eq!(stage_json["skipped_hash_ns"], 1_450);
        assert_eq!(stage_json["hash_skipped"], true);
        assert_eq!(stage_json["parallel_wait_ns"], 4_000);
        assert_eq!(stage_json["surface_queue_depth"], 4);
    }

    #[test]
    fn per_surface_queue_depth_and_single_log_io_failure_under_multi_capsule_load() {
        let temp = Temp::new();
        let path = temp.0.join("multi_capsule_timings.jsonl");
        let mut writer = Writer::start(path.clone());
        let capsules = ["srf-cap-1", "srf-cap-2", "srf-cap-3", "srf-cap-4"];
        for step in 0..32_u64 {
            let surface_id = capsules[(step as usize) % capsules.len()];
            let depth = (writer.surface_queue_depth(surface_id) + 1) as u64;
            let row = Row {
                surface_id: surface_id.into(),
                generation: step / 4 + 1,
                width: 1280,
                height: 900,
                byte_len: 3_456_000,
                ..Row::default()
            }
            .with_skipped_hash(1_100, step >= 4)
            .with_parallel_wait(u128::from(500 * (step % 4)))
            .with_surface_queue_depth(depth);
            writer.submit(row);
        }
        writer.close();
        let snap = writer.surface_queue_snapshot();
        assert_eq!(snap.len(), 4);
        for cap in capsules {
            let entry = snap.get(cap).expect("per-surface queue entry");
            assert_eq!(entry.queued, 0, "drained queue must end at 0");
            assert!(entry.peak_queued >= 1, "peak queue depth must be recorded");
            assert_eq!(entry.submitted, 8);
            assert_eq!(entry.drained, 8);
            assert!(writer.peak_surface_queue_depth(cap) >= 1);
            assert_eq!(writer.surface_queue_depth(cap), 0);
        }
        let lines: Vec<serde_json::Value> = std::fs::read_to_string(&path)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines.len(), 32);

        // Single-log I/O failure under multi-capsule load (directory destination).
        let mut bad_writer = Writer::start(temp.0.clone());
        for (idx, cap) in capsules.iter().enumerate() {
            bad_writer.submit(Row {
                surface_id: (*cap).into(),
                generation: (idx + 1) as u64,
                ..Row::default()
            });
        }
        bad_writer.worker.take().unwrap().join().unwrap();
        for cap in capsules {
            bad_writer.submit(Row {
                surface_id: cap.into(),
                generation: 99,
                ..Row::default()
            });
            assert_eq!(bad_writer.surface_queue_depth(cap), 0);
        }
        assert_eq!(
            bad_writer.io_failure_count(),
            1,
            "I/O failure must log and latch exactly once across multi-capsule submissions"
        );
        bad_writer.close();
    }

    #[test]
    fn saturation_mc_silent_drop_retains_truncation_free_rows_and_disable_marker() {
        let temp = Temp::new();
        let path = temp.0.join("saturated_timings.jsonl");
        let (sender, receiver) = mpsc::sync_channel::<Row>(QUEUE_CAPACITY);
        let telemetry = Arc::new(QueueTelemetry::default());
        let mut writer = Writer {
            sender: Some(sender),
            worker: None,
            telemetry: telemetry.clone(),
        };
        let capsules = ["srf-cap-1", "srf-cap-2", "srf-cap-3", "srf-cap-4"];
        for i in 0..(QUEUE_CAPACITY as u64) {
            let cap = capsules[(i as usize) % capsules.len()];
            let row = Row {
                surface_id: cap.into(),
                generation: i,
                width: 1280,
                height: 900,
                byte_len: 3_456_000,
                ..Row::default()
            }
            .with_skipped_hash(950, i >= 4)
            .with_parallel_wait(u128::from(250 * (i % 4)))
            .with_surface_queue_depth((i / 4) + 1);
            writer.submit(row);
        }
        for cap in capsules {
            assert_eq!(writer.surface_queue_depth(cap), 64);
            assert_eq!(writer.peak_surface_queue_depth(cap), 64);
        }
        assert!(!writer.is_saturation_disabled());
        assert_eq!(writer.saturation_disable_marker(), None);

        // Overflow submissions across all 4 capsules hit Full(_) and disable once.
        for overflow_gen in 256..264_u64 {
            let cap = capsules[(overflow_gen as usize) % capsules.len()];
            writer.submit(Row {
                surface_id: cap.into(),
                generation: overflow_gen,
                ..Row::default()
            });
        }
        assert!(
            writer.sender.is_none(),
            "M-C SILENT-DROP: saturation must drop the sender once rather than keeping it open"
        );
        assert!(writer.is_saturation_disabled());
        assert_eq!(writer.saturation_disable_count(), 1);
        assert_eq!(
            writer.saturation_disable_marker(),
            Some(SATURATION_DISABLE_MARKER)
        );

        // Drain the first row from receiver so capacity exists in the channel, then submit
        // post-saturation rows: disable-once must reject them, whereas M-C SILENT-DROP would enqueue them.
        let first_retained = receiver.try_recv().unwrap();
        assert_eq!(first_retained.generation, 0);
        telemetry.on_drain(&first_retained.surface_id);
        for post_gen in 1000..1004_u64 {
            let cap = capsules[(post_gen as usize) % capsules.len()];
            writer.submit(Row {
                surface_id: cap.into(),
                generation: post_gen,
                ..Row::default()
            });
        }

        // Write all retained rows through write_row and verify truncation-free JSONL output.
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .unwrap();
        let mut out = BufWriter::new(file);
        let mut size = 0usize;
        let mut drained_count = 0usize;
        for row in std::iter::once(first_retained).chain(receiver.try_iter()) {
            let surface_id = row.surface_id.clone();
            let mut bytes = serde_json::to_vec(&row).unwrap();
            bytes.push(b'\n');
            write_row(&mut out, &mut size, &bytes).unwrap();
            if drained_count > 0 {
                telemetry.on_drain(&surface_id);
            }
            drained_count += 1;
        }
        out.flush().unwrap();
        assert_eq!(drained_count, QUEUE_CAPACITY);

        let raw = std::fs::read_to_string(&path).unwrap();
        let parsed: Vec<serde_json::Value> = raw
            .lines()
            .map(|line| serde_json::from_str(line).expect("truncation-free JSON row"))
            .collect();
        assert_eq!(parsed.len(), QUEUE_CAPACITY);
        for (idx, val) in parsed.iter().enumerate() {
            assert_eq!(val["generation"], idx as u64);
            assert_eq!(val["skipped_hash_ns"], 950);
            assert_eq!(val["hash_skipped"], idx >= 4);
            assert_eq!(val["parallel_wait_ns"], 250 * ((idx as u64) % 4));
            assert_eq!(val["surface_queue_depth"], ((idx as u64) / 4) + 1);
        }
        for cap in capsules {
            assert_eq!(writer.surface_queue_depth(cap), 0);
        }
    }
}
