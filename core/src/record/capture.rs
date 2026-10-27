//! [TARGET, unit decision] RAM host capture policy: at most 64 retained captures,
//! 8 active recordings, 8 MiB per ring, 64 MiB total retained pixel bytes.
//! The serve owner journals a prepared transition before replacing this state.
use super::*;

const RING: u64 = 8 * 1024 * 1024;
const MEMORY: u64 = 64 * 1024 * 1024;

#[derive(Clone, Default)]
pub struct Host {
    coordinator: Option<Coordinator>,
    rows: BTreeMap<String, Value>,
    pixels: BTreeMap<String, VecDeque<CapturedFrame>>,
    latest: BTreeMap<String, (FrameRef, Vec<u8>)>,
    serial: u64,
    pub(crate) exports_recovered: bool,
}
#[derive(Clone)]
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
                "recording_destination":null,"limits":{"memory_bytes":MEMORY,"ring_bytes":RING,"max_fps":30}
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
        let existing: usize = self
            .latest
            .iter()
            .filter(|(id, _)| *id != &frame.surface_id)
            .map(|(_, (_, bytes))| bytes.len())
            .sum();
        if existing + bytes.len() > MEMORY as usize {
            return Err(Error::Overflow);
        }
        self.latest
            .insert(frame.surface_id.clone(), (frame.clone(), bytes));
        let ids: Vec<String> = self
            .rows
            .iter()
            .filter(|(_, r)| r["surface_id"] == frame.surface_id && r["phase"] == "recording")
            .map(|(id, _)| id.clone())
            .collect();
        let mut events = Events::default();
        for id in ids {
            self.append_frame(&id, now_ms, &mut events)?;
        }
        Ok(events.0)
    }
    fn append_frame(&mut self, id: &str, now_ms: u64, events: &mut Events) -> Result<(), Error> {
        let surface = self.rows[id]["surface_id"].as_str().ok_or(Error::Event)?;
        let (frame, bytes) = self.latest.get(surface).ok_or(Error::Event)?;
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
        while ring.iter().map(|f| f.bytes.len()).sum::<usize>() + bytes.len() > RING as usize {
            ring.pop_front();
        }
        ring.push_back(CapturedFrame {
            frame: frame.clone(),
            bytes: bytes.clone(),
        });
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
            params["ring_bytes"] = RING.into();
            params["max_fps"] = 30.into();
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
        if result.iter().any(|e| matches!(e, RecordEvent::Case5(_))) {
            return Ok(refusal("LIMIT"));
        }
        let reply = if method == "recordStop" {
            let row = next.rows.get_mut(&id).ok_or(Error::Event)?;
            row["phase"] = "sealed".into();
            row["sealed"] = true.into();
            row["duration_ms"] =
                json!(now_ms.saturating_sub(row["created_ms"].as_u64().ok_or(Error::Event)?));
            let bytes: Vec<u8> = next.pixels[&id]
                .iter()
                .flat_map(|f| f.bytes.iter().copied())
                .collect();
            json!({"ok":true,"recording":{"id":id,"surface_id":surface,"frames":row["frames"],"duration_ms":row["duration_ms"],"sealed":true,"sha256":sha256_hex(&bytes)}})
        } else {
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
}

pub(crate) mod export;
