//! Pure frozen catalog authority; no processes or filesystem access.
//! [TARGET, unit decision] Admission supplies exact (kind, profile_id), a fresh
//! surface id, frozen window geometry and requested depth. Host configuration
//! supplies entries and launch targets. Terminal surface ids remain reserved.
mod decode;
mod launch;
pub use decode::{decode_entry, CatalogEntryWire, Limits};
pub use launch::{LaunchSpec, LaunchTarget, Registration};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Browser,
    Program,
    Vm,
    GameCapsule,
    DesktopCapsule,
}
impl Kind {
    pub fn parse(value: &str) -> Result<Self, CatalogError> {
        match value {
            "browser" => Ok(Self::Browser),
            "program" => Ok(Self::Program),
            "vm" => Ok(Self::Vm),
            "game_capsule" => Ok(Self::GameCapsule),
            "desktop_capsule" => Ok(Self::DesktopCapsule),
            _ => Err(CatalogError::UnknownKind),
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Network {
    None,
    Proxy,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CatalogError {
    Wire(crate::wire::DecodeError),
    InvalidEntry,
    InvalidProfile,
    NestedDepth,
    NestedPolicy,
    InvalidTarget,
    DuplicateEntry,
    DuplicateProfile,
    UnknownKind,
    UnregisteredProfile,
    Geometry,
    InvalidSurfaceId,
    SurfaceIdUsed,
    SurfaceNotLive,
}
impl std::fmt::Display for CatalogError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for CatalogError {}
impl CatalogError {
    pub fn surface_event(self, surface_id: &str) -> crate::wire::payload::SurfaceEvent {
        use crate::wire::payload::*;
        SurfaceEvent::Case4(Box::new(SurfaceEventCase4 {
            schema: SurfaceEventCase0Schema::Value,
            event: SurfaceEventCase4Event::Value,
            data: SurfaceEventCase4Data {
                surface_id: surface_id.into(),
                code: "POLICY".into(),
                detail: self.to_string(),
            },
        }))
    }
}
// Validated types deliberately have no Deserialize implementation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct CatalogEntry(CatalogEntryWire);
impl CatalogEntry {
    pub fn projection(&self) -> &CatalogEntryWire {
        &self.0
    }
}
impl TryFrom<CatalogEntryWire> for CatalogEntry {
    type Error = CatalogError;
    fn try_from(row: CatalogEntryWire) -> Result<Self, Self::Error> {
        if row.schema != "catalog_entry/v0.2"
            || !valid_id(&row.entry_id)
            || !valid_id(&row.profile_id)
            || !valid_text(&row.label)
            || !valid_text(&row.image)
            || !(1..=1_073_741_824).contains(&row.limits.memory_bytes)
            || !(1..=20_000).contains(&row.limits.cpu_milli)
        {
            return Err(CatalogError::InvalidEntry);
        }
        if matches!(row.kind, Kind::Browser | Kind::Program | Kind::Vm)
            && !valid_identity(&row.profile_id)
        {
            return Err(CatalogError::InvalidProfile);
        }
        if [
            row.window_width_px,
            row.window_height_px,
            row.display_width_px,
            row.display_height_px,
        ]
        .iter()
        .any(|n| !(1..=16384).contains(n))
            || row.window_width_px > row.display_width_px
            || row.window_height_px > row.display_height_px
        {
            return Err(CatalogError::Geometry);
        }
        if row.nested_depth > 1 {
            return Err(CatalogError::NestedDepth);
        }
        if (row.nested_depth == 1 || row.entry_id == "metaviewer-nested")
            && (row.entry_id != "metaviewer-nested"
                || row.kind != Kind::Program
                || row.nested_depth != 1
                || !row.display_only
                || row.network != Network::None
                || !row.seccomp_identity
                || row.image != "opensuperficies-program-electron-arm64:0.1.0"
                || (
                    row.window_width_px,
                    row.window_height_px,
                    row.display_width_px,
                    row.display_height_px,
                ) != (1280, 720, 1280, 900))
        {
            return Err(CatalogError::NestedPolicy);
        }
        Ok(Self(row))
    }
}
fn valid_id(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}
fn valid_identity(value: &str) -> bool {
    (2..=48).contains(&value.len())
        && value
            .as_bytes()
            .first()
            .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
fn valid_text(value: &str) -> bool {
    value.len() <= 256 && !value.trim().is_empty()
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CatalogRegistry {
    entries: BTreeMap<String, Registration>,
    profiles: BTreeMap<(Kind, String), String>,
    surfaces: BTreeMap<String, SurfaceState>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SurfaceState {
    Live,
    Destroyed,
    Lost,
}
#[derive(Clone, Copy, Debug)]
pub struct CreateRequest<'a> {
    pub surface_id: &'a str,
    pub kind: &'a str,
    pub profile_id: &'a str,
    pub width_px: u32,
    pub height_px: u32,
    pub nested_depth: u32,
}
impl<'a> CreateRequest<'a> {
    /// Converts the admitted transport DTO; program awaits its contract update.
    pub fn from_surface_request(
        surface_id: &'a str,
        params: &'a crate::wire::payload::SurfaceRequestCase0Params,
        nested_depth: u32,
    ) -> Result<Self, CatalogError> {
        use crate::wire::payload::SurfaceKind;
        let kind = match params.kind {
            SurfaceKind::Browser => "browser",
            SurfaceKind::DesktopCapsule => "desktop_capsule",
            SurfaceKind::GameCapsule => "game_capsule",
            SurfaceKind::Vm => "vm",
        };
        Ok(Self {
            surface_id,
            kind,
            profile_id: &params.profile_id,
            width_px: u32::try_from(params.geometry.w).map_err(|_| CatalogError::Geometry)?,
            height_px: u32::try_from(params.geometry.h).map_err(|_| CatalogError::Geometry)?,
            nested_depth,
        })
    }
}
impl CatalogRegistry {
    pub fn new(entries: Vec<Registration>) -> Result<Self, CatalogError> {
        let mut registry = Self {
            entries: BTreeMap::new(),
            profiles: BTreeMap::new(),
            surfaces: BTreeMap::new(),
        };
        for registration in entries {
            let row = registration.entry.projection();
            if registry.entries.contains_key(&row.entry_id) {
                return Err(CatalogError::DuplicateEntry);
            }
            let pair = (row.kind, row.profile_id.clone());
            if registry.profiles.contains_key(&pair) {
                return Err(CatalogError::DuplicateProfile);
            }
            registry.profiles.insert(pair, row.entry_id.clone());
            registry.entries.insert(row.entry_id.clone(), registration);
        }
        Ok(registry)
    }
    pub fn projections(&self) -> Vec<CatalogEntry> {
        self.entries.values().map(|r| r.entry.clone()).collect()
    }
    pub fn state(&self, surface_id: &str) -> Option<SurfaceState> {
        self.surfaces.get(surface_id).copied()
    }
    pub fn validate_create(
        &self,
        request: CreateRequest<'_>,
    ) -> Result<&Registration, CatalogError> {
        if !valid_id(request.surface_id) {
            return Err(CatalogError::InvalidSurfaceId);
        }
        if self.surfaces.contains_key(request.surface_id) {
            return Err(CatalogError::SurfaceIdUsed);
        }
        let kind = Kind::parse(request.kind)?;
        if request.nested_depth > 1 {
            return Err(CatalogError::NestedDepth);
        }
        let id = self
            .profiles
            .get(&(kind, request.profile_id.into()))
            .ok_or(CatalogError::UnregisteredProfile)?;
        let registration = &self.entries[id];
        let row = registration.entry.projection();
        if request.nested_depth != row.nested_depth {
            return Err(CatalogError::NestedDepth);
        }
        if (request.width_px, request.height_px) != (row.window_width_px, row.window_height_px) {
            return Err(CatalogError::Geometry);
        }
        Ok(registration)
    }
    pub fn create(&mut self, request: CreateRequest<'_>) -> Result<LaunchSpec, CatalogError> {
        let spec = self.validate_create(request)?.launch_spec();
        self.surfaces
            .insert(request.surface_id.into(), SurfaceState::Live);
        Ok(spec)
    }
    pub fn destroy(&mut self, surface_id: &str) -> Result<(), CatalogError> {
        self.finish(surface_id, SurfaceState::Destroyed)
    }
    pub fn mark_lost(&mut self, surface_id: &str) -> Result<(), CatalogError> {
        self.finish(surface_id, SurfaceState::Lost)
    }
    fn finish(&mut self, surface_id: &str, terminal: SurfaceState) -> Result<(), CatalogError> {
        if self.state(surface_id) != Some(SurfaceState::Live) {
            return Err(CatalogError::SurfaceNotLive);
        }
        self.surfaces.insert(surface_id.into(), terminal);
        Ok(())
    }
}
