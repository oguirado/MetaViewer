use metaviewer_core::catalog::*;
use metaviewer_core::wire::{payload, DecodeError, MAX_ENVELOPE_BYTES};
use serde_json::{json, Value};

fn row(kind: Kind) -> CatalogEntryWire {
    CatalogEntryWire {
        schema: "catalog_entry/v0.2".into(),
        entry_id: "synthetic".into(),
        kind,
        profile_id: "synthetic-profile".into(),
        label: "Synthetic capsule".into(),
        image: "synthetic:1".into(),
        window_width_px: 1280,
        window_height_px: 900,
        display_width_px: 1280,
        display_height_px: 900,
        display_only: false,
        network: Network::None,
        seccomp_identity: true,
        nested_depth: 0,
        limits: Limits {
            memory_bytes: 1_073_741_824,
            cpu_milli: 20_000,
        },
    }
}
fn registration(kind: Kind) -> Registration {
    let target = match kind {
        Kind::Browser => LaunchTarget::Browser,
        Kind::Program => LaunchTarget::Program {
            program: "notepad".into(),
        },
        Kind::Vm => LaunchTarget::Vm {
            program: "notepad-vm".into(),
        },
        Kind::GameCapsule => LaunchTarget::Game {
            app_dir: "/synthetic/app".into(),
            slots: 1,
        },
        Kind::DesktopCapsule => LaunchTarget::Desktop {
            class: "desktop".into(),
            slot: 1,
        },
    };
    Registration::new(CatalogEntry::try_from(row(kind)).unwrap(), target).unwrap()
}
fn request() -> CreateRequest<'static> {
    CreateRequest {
        surface_id: "surface-1",
        kind: "browser",
        profile_id: "synthetic-profile",
        width_px: 1280,
        height_px: 900,
        nested_depth: 0,
    }
}
fn registry() -> CatalogRegistry {
    CatalogRegistry::new(vec![registration(Kind::Browser)]).unwrap()
}
fn refused(reg: &mut CatalogRegistry, req: CreateRequest<'_>, error: CatalogError) {
    let before = reg.clone();
    assert_eq!(reg.create(req), Err(error));
    assert_eq!(*reg, before);
    let event = serde_json::to_value(error.surface_event(req.surface_id)).unwrap();
    assert_eq!(
        event,
        json!({"schema":"surface_event/v0.2", "event":"error", "data":{"surface_id":req.surface_id,"code":"POLICY","detail":error.to_string()}})
    );
}

#[test]
fn closed_decode_and_schema_projection() {
    let reg = registry();
    let before = reg.clone();
    let raw = serde_json::to_string(&row(Kind::Browser)).unwrap();
    let entry = decode_entry(&raw).unwrap();
    assert_eq!(
        serde_json::to_value(&entry).unwrap(),
        serde_json::to_value(row(Kind::Browser)).unwrap()
    );
    assert_eq!(
        serde_json::to_value(&entry)
            .unwrap()
            .as_object()
            .unwrap()
            .len(),
        15
    );
    for (key, value) in [
        ("unknown", json!(true)),
        ("schema", json!("catalog_entry/v9")),
        ("kind", json!("unknown")),
        ("window_width", json!(10)),
    ] {
        let mut altered: Value = serde_json::from_str(&raw).unwrap();
        altered[key] = value;
        assert!(decode_entry(&altered.to_string()).is_err(), "{key}");
        assert_eq!(reg, before);
    }
    assert_eq!(
        decode_entry(&raw.replacen('{', "{\"schema\":\"catalog_entry/v0.2\",", 1)),
        Err(CatalogError::Wire(DecodeError::DuplicateField))
    );
    assert_eq!(
        decode_entry(&raw.replace(
            "\"cpu_milli\":20000",
            "\"cpu_milli\":20000,\"cpu_milli\":20000"
        )),
        Err(CatalogError::Wire(DecodeError::DuplicateField))
    );
    for altered in [
        raw.replace("\"cpu_milli\":20000", "\"cpu_milli\":20000,\"extra\":0"),
        raw.replace("\"nested_depth\":0", "\"nested_depth\":-1"),
        raw.replace("\"nested_depth\":0", "\"nested_depth\":0.5"),
    ] {
        assert!(decode_entry(&altered).is_err());
        assert_eq!(reg, before);
    }
    for key in serde_json::to_value(&entry)
        .unwrap()
        .as_object()
        .unwrap()
        .keys()
    {
        let mut missing = serde_json::to_value(&entry).unwrap();
        missing.as_object_mut().unwrap().remove(key);
        assert!(decode_entry(&missing.to_string()).is_err(), "missing {key}");
        assert_eq!(reg, before);
    }
}

#[test]
fn transport_caps_precede_shape_decode() {
    let reg = registry();
    let before = reg.clone();
    let cases = [
        (" ".repeat(MAX_ENVELOPE_BYTES + 2), DecodeError::Oversized),
        (
            format!("\"{}\"", "x".repeat(65537)),
            DecodeError::StringLimitExceeded,
        ),
        (
            format!("\"{}\"", "\\u00e9".repeat(32769)),
            DecodeError::StringLimitExceeded,
        ),
        (
            format!("{}0{}", "[".repeat(33), "]".repeat(33)),
            DecodeError::DepthExceeded,
        ),
        (
            format!("[{}]", vec!["0"; 4097].join(",")),
            DecodeError::ArrayLimitExceeded,
        ),
        (
            format!(
                "{{{}}}",
                (0..257)
                    .map(|i| format!("\"k{i}\":0"))
                    .collect::<Vec<_>>()
                    .join(",")
            ),
            DecodeError::KeyLimitExceeded,
        ),
    ];
    for (raw, error) in cases {
        assert_eq!(decode_entry(&raw), Err(CatalogError::Wire(error)));
        assert_eq!(reg, before);
    }
    // Exact caps proceed to shape validation rather than triggering cap errors.
    for raw in [
        " ".repeat(MAX_ENVELOPE_BYTES),
        format!("\"{}\"", "x".repeat(65536)),
        format!("{}0{}", "[".repeat(32), "]".repeat(32)),
        format!("[{}]", vec!["0"; 4096].join(",")),
        format!(
            "{{{}}}",
            (0..256)
                .map(|i| format!("\"k{i}\":0"))
                .collect::<Vec<_>>()
                .join(",")
        ),
    ] {
        assert_eq!(
            decode_entry(&raw),
            Err(CatalogError::Wire(DecodeError::Malformed))
        );
        assert_eq!(reg, before);
    }
    let raw = serde_json::to_string(&row(Kind::Browser)).unwrap();
    let padded = format!("{raw}{}", " ".repeat(MAX_ENVELOPE_BYTES - raw.len()));
    assert!(decode_entry(&padded).is_ok());
    assert_eq!(
        decode_entry(&(padded + " ")),
        Err(CatalogError::Wire(DecodeError::Oversized))
    );
}

#[test]
fn entry_identifiers_and_identity_profiles() {
    let reg = registry();
    let before = reg.clone();
    for id in ["a", "mv-nested:1", "browser.default_1", &"a".repeat(128)] {
        let mut wire = row(Kind::Browser);
        wire.entry_id = id.into();
        assert!(CatalogEntry::try_from(wire).is_ok());
    }
    for id in [
        "",
        &"a".repeat(129),
        "-leading-dash",
        "has space",
        "semi;colon",
        "é",
    ] {
        let mut wire = row(Kind::Browser);
        wire.entry_id = id.into();
        assert!(CatalogEntry::try_from(wire).is_err());
        assert_eq!(reg, before);
    }
    for kind in [Kind::Browser, Kind::Program, Kind::Vm] {
        for profile in ["mv-live-1", "aa", &"a".repeat(48)] {
            let mut wire = row(kind);
            wire.profile_id = profile.into();
            assert!(CatalogEntry::try_from(wire).is_ok());
        }
        for profile in [
            "",
            "a",
            "BadProfile",
            "_underscore",
            "a.b",
            &"a".repeat(49),
            &"a".repeat(65),
        ] {
            let mut wire = row(kind);
            wire.profile_id = profile.into();
            assert!(CatalogEntry::try_from(wire).is_err());
            assert_eq!(reg, before);
        }
    }
}

#[test]
fn string_geometry_and_resource_boundaries() {
    let reg = registry();
    let before = reg.clone();
    let base = serde_json::to_value(row(Kind::Browser)).unwrap();
    for field in ["label", "image"] {
        for valid in ["a".into(), "é".repeat(128)] {
            let mut v = base.clone();
            v[field] = json!(valid);
            assert!(decode_entry(&v.to_string()).is_ok());
        }
        for invalid in ["".into(), "   ".into(), "é".repeat(129), "x".repeat(257)] {
            let mut v = base.clone();
            v[field] = json!(invalid);
            assert!(decode_entry(&v.to_string()).is_err());
            assert_eq!(reg, before);
        }
    }
    for size in [1, 16384] {
        let mut wire = row(Kind::Browser);
        wire.window_width_px = size;
        wire.window_height_px = size;
        wire.display_width_px = size;
        wire.display_height_px = size;
        assert!(CatalogEntry::try_from(wire).is_ok());
    }
    for field in [
        "window_width_px",
        "window_height_px",
        "display_width_px",
        "display_height_px",
    ] {
        for invalid in [0, 16385] {
            let mut v = base.clone();
            v[field] = json!(invalid);
            assert!(decode_entry(&v.to_string()).is_err());
            assert_eq!(reg, before);
        }
    }
    let mut wire = row(Kind::Browser);
    wire.window_width_px = 1281;
    assert_eq!(CatalogEntry::try_from(wire), Err(CatalogError::Geometry));
    for (field, max) in [("memory_bytes", 1_073_741_824_u64), ("cpu_milli", 20_000)] {
        for valid in [1, max] {
            let mut v = base.clone();
            v["limits"][field] = json!(valid);
            assert!(decode_entry(&v.to_string()).is_ok());
        }
        for invalid in [0, max + 1] {
            let mut v = base.clone();
            v["limits"][field] = json!(invalid);
            assert!(decode_entry(&v.to_string()).is_err());
            assert_eq!(reg, before);
        }
    }
}

#[test]
fn unknown_kind_profile_geometry_depth_are_atomic() {
    let mut reg = registry();
    refused(
        &mut reg,
        CreateRequest {
            kind: "unknown",
            ..request()
        },
        CatalogError::UnknownKind,
    );
    refused(
        &mut reg,
        CreateRequest {
            profile_id: "unregistered",
            ..request()
        },
        CatalogError::UnregisteredProfile,
    );
    refused(
        &mut reg,
        CreateRequest {
            kind: "program",
            ..request()
        },
        CatalogError::UnregisteredProfile,
    );
    refused(
        &mut reg,
        CreateRequest {
            profile_id: "mousepad",
            ..request()
        },
        CatalogError::UnregisteredProfile,
    );
    refused(
        &mut reg,
        CreateRequest {
            nested_depth: 2,
            ..request()
        },
        CatalogError::NestedDepth,
    );
    refused(
        &mut reg,
        CreateRequest {
            nested_depth: 1,
            ..request()
        },
        CatalogError::NestedDepth,
    );
    refused(
        &mut reg,
        CreateRequest {
            width_px: 0,
            ..request()
        },
        CatalogError::Geometry,
    );
    refused(
        &mut reg,
        CreateRequest {
            width_px: 1281,
            ..request()
        },
        CatalogError::Geometry,
    );
    refused(
        &mut reg,
        CreateRequest {
            surface_id: "-bad",
            ..request()
        },
        CatalogError::InvalidSurfaceId,
    );
    assert!(reg.create(request()).is_ok());
    refused(&mut reg, request(), CatalogError::SurfaceIdUsed);
}

#[test]
fn every_kind_launch_and_terminal_non_revival() {
    let cases = [
        (
            Kind::Browser,
            "browser",
            "srf-identity-surface",
            vec![
                "start",
                "--kind",
                "browser",
                "--identity",
                "synthetic-profile",
                "--windows",
                "1",
            ],
        ),
        (
            Kind::Program,
            "program",
            "srf-identity-surface",
            vec![
                "start",
                "--kind",
                "program",
                "--identity",
                "synthetic-profile",
                "--windows",
                "1",
                "--program",
                "notepad",
            ],
        ),
        (
            Kind::Vm,
            "vm",
            "srf-identity-surface",
            vec![
                "start",
                "--kind",
                "vm",
                "--identity",
                "synthetic-profile",
                "--windows",
                "1",
                "--program",
                "notepad-vm",
            ],
        ),
        (
            Kind::GameCapsule,
            "game_capsule",
            "srf-holdings-capsule",
            vec!["start", "--slots", "1", "--app", "/synthetic/app"],
        ),
        (
            Kind::DesktopCapsule,
            "desktop_capsule",
            "srf-capsula-desktop",
            vec!["iniciar", "--clase", "desktop", "--slot", "1", "--json"],
        ),
    ];
    for (kind, wire_kind, binary, args) in cases {
        assert_eq!(Kind::parse(wire_kind).unwrap(), kind);
        for lost in [false, true] {
            let mut reg = CatalogRegistry::new(vec![registration(kind)]).unwrap();
            let req = CreateRequest {
                kind: wire_kind,
                ..request()
            };
            let before = reg.clone();
            assert!(reg.validate_create(req).is_ok());
            assert_eq!(reg, before);
            let spec = reg.create(req).unwrap();
            assert_eq!(spec.binary, binary);
            assert_eq!(spec.args, args);
            assert!(spec.inner_argv.is_empty());
            if lost {
                reg.mark_lost(req.surface_id).unwrap();
            } else {
                reg.destroy(req.surface_id).unwrap();
            }
            assert_eq!(
                reg.state(req.surface_id),
                Some(if lost {
                    SurfaceState::Lost
                } else {
                    SurfaceState::Destroyed
                })
            );
            refused(&mut reg, req, CatalogError::SurfaceIdUsed);
            let before = reg.clone();
            assert_eq!(
                reg.destroy(req.surface_id),
                Err(CatalogError::SurfaceNotLive)
            );
            assert_eq!(reg, before);
            assert_eq!(
                reg.mark_lost(req.surface_id),
                Err(CatalogError::SurfaceNotLive)
            );
            assert_eq!(reg, before);
            assert!(reg
                .create(CreateRequest {
                    surface_id: "surface-2",
                    ..req
                })
                .is_ok());
        }
    }
    let mut reg = registry();
    let before = reg.clone();
    assert_eq!(reg.destroy("missing"), Err(CatalogError::SurfaceNotLive));
    assert_eq!(reg, before);
}

#[test]
fn nested_demo_policy_and_launch() {
    let registration = Registration::nested("nested-profile", row(Kind::Browser).limits).unwrap();
    let nested = registration.entry().projection().clone();
    assert_eq!(
        (
            nested.window_width_px,
            nested.window_height_px,
            nested.display_width_px,
            nested.display_height_px
        ),
        (1280, 720, 1280, 900)
    );
    let mut reg = CatalogRegistry::new(vec![registration]).unwrap();
    let req = CreateRequest {
        kind: "program",
        profile_id: "nested-profile",
        height_px: 720,
        nested_depth: 1,
        ..request()
    };
    let spec = reg.create(req).unwrap();
    assert_eq!(spec.binary, "srf-identity-surface");
    assert_eq!(
        spec.args,
        [
            "start",
            "--kind",
            "program",
            "--identity",
            "nested-profile",
            "--windows",
            "1",
            "--program",
            "metaviewer-nested"
        ]
    );
    assert_eq!(
        spec.inner_argv,
        [
            "metaviewer",
            "--nested-depth=1",
            "--user-data-dir=/profile/app",
            "--ozone-platform=x11"
        ]
    );
    refused(
        &mut reg,
        CreateRequest {
            surface_id: "new",
            nested_depth: 2,
            ..req
        },
        CatalogError::NestedDepth,
    );
    refused(
        &mut reg,
        CreateRequest {
            surface_id: "new",
            nested_depth: 0,
            ..req
        },
        CatalogError::NestedDepth,
    );
    let before = reg.clone();
    for (field, value) in [
        ("display_only", json!(false)),
        ("network", json!("proxy")),
        ("seccomp_identity", json!(false)),
        ("nested_depth", json!(0)),
        ("image", json!("other")),
        ("window_height_px", json!(721)),
        ("entry_id", json!("other")),
        ("kind", json!("browser")),
    ] {
        let mut v = serde_json::to_value(&nested).unwrap();
        v[field] = value;
        assert_eq!(
            decode_entry(&v.to_string()),
            Err(CatalogError::NestedPolicy)
        );
        assert_eq!(reg, before);
    }
    let mut wire = row(Kind::Browser);
    wire.nested_depth = 2;
    assert_eq!(CatalogEntry::try_from(wire), Err(CatalogError::NestedDepth));
}

#[test]
fn frozen_registry_duplicate_and_projection_order() {
    let first = registration(Kind::Browser);
    assert_eq!(
        CatalogRegistry::new(vec![first.clone(), first.clone()]),
        Err(CatalogError::DuplicateEntry)
    );
    let mut wire = row(Kind::Browser);
    wire.entry_id = "another".into();
    let second =
        Registration::new(CatalogEntry::try_from(wire).unwrap(), LaunchTarget::Browser).unwrap();
    assert_eq!(
        CatalogRegistry::new(vec![first.clone(), second]),
        Err(CatalogError::DuplicateProfile)
    );
    let mut wire = row(Kind::Program);
    wire.entry_id = "another".into();
    let second = Registration::new(
        CatalogEntry::try_from(wire).unwrap(),
        LaunchTarget::Program {
            program: "notepad".into(),
        },
    )
    .unwrap();
    let left = CatalogRegistry::new(vec![first.clone(), second.clone()]).unwrap();
    let right = CatalogRegistry::new(vec![second, first]).unwrap();
    assert_eq!(
        serde_json::to_vec(&left.projections()).unwrap(),
        serde_json::to_vec(&right.projections()).unwrap()
    );
    let mut copies = left.projections();
    copies.clear();
    assert_eq!(left.projections().len(), 2);
}

#[test]
fn launch_targets_refuse_disabled_or_mismatched_programs() {
    let reg = registry();
    let before = reg.clone();
    for (kind, target) in [
        (
            Kind::Browser,
            LaunchTarget::Program {
                program: "notepad".into(),
            },
        ),
        (
            Kind::Program,
            LaunchTarget::Program {
                program: "mousepad".into(),
            },
        ),
        (
            Kind::Program,
            LaunchTarget::Program {
                program: "unknown".into(),
            },
        ),
        (
            Kind::Vm,
            LaunchTarget::Vm {
                program: "notepad".into(),
            },
        ),
        (
            Kind::GameCapsule,
            LaunchTarget::Game {
                app_dir: "relative".into(),
                slots: 1,
            },
        ),
        (
            Kind::GameCapsule,
            LaunchTarget::Game {
                app_dir: "/synthetic/app".into(),
                slots: 0,
            },
        ),
        (
            Kind::GameCapsule,
            LaunchTarget::Game {
                app_dir: "/synthetic/app".into(),
                slots: 5,
            },
        ),
        (
            Kind::DesktopCapsule,
            LaunchTarget::Desktop {
                class: "-bad".into(),
                slot: 1,
            },
        ),
        (
            Kind::DesktopCapsule,
            LaunchTarget::Desktop {
                class: "desktop".into(),
                slot: 0,
            },
        ),
    ] {
        assert_eq!(
            Registration::new(CatalogEntry::try_from(row(kind)).unwrap(), target),
            Err(CatalogError::InvalidTarget)
        );
        assert_eq!(reg, before);
    }
    let nested = Registration::nested("nested-profile", row(Kind::Browser).limits).unwrap();
    assert_eq!(
        Registration::new(
            nested.entry().clone(),
            LaunchTarget::Program {
                program: "notepad".into()
            }
        ),
        Err(CatalogError::InvalidTarget)
    );
}

#[test]
fn surface_request_conversion_checks_integer_narrowing() {
    for kind in [
        payload::SurfaceKind::Browser,
        payload::SurfaceKind::DesktopCapsule,
        payload::SurfaceKind::GameCapsule,
        payload::SurfaceKind::Vm,
    ] {
        let mut params = payload::SurfaceRequestCase0Params {
            kind,
            geometry: payload::SurfaceGeometry { w: 1280, h: 900 },
            profile_id: "synthetic-profile".into(),
        };
        assert!(CreateRequest::from_surface_request("surface-1", &params, 0).is_ok());
        params.geometry.w = u64::MAX;
        assert_eq!(
            CreateRequest::from_surface_request("surface-1", &params, 0).unwrap_err(),
            CatalogError::Geometry
        );
        params.geometry.w = 1280;
        params.geometry.h = u64::MAX;
        assert_eq!(
            CreateRequest::from_surface_request("surface-1", &params, 0).unwrap_err(),
            CatalogError::Geometry
        );
    }
}
