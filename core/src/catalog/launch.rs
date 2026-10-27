use super::{valid_id, CatalogEntry, CatalogEntryWire, CatalogError, Kind, Limits, Network};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LaunchTarget {
    Browser,
    Program { program: String },
    Vm { program: String },
    Game { app_dir: String, slots: u8 },
    Desktop { class: String, slot: u16 },
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Registration {
    pub(super) entry: CatalogEntry,
    target: LaunchTarget,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LaunchSpec {
    /// Resolve this basename through the adapter's configured binary directory.
    pub binary: &'static str,
    pub args: Vec<String>,
    /// Documented in-capsule argv, resolved by the upstream program catalog.
    pub inner_argv: Vec<String>,
}
impl Registration {
    pub fn new(entry: CatalogEntry, target: LaunchTarget) -> Result<Self, CatalogError> {
        let row = entry.projection();
        let valid = match (&row.kind, &target) {
            (Kind::Browser, LaunchTarget::Browser) => true,
            (Kind::Program, LaunchTarget::Program { program }) => {
                (row.entry_id == "metaviewer-nested" && program == "metaviewer-nested")
                    || (row.entry_id != "metaviewer-nested" && program == "notepad")
            }
            (Kind::Vm, LaunchTarget::Vm { program }) => program == "notepad-vm",
            (Kind::GameCapsule, LaunchTarget::Game { app_dir, slots }) => {
                std::path::Path::new(app_dir).is_absolute()
                    && !app_dir.contains('\0')
                    && (1..=4).contains(slots)
                    && (
                        row.window_width_px,
                        row.window_height_px,
                        row.display_width_px,
                        row.display_height_px,
                    ) == (1280, 900, 1280, 900)
            }
            (Kind::DesktopCapsule, LaunchTarget::Desktop { class, slot }) => {
                valid_id(class) && *slot > 0
            }
            _ => false,
        };
        if !valid {
            return Err(CatalogError::InvalidTarget);
        }
        Ok(Self { entry, target })
    }
    pub fn entry(&self) -> &CatalogEntry {
        &self.entry
    }
    pub fn launch_spec(&self) -> LaunchSpec {
        let row = self.entry.projection();
        let (binary, args): (&str, Vec<String>) = match &self.target {
            LaunchTarget::Browser => (
                "srf-identity-surface",
                identity_args("browser", &row.profile_id, None),
            ),
            LaunchTarget::Program { program } => (
                "srf-identity-surface",
                identity_args("program", &row.profile_id, Some(program)),
            ),
            LaunchTarget::Vm { program } => (
                "srf-identity-surface",
                identity_args("vm", &row.profile_id, Some(program)),
            ),
            LaunchTarget::Game { app_dir, slots } => (
                "srf-holdings-capsule",
                vec![
                    "start".into(),
                    "--slots".into(),
                    slots.to_string(),
                    "--app".into(),
                    app_dir.clone(),
                ],
            ),
            LaunchTarget::Desktop { class, slot } => (
                "srf-capsula-desktop",
                vec![
                    "iniciar".into(),
                    "--clase".into(),
                    class.clone(),
                    "--slot".into(),
                    slot.to_string(),
                    "--json".into(),
                ],
            ),
        };
        let inner_argv = if row.entry_id == "metaviewer-nested" {
            [
                "metaviewer",
                "--nested-depth=1",
                "--user-data-dir=/profile/app",
                "--ozone-platform=x11",
            ]
            .map(String::from)
            .to_vec()
        } else {
            Vec::new()
        };
        LaunchSpec {
            binary,
            args,
            inner_argv,
        }
    }
    /// Host provides a separate synthetic identity and explicit resource limits.
    pub fn nested(profile_id: &str, limits: Limits) -> Result<Self, CatalogError> {
        let entry = CatalogEntry::try_from(CatalogEntryWire {
            schema: "catalog_entry/v0.2".into(),
            entry_id: "metaviewer-nested".into(),
            kind: Kind::Program,
            profile_id: profile_id.into(),
            label: "Nested MetaViewer".into(),
            image: "opensuperficies-program-electron-arm64:0.1.0".into(),
            window_width_px: 1280,
            window_height_px: 720,
            display_width_px: 1280,
            display_height_px: 900,
            display_only: true,
            network: Network::None,
            seccomp_identity: true,
            nested_depth: 1,
            limits,
        })?;
        Self::new(
            entry,
            LaunchTarget::Program {
                program: "metaviewer-nested".into(),
            },
        )
    }
}
fn identity_args(kind: &str, profile: &str, program: Option<&str>) -> Vec<String> {
    let mut args = [
        "start",
        "--kind",
        kind,
        "--identity",
        profile,
        "--windows",
        "1",
    ]
    .map(String::from)
    .to_vec();
    if let Some(program) = program {
        args.extend(["--program".into(), program.into()]);
    }
    args
}
