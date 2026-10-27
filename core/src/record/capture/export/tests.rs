use super::*;
use std::os::unix::fs::{symlink, PermissionsExt};

fn fixture() -> Host {
    let mut host = Host::default();
    let mut value: Value = serde_json::from_str(include_str!(
        "../../../../../contracts/examples/v0.2/frame_ref.valid.json"
    ))
    .unwrap();
    value["width"] = 1.into();
    value["height"] = 1.into();
    value["sha256"] = sha256_hex(&[255, 0, 0]).into();
    host.frame(&serde_json::from_value(value).unwrap(), vec![255, 0, 0], 0)
        .unwrap();
    host.prepare(
        "screenshot",
        &json!({"request_id":"shot","surface_id":"surface-demo"}),
        BTreeSet::from(["surface-demo".to_owned()]),
        0,
    )
    .unwrap()
    .0
}
fn scratch() -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "mv-export-{}-{}",
        std::process::id(),
        SERIAL.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&root).unwrap();
    root
}
#[test]
fn deterministic_png_tar_is_private_and_atomic_without_clobber() {
    let host = fixture();
    let plan = host.export_plan("capture-1").unwrap();
    let again = host.export_plan("capture-1").unwrap();
    assert_eq!(plan.bytes, again.bytes);
    assert_eq!(plan.receipt["sha256"], sha256_hex(&plan.bytes));
    assert_eq!(plan.receipt["bytes"], plan.bytes.len());
    assert_eq!(&plan.bytes[..20], b"frames/00000000.png\0");
    assert_eq!(&plan.bytes[100..108], b"0000600\0");
    assert_eq!(&plan.bytes[512..520], b"\x89PNG\r\n\x1a\n");
    // Independent reference for a one-pixel red RGB PNG: zlib stored block,
    // PNG CRC32s and Adler32. Detect wrong filter, dimensions or checksums.
    let expected = "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000f494441547801010400fbff00ff0000030101008d1de5820000000049454e44ae426082";
    let png_bytes: Vec<u8> = (0..expected.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&expected[i..i + 2], 16).unwrap())
        .collect();
    assert_eq!(&plan.bytes[512..512 + png_bytes.len()], png_bytes);
    let root = scratch();
    let publication = plan.publish(&root).unwrap();
    let file = root.join(&plan.name);
    assert_eq!(fs::read(&file).unwrap(), plan.bytes);
    assert_eq!(fs::metadata(&file).unwrap().mode() & 0o777, 0o600);
    assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
    publication.commit();
    assert!(matches!(plan.publish(&root), Err("DESTINATION_EXISTS")));
    assert_eq!(fs::read(&file).unwrap(), plan.bytes);
    assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn failures_and_aborted_journal_leave_no_artifacts_or_symlink_target_changes() {
    let plan = fixture().export_plan("capture-1").unwrap();
    let root = scratch();
    let destination = root.join("destination");
    assert!(matches!(
        plan.publish(&destination),
        Err("DESTINATION_UNAVAILABLE")
    ));
    fs::create_dir(&destination).unwrap();
    drop(plan.publish(&destination).unwrap()); // journal transaction failed
    assert_eq!(fs::read_dir(&destination).unwrap().count(), 0);
    let target = root.join("target");
    fs::write(&target, b"untouched").unwrap();
    symlink(&target, destination.join(&plan.name)).unwrap();
    assert!(matches!(
        plan.publish(&destination),
        Err("DESTINATION_EXISTS")
    ));
    assert_eq!(fs::read(&target).unwrap(), b"untouched");
    assert_eq!(fs::read_dir(&destination).unwrap().count(), 1);
    let alias = root.join("alias");
    symlink(&destination, &alias).unwrap();
    for path in [
        &alias,
        &alias.join("child"),
        &destination.join("../destination"),
    ] {
        assert!(matches!(plan.publish(path), Err("DESTINATION_UNAVAILABLE")));
    }
    fs::remove_file(destination.join(&plan.name)).unwrap();
    fs::set_permissions(&destination, fs::Permissions::from_mode(0o500)).unwrap();
    assert!(matches!(
        plan.publish(&destination),
        Err("DESTINATION_UNAVAILABLE")
    ));
    assert_eq!(fs::read_dir(&destination).unwrap().count(), 0);
    fs::set_permissions(&destination, fs::Permissions::from_mode(0o700)).unwrap();
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn unknown_active_malformed_and_size_controls_refuse_before_publication() {
    let mut host = fixture();
    for id in ["unknown", "../capture-1", "/capture-1"] {
        assert!(matches!(host.export_plan(id), Err("CAPTURE_UNKNOWN")));
    }
    host.rows.get_mut("capture-1").unwrap()["sealed"] = false.into();
    assert!(matches!(host.export_plan("capture-1"), Err("NOT_SEALED")));
    host.rows.get_mut("capture-1").unwrap()["sealed"] = true.into();
    let pixels = host.pixels.get_mut("capture-1").unwrap();
    pixels[0].bytes.pop();
    assert!(matches!(
        host.export_plan("capture-1"),
        Err("CAPTURE_UNAVAILABLE")
    ));
    let mut host = fixture();
    let pixel = host.pixels["capture-1"][0].clone();
    host.pixels
        .insert("capture-1".into(), VecDeque::from(vec![pixel; 4097]));
    assert!(matches!(host.export_plan("capture-1"), Err("LIMIT")));
    let mut host = fixture();
    let mut pixel = host.pixels["capture-1"][0].clone();
    pixel.frame.width = 2048;
    pixel.frame.height = 1024;
    pixel.bytes = vec![0; 2048 * 1024 * 3];
    host.pixels
        .insert("capture-1".into(), VecDeque::from(vec![pixel; 3]));
    assert!(matches!(host.export_plan("capture-1"), Err("LIMIT")));
}

#[test]
fn sealed_recording_exports_all_retained_frames_in_order() {
    let host = fixture();
    let surfaces = BTreeSet::from(["surface-demo".to_owned()]);
    let (mut host, reply, _) = host
        .prepare(
            "recordStart",
            &json!({"request_id":"start","surface_id":"surface-demo"}),
            surfaces.clone(),
            1,
        )
        .unwrap();
    let id = reply["recording_id"].as_str().unwrap();
    assert!(matches!(host.export_plan(id), Err("NOT_SEALED")));
    let (mut frame, _) = host.latest["surface-demo"].clone();
    frame.sha256 = sha256_hex(&[0, 255, 0]);
    host.frame(&frame, vec![0, 255, 0], 2).unwrap();
    let (host, _, _) = host
        .prepare(
            "recordStop",
            &json!({"request_id":"stop","recording_id":id}),
            surfaces,
            3,
        )
        .unwrap();
    let plan = host.export_plan(id).unwrap();
    assert_eq!(&plan.bytes[..20], b"frames/00000000.png\0");
    assert_eq!(&plan.bytes[1024..1044], b"frames/00000001.png\0");
    assert_ne!(&plan.bytes[512..585], &plan.bytes[1536..1609]);
    assert_eq!(host.pixels[id].len(), 2); // exporting retains RAM authority
}

#[test]
fn recovery_removes_symlink_names_without_following_their_targets() {
    let plan = fixture().export_plan("capture-1").unwrap();
    let root = scratch();
    let victim = root.join("unrelated");
    fs::write(&victim, b"keep").unwrap();
    let archive = root.join(&plan.name);
    let temporary = root.join(format!(".mv-export-{}-5", plan.name));
    symlink(&victim, &archive).unwrap();
    symlink(&victim, &temporary).unwrap();
    assert!(!recover(&root, &plan.receipt, 5).unwrap());
    assert_eq!(fs::read(&victim).unwrap(), b"keep");
    assert!(fs::symlink_metadata(archive).is_err());
    assert!(fs::symlink_metadata(temporary).is_err());
    fs::remove_dir_all(root).unwrap();
}
