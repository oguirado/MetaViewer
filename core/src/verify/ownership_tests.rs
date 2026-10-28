// [TARGET, unit decision] CI supplies a non-secret root-owned private file via
// MV_VERIFY_FOREIGN_FRAME before network isolation. Standalone Linux runs may
// use the host's private SSH key inode as metadata only: it is never read.
// Bind it into a private mount namespace so the production RAM-path gate stays
// exercised. No subordinate mappings, chown, or newuidmap are needed here.

use super::*;
use std::fs::OpenOptions;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::process::Command;

struct FrameFile(FrameRef);

impl FrameFile {
    fn new(mode: u32) -> Self {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = format!(
            "/dev/shm/mv-ownership-{}-{}-{}",
            std::process::id(),
            mode,
            NEXT.fetch_add(1, Ordering::Relaxed)
        );
        let bytes = [1, 2, 3];
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .unwrap();
        file.write_all(&bytes).unwrap();
        file.set_permissions(fs::Permissions::from_mode(mode))
            .unwrap();
        Self(
            serde_json::from_value(serde_json::json!({
                "schema": "frame_ref/v0.2", "format": "rgb24", "capture_us": 1,
                "surface_id": "s1", "ramws_path": path, "sha256": digest(&bytes),
                "width": 1, "height": 1, "generation": 1, "tick": 1, "ts_ns": 1
            }))
            .unwrap(),
        )
    }
}

impl Drop for FrameFile {
    fn drop(&mut self) {
        fs::remove_file(&self.0.ramws_path).unwrap();
    }
}

#[test]
fn shared_permissions_are_rejected() {
    for mode in [0o666, 0o620, 0o602, 0o640, 0o604] {
        let fixture = FrameFile::new(mode);
        assert_eq!(
            read_published_frame(&fixture.0).unwrap_err().kind(),
            io::ErrorKind::InvalidData,
            "mode {mode:o} must be refused"
        );
    }
}

#[test]
fn owner_only_frame_is_accepted() {
    let fixture = FrameFile::new(0o600);
    assert_eq!(read_published_frame(&fixture.0).unwrap(), [1, 2, 3]);
}

#[test]
fn foreign_uid_is_rejected() {
    const CHILD: &str = "MV_VERIFY_FOREIGN_UID_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let output = Command::new("unshare")
            .args(["--user", "--map-root-user", "--mount"])
            .arg(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "verify::ownership_tests::foreign_uid_is_rejected",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    let source = std::env::var_os("MV_VERIFY_FOREIGN_FRAME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| "/etc/ssh/ssh_host_ed25519_key".into());
    let metadata = fs::metadata(&source)
        .expect("provide MV_VERIFY_FOREIGN_FRAME: root-owned private regular fixture required");
    assert!(metadata.is_file());
    assert_eq!(metadata.mode() & 0o077, 0, "fixture must be private");
    assert_ne!(metadata.uid(), crate::serve::effective_uid().unwrap());
    assert!(metadata.len() > 0 && metadata.len() <= MAX_RGB_BYTES);
    assert!(metadata.len().is_multiple_of(3));

    let mut fixture = FrameFile::new(0o600);
    // Negative control in the same namespace: the own-UID frame is accepted.
    assert_eq!(read_published_frame(&fixture.0).unwrap(), [1, 2, 3]);
    let status = Command::new("mount")
        .arg("--bind")
        .arg(&source)
        .arg(&fixture.0.ramws_path)
        .status()
        .unwrap();
    assert!(status.success(), "foreign fixture bind mount failed");
    fixture.0.width = metadata.len() / 3;
    let foreign = fs::metadata(&fixture.0.ramws_path).unwrap();
    assert_ne!(foreign.uid(), crate::serve::effective_uid().unwrap());
    assert_eq!(foreign.mode() & 0o077, 0);
    assert_eq!(foreign.len(), byte_len(&fixture.0).unwrap());
    // If the UID check regresses, opening the private foreign inode would yield
    // PermissionDenied, not the InvalidData rejection asserted below.
    assert_eq!(
        fs::File::open(&fixture.0.ramws_path).unwrap_err().kind(),
        io::ErrorKind::PermissionDenied
    );
    let result = read_published_frame(&fixture.0);
    let status = Command::new("umount")
        .arg(&fixture.0.ramws_path)
        .status()
        .unwrap();
    assert!(status.success(), "foreign fixture unmount failed");
    assert_eq!(result.unwrap_err().kind(), io::ErrorKind::InvalidData);
    fixture.0.width = 1;
    assert_eq!(read_published_frame(&fixture.0).unwrap(), [1, 2, 3]);
}

#[test]
fn r3_t1_02_04_serve_shm_reader_enforces_mode_uid_and_exact_rgb_byte_len() {
    let shm_root = std::path::Path::new("/dev/shm");
    for mode in [0o644, 0o640, 0o604, 0o666] {
        let fixture = FrameFile::new(mode);
        assert!(
            crate::serve::Server::read_shm_pixels_under(shm_root, &fixture.0).is_err(),
            "read_shm_pixels_under must reject mode {mode:o}"
        );
    }

    // Negative control: 0600 3-byte 1x1 frame succeeds.
    let mut valid = FrameFile::new(0o600);
    let pixels = crate::serve::Server::read_shm_pixels_under(shm_root, &valid.0).unwrap();
    assert_eq!(pixels.bytes(), &[1, 2, 3]);

    // R3-T1-04: meta.len() != 3 * width * height must fail closed even when sha256 matches file bytes.
    valid.0.width = 2;
    valid.0.height = 1;
    assert!(
        crate::serve::Server::read_shm_pixels_under(shm_root, &valid.0).is_err(),
        "read_shm_pixels_under must reject byte length != 3 * width * height"
    );
}
