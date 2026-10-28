//! [TARGET, unit decision] RAM host capture policy: at most 64 retained captures,
//! 8 active recordings, 8 MiB per ring, 64 MiB total retained pixel bytes,
//! max_fps ceiling 60 (default 3 fps) with period decimation in append_frame.
//! The serve owner journals a prepared transition before replacing this state.
use super::*;

const RING: u64 = 8 * 1024 * 1024;
const MEMORY: u64 = 64 * 1024 * 1024;
pub const MAX_FPS: u64 = 60;
pub const DEFAULT_FPS: u64 = 3;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Host {
    coordinator: Option<Coordinator>,
    rows: BTreeMap<String, Value>,
    pixels: BTreeMap<String, VecDeque<CapturedFrame>>,
    latest: BTreeMap<String, (FrameRef, Vec<u8>)>,
    dropped_frames: BTreeMap<String, u64>,
    max_fps: BTreeMap<String, u64>,
    last_frame_ms: BTreeMap<String, u64>,
    serial: u64,
    pub(crate) exports_recovered: bool,
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct CapturedFrame {
    frame: FrameRef,
    bytes: Vec<u8>,
}
#[derive(Default)]
struct Events(Vec<Value>);
impl JournalSink for Events {
    fn append(&mut self, record: &SessionRecord, events: &[RecordEvent]) -> Result<(), Error> {
        self.0.push(json!({"record":record,"events":events}));
        Ok(())
    }
}
impl Host {
    pub fn with_serial(serial: u64) -> Self {
        Self {
            serial,
            ..Self::default()
        }
    }
    fn initialize(&mut self, surfaces: BTreeSet<String>) -> Result<(), Error> {
        if self.coordinator.is_none() {
            let settings: Settings = serde_json::from_value(json!({
                "schema":"settings/v0.2","theme":"metaviewer-dark","providers":[],
                "recording_destination":null,"limits":{"memory_bytes":MEMORY,"ring_bytes":RING,"max_fps":MAX_FPS}
            })).map_err(|_| Error::Configuration)?;
            self.coordinator = Some(Coordinator::new(&settings, surfaces.clone())?);
        }
        self.coordinator
            .as_mut()
            .ok_or(Error::Configuration)?
            .surfaces = surfaces;
        Ok(())
    }
    /// Frame bytes have already passed the serve owner's pinned-file hash witness.
    /// Live frames are bounded too; a refused oversize frame never enters capture RAM.
    pub fn frame(
        &mut self,
        frame: &FrameRef,
        bytes: Vec<u8>,
        now_ms: u64,
    ) -> Result<Vec<Value>, Error> {
        if bytes.is_empty() || bytes.len() as u64 > RING || sha256_hex(&bytes) != frame.sha256 {
            return Err(Error::Event);
        }
        self.frame_verified(frame, bytes, now_ms)
    }
    pub(crate) fn has_active_recording(&self, surface_id: &str) -> bool {
        self.rows
            .values()
            .any(|r| r["surface_id"] == surface_id && r["phase"] == "recording")
    }
    pub(crate) fn frame_verified(
        &mut self,
        frame: &FrameRef,
        bytes: Vec<u8>,
        now_ms: u64,
    ) -> Result<Vec<Value>, Error> {
        if bytes.is_empty() || bytes.len() as u64 > RING {
            return Err(Error::Event);
        }
        // Preflight every clone together before changing latest, rows or the journal.
        let ids: Vec<String> = self
            .rows
            .iter()
            .filter(|(_, r)| r["surface_id"] == frame.surface_id && r["phase"] == "recording")
            .map(|(id, _)| id.clone())
            .collect();
        let old = self
            .latest
            .get(&frame.surface_id)
            .map_or(0, |(_, b)| b.len());
        let mut total = self
            .retained_bytes()?
            .checked_sub(old as u64)
            .and_then(|n| n.checked_add(bytes.len() as u64))
            .ok_or(Error::Overflow)?;
        for id in &ids {
            if !self.decimated(id, now_ms) {
                total = self.project_append(total, id, bytes.len())?;
            }
        }
        if total > MEMORY {
            return Err(Error::Overflow);
        }
        self.latest
            .insert(frame.surface_id.clone(), (frame.clone(), bytes));
        let mut events = Events::default();
        for id in ids {
            self.append_frame(&id, now_ms, &mut events)?;
        }
        Ok(events.0)
    }
    pub(crate) fn drop_frame(&mut self, surface_id: &str, now_ns: u64) -> Vec<Value> {
        let ids: Vec<String> = self
            .rows
            .iter()
            .filter(|(_, r)| {
                r["kind"] == "recording"
                    && r["phase"] == "recording"
                    && r["surface_id"] == surface_id
            })
            .map(|(id, _)| id.clone())
            .collect();
        ids.into_iter()
            .map(|id| {
                let count = self.dropped_frames.entry(id.clone()).or_default();
                *count = count.saturating_add(1);
                json!({
                    "events": [{
                        "schema": "record_event/v0.2",
                        "request_id": id,
                        "surface_id": surface_id,
                        "recording_id": id,
                        "mono_ns": now_ns,
                        "event": "dropped",
                        "dropped_frames": 1,
                        "policy": "ram_ring_oldest"
                    }]
                })
            })
            .collect()
    }
    // Include sealed captures: their pixels remain resident until reclaimed.
    pub(super) fn retained_bytes(&self) -> Result<u64, Error> {
        self.latest
            .values()
            .map(|(_, bytes)| bytes.len())
            .chain(self.pixels.values().flatten().map(|f| f.bytes.len()))
            .try_fold(0_u64, |sum, len| sum.checked_add(len as u64))
            .ok_or(Error::Overflow)
    }

    /// Project FIFO eviction without cloning pixels or mutating a ring.
    fn project_append(&self, total: u64, id: &str, len: usize) -> Result<u64, Error> {
        if len as u64 > RING {
            return Err(Error::Overflow);
        }
        let mut ring_bytes = self
            .pixels
            .get(id)
            .into_iter()
            .flatten()
            .try_fold(0_u64, |sum, f| sum.checked_add(f.bytes.len() as u64))
            .ok_or(Error::Overflow)?;
        let mut evicted = 0_u64;
        for f in self.pixels.get(id).into_iter().flatten() {
            if ring_bytes.checked_add(len as u64).ok_or(Error::Overflow)? <= RING {
                break;
            }
            ring_bytes = ring_bytes
                .checked_sub(f.bytes.len() as u64)
                .ok_or(Error::Overflow)?;
            evicted = evicted
                .checked_add(f.bytes.len() as u64)
                .ok_or(Error::Overflow)?;
        }
        total
            .checked_sub(evicted)
            .and_then(|n| n.checked_add(len as u64))
            .ok_or(Error::Overflow)
    }

    fn decimated(&self, id: &str, now_ms: u64) -> bool {
        self.max_fps
            .get(id)
            .zip(self.last_frame_ms.get(id))
            .is_some_and(|(&fps, &last_ms)| now_ms.saturating_sub(last_ms) < 1000 / fps)
    }

    fn append_frame(&mut self, id: &str, now_ms: u64, events: &mut Events) -> Result<(), Error> {
        if self.decimated(id, now_ms) {
            let count = self.dropped_frames.entry(id.to_owned()).or_default();
            *count = count.saturating_add(1);
            return Ok(());
        }
        let surface = self.rows[id]["surface_id"].as_str().ok_or(Error::Event)?;
        let (frame, bytes) = self.latest.get(surface).ok_or(Error::Event)?;
        if self.project_append(self.retained_bytes()?, id, bytes.len())? > MEMORY {
            return Err(Error::Overflow);
        }
        let event: RecordEvent = serde_json::from_value(json!({
            "schema":"record_event/v0.2","request_id":id,"surface_id":surface,"recording_id":id,
            "mono_ns":now_ms.saturating_mul(1_000_000),"event":"frame_captured","sha256":frame.sha256,
            "ram_path":frame.ramws_path,"byte_count":bytes.len()
        })).map_err(|_| Error::Event)?;
        self.coordinator
            .as_mut()
            .ok_or(Error::Configuration)?
            .observe(event, events)?;
        let ring = self.pixels.entry(id.to_owned()).or_default();
        let mut retained = ring
            .iter()
            .try_fold(0_u64, |sum, f| sum.checked_add(f.bytes.len() as u64))
            .ok_or(Error::Overflow)?;
        while retained
            .checked_add(bytes.len() as u64)
            .ok_or(Error::Overflow)?
            > RING
        {
            let oldest = ring.pop_front().ok_or(Error::Event)?;
            retained = retained
                .checked_sub(oldest.bytes.len() as u64)
                .ok_or(Error::Overflow)?;
        }
        ring.push_back(CapturedFrame {
            frame: frame.clone(),
            bytes: bytes.clone(),
        });
        self.last_frame_ms.insert(id.to_owned(), now_ms);
        let row = self.rows.get_mut(id).ok_or(Error::Event)?;
        row["frames"] = json!(ring.len());
        row["duration_ms"] =
            json!(now_ms.saturating_sub(row["created_ms"].as_u64().ok_or(Error::Event)?));
        Ok(())
    }
    /// Prepare a complete transition. Caller must durably journal `events` plus
    /// request/reply before installing the returned host. No pixels in the reply.
    pub fn prepare(
        &self,
        method: &str,
        req: &Value,
        surfaces: BTreeSet<String>,
        now_ms: u64,
    ) -> Result<(Self, Value, Vec<Value>), Error> {
        let mut next = self.clone();
        next.initialize(surfaces.clone())?;
        let request_id = req["request_id"].as_str().unwrap_or("");
        let refusal = |code| {
            (
                self.clone(),
                json!({"ok":false,"code":code,"request_id":request_id}),
                Vec::new(),
            )
        };
        if method == "list" {
            return Ok((
                next.clone(),
                json!({"ok":true,"rows":next.rows.values().collect::<Vec<_>>()}),
                vec![],
            ));
        }
        let surface = if method == "recordStop" {
            match req["recording_id"]
                .as_str()
                .and_then(|id| self.rows.get(id))
            {
                Some(row) if row["kind"] == "recording" && row["phase"] == "recording" => {
                    row["surface_id"].as_str().ok_or(Error::Event)?
                }
                _ => return Ok(refusal("NOT_RECORDING")),
            }
        } else {
            req["surface_id"].as_str().ok_or(Error::Event)?
        };
        if !surfaces.contains(surface) {
            return Ok(refusal("SURFACE_UNKNOWN"));
        }
        if method == "recordStart"
            && self
                .rows
                .values()
                .any(|r| r["surface_id"] == surface && r["phase"] == "recording")
        {
            return Ok(refusal("ALREADY_RECORDING"));
        }
        if method != "recordStop" {
            if !self.latest.contains_key(surface) {
                return Ok(refusal("CAPTURE_UNAVAILABLE"));
            }
            if self.rows.len() >= 64
                || (method == "recordStart"
                    && self
                        .rows
                        .values()
                        .filter(|r| r["phase"] == "recording")
                        .count()
                        >= 8)
            {
                return Ok(refusal("LIMIT"));
            }
        }
        if method != "recordStop" {
            let len = self.latest.get(surface).ok_or(Error::Event)?.1.len();
            // A fresh capture has an empty ring. Check before allocating an ID or events.
            if self
                .retained_bytes()?
                .checked_add(len as u64)
                .ok_or(Error::Overflow)?
                > MEMORY
            {
                return Ok(refusal("LIMIT"));
            }
        }
        let id = if method == "recordStop" {
            req["recording_id"].as_str().ok_or(Error::Event)?.to_owned()
        } else if let Some(id) = req["_host_id"].as_str() {
            if !valid_id(id) {
                return Err(Error::Event);
            }
            id.to_owned()
        } else {
            next.serial = next.serial.checked_add(1).ok_or(Error::Overflow)?;
            format!("capture-{}", next.serial)
        };
        let op = match method {
            "recordStart" => "ram_start",
            "recordStop" => "ram_stop",
            "screenshot" => "screenshot",
            _ => return Err(Error::Event),
        };
        let mut params = json!({"surface_id":surface});
        if method == "screenshot" {
            params["capture_id"] = id.clone().into();
        } else {
            params["recording_id"] = id.clone().into();
        }
        if method == "recordStart" {
            let fps = req["max_fps"].as_u64().unwrap_or(DEFAULT_FPS);
            params["ring_bytes"] = RING.into();
            params["max_fps"] = fps.into();
        }
        // Wire coordinator IDs are host generated; renderer correlation stays in the boundary witness.
        let request: RecordRequest = serde_json::from_value(
            json!({"schema":"record_request/v0.2","request_id":id,"op":op,"params":params}),
        )
        .map_err(|_| Error::Event)?;
        let mut events = Events::default();
        let result = next
            .coordinator
            .as_mut()
            .ok_or(Error::Configuration)?
            .handle(&request, now_ms.saturating_mul(1_000_000), &mut events)?;
        if let Some(refused) = result.iter().find_map(|e| match e {
            RecordEvent::Case5(r) => Some(r),
            _ => None,
        }) {
            let code = match refused.reason_code {
                RecordEventRefusal::BUDGETEXCEEDED => "BUDGET_EXCEEDED",
                _ => "POLICY",
            };
            return Ok((
                next,
                json!({"ok":false,"code":code,"request_id":request_id}),
                events.0,
            ));
        }
        let reply = if method == "recordStop" {
            let row = next.rows.get_mut(&id).ok_or(Error::Event)?;
            row["phase"] = "sealed".into();
            row["sealed"] = true.into();
            row["duration_ms"] =
                json!(now_ms.saturating_sub(row["created_ms"].as_u64().ok_or(Error::Event)?));
            let dropped = next.dropped_frames.get(&id).copied().unwrap_or(0);
            let bytes: Vec<u8> = next.pixels[&id]
                .iter()
                .flat_map(|f| f.bytes.iter().copied())
                .collect();
            json!({"ok":true,"recording":{"id":id,"surface_id":surface,"frames":row["frames"],"dropped_frames":dropped,"duration_ms":row["duration_ms"],"sealed":true,"sha256":sha256_hex(&bytes)}})
        } else {
            next.dropped_frames.insert(id.clone(), 0);
            if method == "recordStart" {
                if let Some(fps) = req["max_fps"].as_u64() {
                    next.max_fps.insert(id.clone(), fps);
                }
            }
            next.rows.insert(id.clone(),json!({"id":id,"kind":if method=="screenshot"{"shot"}else{"recording"},"surface_id":surface,"phase":"recording","frames":0,"duration_ms":0,"sealed":false,"created_ms":now_ms}));
            next.append_frame(&id, now_ms, &mut events)?;
            if method == "screenshot" {
                next.rows.get_mut(&id).ok_or(Error::Event)?["phase"] = "sealed".into();
                next.rows.get_mut(&id).ok_or(Error::Event)?["sealed"] = true.into();
                let frame = &next.latest[surface].0;
                json!({"ok":true,"shot":{"id":id,"surface_id":surface,"width":frame.width,"height":frame.height,"sha256":frame.sha256,"created_ms":now_ms}})
            } else {
                json!({"ok":true,"recording_id":id})
            }
        };
        Ok((next, reply, events.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn frame(surface: &str) -> FrameRef {
        let mut value: Value = serde_json::from_str(include_str!(
            "../../../contracts/examples/v0.2/frame_ref.valid.json"
        ))
        .unwrap();
        value["surface_id"] = surface.into();
        value["sha256"] = sha256_hex(b"pixels").into();
        serde_json::from_value(value).unwrap()
    }
    fn request(surface: &str) -> Value {
        json!({"schema":"capture_request/v1","request_id":"request","surface_id":surface,"mode":"ai"})
    }
    #[test]
    fn captures_pixels_seals_and_refuses_duplicates() {
        let mut host = Host::default();
        let surfaces = BTreeSet::from(["surface-demo".to_owned()]);
        assert_eq!(
            host.prepare("screenshot", &request("unknown"), surfaces.clone(), 0)
                .unwrap()
                .1["code"],
            "SURFACE_UNKNOWN"
        );
        assert_eq!(
            host.prepare("screenshot", &request("surface-demo"), surfaces.clone(), 0)
                .unwrap()
                .1["code"],
            "CAPTURE_UNAVAILABLE"
        );
        host.frame(&frame("surface-demo"), b"pixels".to_vec(), 0)
            .unwrap();
        let (mut host, reply, events) = host
            .prepare(
                "recordStart",
                &request("surface-demo"),
                surfaces.clone(),
                10,
            )
            .unwrap();
        assert!(!events.is_empty());
        let id = reply["recording_id"].as_str().unwrap().to_owned();
        assert_eq!(
            host.prepare(
                "recordStart",
                &request("surface-demo"),
                surfaces.clone(),
                11
            )
            .unwrap()
            .1["code"],
            "ALREADY_RECORDING"
        );
        host.frame(&frame("surface-demo"), b"pixels".to_vec(), 20)
            .unwrap();
        let stop = json!({"request_id":"stop","recording_id":id});
        let (host, reply, events) = host
            .prepare("recordStop", &stop, surfaces.clone(), 30)
            .unwrap();
        assert!(!events.is_empty());
        assert_eq!(reply["recording"]["frames"], 2);
        assert_eq!(reply["recording"]["duration_ms"], 20);
        assert_eq!(reply["recording"]["sha256"], sha256_hex(b"pixelspixels"));
        assert_eq!(
            host.prepare("recordStop", &stop, surfaces.clone(), 31)
                .unwrap()
                .1["code"],
            "NOT_RECORDING"
        );
        let (_, shot, _) = host
            .prepare("screenshot", &request("surface-demo"), surfaces.clone(), 40)
            .unwrap();
        assert_eq!(shot["shot"]["sha256"], sha256_hex(b"pixels"));
        assert!(!shot.to_string().contains("ram_path"));
        assert_eq!(
            host.prepare("list", &Value::Null, surfaces, 50).unwrap().1["rows"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
    #[test]
    fn cap_and_invalid_witness_are_negative_controls() {
        let mut host = Host::default();
        let mut surfaces = BTreeSet::new();
        for index in 0..9 {
            let id = format!("surface-{index}");
            surfaces.insert(id.clone());
            host.frame(&frame(&id), b"pixels".to_vec(), 0).unwrap();
        }
        for index in 0..8 {
            let (next, reply, _) = host
                .prepare(
                    "recordStart",
                    &request(&format!("surface-{index}")),
                    surfaces.clone(),
                    0,
                )
                .unwrap();
            assert_eq!(reply["ok"], true);
            host = next;
        }
        assert_eq!(
            host.prepare("recordStart", &request("surface-8"), surfaces, 0)
                .unwrap()
                .1["code"],
            "LIMIT"
        );
        assert_eq!(
            host.frame(&frame("surface-8"), b"wrong".to_vec(), 0),
            Err(Error::Event)
        );
    }
    #[test]
    fn latest_frame_replacement_respects_exact_64_mib_cap_and_refuses_off_by_one() {
        const MIB: usize = 1024 * 1024;
        let mut host = Host::default();
        let surfaces: BTreeSet<String> = (0..5).map(|i| format!("surface-{i}")).collect();
        for i in 0..4 {
            let id = format!("surface-{i}");
            let bytes = vec![i as u8 + 1; 7 * MIB];
            host.frame_verified(&frame(&id), bytes, 0).unwrap();
            let (next, reply, _) = host
                .prepare("recordStart", &request(&id), surfaces.clone(), 0)
                .unwrap();
            assert_eq!(reply["ok"], true);
            host = next;
        }
        // 4 surfaces * (7 MiB latest + 7 MiB ring) = 56 MiB retained.
        assert_eq!(host.retained_bytes().unwrap(), (56 * MIB) as u64);
        let s4_initial = vec![5_u8; 4 * MIB];
        host.frame_verified(&frame("surface-4"), s4_initial, 1)
            .unwrap();
        assert_eq!(host.retained_bytes().unwrap(), (60 * MIB) as u64);

        // Replace latest on surface-4 with 6 MiB -> total = 62 MiB.
        let s4_six = vec![7_u8; 6 * MIB];
        host.frame_verified(&frame("surface-4"), s4_six, 2).unwrap();
        assert_eq!(host.retained_bytes().unwrap(), (62 * MIB) as u64);

        // Replace latest on surface-0 (which has an active 7 MiB ring) with 8 MiB ->
        // old latest (7 MiB) replaced by 8 MiB (+1 MiB), old ring (7 MiB) evicted and replaced by 8 MiB (+1 MiB),
        // bringing total retained bytes to 62 MiB + 2 MiB == 64 MiB == MEMORY.
        let s0_exact = vec![8_u8; 8 * MIB];
        host.frame_verified(&frame("surface-0"), s0_exact, 3)
            .unwrap();
        assert_eq!(host.retained_bytes().unwrap(), MEMORY);

        // Negative control: replace latest on surface-4 (currently 6 MiB) with 6 MiB + 1 byte ->
        // total == MEMORY + 1, which must be refused with Error::Overflow and leave state unchanged.
        let before = host.clone();
        let s4_over = vec![9_u8; 6 * MIB + 1];
        assert_eq!(
            host.frame_verified(&frame("surface-4"), s4_over, 4),
            Err(Error::Overflow)
        );
        assert_eq!(host, before);
        assert_eq!(host.retained_bytes().unwrap(), MEMORY);
    }

    #[test]
    fn rec_61_refused_budget() {
        let mut host = Host::default();
        let surfaces = BTreeSet::from(["surface-demo".to_owned()]);
        host.frame(&frame("surface-demo"), b"pixels".to_vec(), 0)
            .unwrap();
        // Negative control: 60 fps is within the raised Host ceiling and succeeds.
        let (ok_host, ok_reply, ok_events) = host
            .prepare(
                "recordStart",
                &json!({"schema":"capture_request/v1","request_id":"req-60","surface_id":"surface-demo","mode":"ai","max_fps":60}),
                surfaces.clone(),
                0,
            )
            .unwrap();
        assert_eq!(ok_reply["ok"], true);
        assert!(!ok_events.is_empty());
        assert_eq!(ok_events[0]["events"][0]["event"], "started");
        drop(ok_host);

        // 61 fps exceeds Host limits.max_fps (60) and must be refused with BUDGET_EXCEEDED.
        let (refused_host, reply, events) = host
            .prepare(
                "recordStart",
                &json!({"schema":"capture_request/v1","request_id":"req-61","surface_id":"surface-demo","mode":"ai","max_fps":61}),
                surfaces,
                0,
            )
            .unwrap();
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["code"], "BUDGET_EXCEEDED");
        assert_eq!(events[0]["events"][0]["event"], "refused");
        assert_eq!(events[0]["events"][0]["reason_code"], "BUDGET_EXCEEDED");
        assert!(refused_host.rows.is_empty());
    }

    #[test]
    fn rec_decimates_to_period() {
        let mut host = Host::default();
        let surfaces = BTreeSet::from(["surface-demo".to_owned()]);
        let frame_with = |byte: u8| -> (FrameRef, Vec<u8>) {
            let bytes = vec![byte; 3];
            let mut value: Value = serde_json::from_str(include_str!(
                "../../../contracts/examples/v0.2/frame_ref.valid.json"
            ))
            .unwrap();
            value["surface_id"] = "surface-demo".into();
            value["sha256"] = sha256_hex(&bytes).into();
            (serde_json::from_value(value).unwrap(), bytes)
        };
        let (f0, b0) = frame_with(1);
        host.frame(&f0, b0, 0).unwrap();
        // Start at 3 fps (period = 1000 / 3 = 333 ms); initial frame at t=0 is kept.
        let (mut host, start_reply, _) = host
            .prepare(
                "recordStart",
                &json!({"schema":"capture_request/v1","request_id":"req-dec","surface_id":"surface-demo","mode":"ai","max_fps":3}),
                surfaces.clone(),
                0,
            )
            .unwrap();
        assert_eq!(start_reply["ok"], true);
        let rec_id = start_reply["recording_id"].as_str().unwrap().to_owned();

        // Over-rate frames at 100 ms and 332 ms (< 333 ms since t=0) must be dropped.
        for (t, byte) in [(100_u64, 2_u8), (332, 3)] {
            let (f, b) = frame_with(byte);
            let ev = host.frame(&f, b, t).unwrap();
            assert!(ev.is_empty(), "frame at {t} ms must be decimated");
        }
        // Frame at 333 ms (>= 333 ms since t=0) must be kept.
        let (f3, b3) = frame_with(4);
        let ev3 = host.frame(&f3, b3, 333).unwrap();
        assert_eq!(ev3.len(), 1, "frame at 333 ms must be kept");

        // Frame at 500 ms (167 ms since last kept at 333 ms) must be dropped.
        let (f4, b4) = frame_with(5);
        let ev4 = host.frame(&f4, b4, 500).unwrap();
        assert!(ev4.is_empty(), "frame at 500 ms must be decimated");

        // Frame at 666 ms (333 ms since last kept at 333 ms) must be kept.
        let (f5, b5) = frame_with(6);
        let ev5 = host.frame(&f5, b5, 666).unwrap();
        assert_eq!(ev5.len(), 1, "frame at 666 ms must be kept");

        let (_, stop_reply, _) = host
            .prepare(
                "recordStop",
                &json!({"request_id":"stop-dec","recording_id":rec_id}),
                surfaces,
                700,
            )
            .unwrap();
        assert_eq!(stop_reply["ok"], true);
        assert_eq!(stop_reply["recording"]["frames"], 3);
        assert_eq!(stop_reply["recording"]["dropped_frames"], 3);
        let expected_bytes = [vec![1_u8; 3], vec![4_u8; 3], vec![6_u8; 3]].concat();
        assert_eq!(
            stop_reply["recording"]["sha256"],
            sha256_hex(&expected_bytes)
        );
    }
}

pub(crate) mod export;
