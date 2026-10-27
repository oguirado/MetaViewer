// [TARGET, unit decision] Minimal hosted handoff: launcher kinds resolve to
// these explicit catalog registrations. Native CLI launch is outside this test.
use metaviewer_core::catalog::*;
use serde_json::{json, Value};

fn main() {
    let root = std::path::PathBuf::from(std::env::args().nth(1).unwrap());
    let intents: Vec<Value> =
        serde_json::from_slice(&std::fs::read(root.join("launcher-intents.json")).unwrap())
            .unwrap();
    let cases = [
        ("identity-browser", Kind::Browser, LaunchTarget::Browser),
        (
            "program",
            Kind::Program,
            LaunchTarget::Program {
                program: "notepad".into(),
            },
        ),
        (
            "holdings-app",
            Kind::GameCapsule,
            LaunchTarget::Game {
                app_dir: root.join("fixture-holdings").to_string_lossy().into_owned(),
                slots: 1,
            },
        ),
        (
            "desktop",
            Kind::DesktopCapsule,
            LaunchTarget::Desktop {
                class: "fixture-desktop".into(),
                slot: 1,
            },
        ),
    ];
    let registrations = cases
        .iter()
        .map(|(name, kind, target)| {
            let wire = CatalogEntryWire {
                schema: "catalog_entry/v0.2".into(),
                entry_id: format!("launcher-{name}"),
                kind: *kind,
                profile_id: format!("profile-{name}"),
                label: name.to_string(),
                image: "fixture-image".into(),
                window_width_px: 1280,
                window_height_px: 900,
                display_width_px: 1280,
                display_height_px: 900,
                display_only: false,
                network: Network::None,
                seccomp_identity: true,
                nested_depth: 0,
                limits: Limits {
                    memory_bytes: 268435456,
                    cpu_milli: 2000,
                },
            };
            Registration::new(CatalogEntry::try_from(wire).unwrap(), target.clone()).unwrap()
        })
        .collect();
    let mut registry = CatalogRegistry::new(registrations).unwrap();
    let mut results = Vec::new();
    for intent in intents {
        assert_eq!(intent["type"], "create-capsule");
        assert_eq!(intent["placement"], "tab");
        let name = intent["kind"].as_str().unwrap();
        let (_, kind, _) = cases
            .iter()
            .find(|(candidate, _, _)| *candidate == name)
            .unwrap();
        let wire_kind = serde_json::to_value(kind).unwrap();
        let profile = format!("profile-{name}");
        let original = format!("launcher-{name}-old");
        let fresh = format!("launcher-{name}-new");
        let request = |id| CreateRequest {
            surface_id: id,
            kind: wire_kind.as_str().unwrap(),
            profile_id: &profile,
            width_px: 1280,
            height_px: 900,
            nested_depth: 0,
        };
        let spec = registry.create(request(&original)).unwrap();
        registry.destroy(&original).unwrap();
        assert_eq!(
            registry.create(request(&original)),
            Err(CatalogError::SurfaceIdUsed)
        );
        assert_eq!(
            registry.destroy(&original),
            Err(CatalogError::SurfaceNotLive)
        );
        registry.create(request(&fresh)).unwrap();
        assert_ne!(registry.state(&original), registry.state(&fresh));
        registry.destroy(&fresh).unwrap();
        results.push(json!({"kind":name,"original":original,"fresh":fresh,
            "binary":spec.binary,"old_id_refused":true}));
    }
    println!("{}", serde_json::to_string(&results).unwrap());
}
