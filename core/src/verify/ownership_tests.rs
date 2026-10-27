use super::*;
use std::fs::OpenOptions;
use std::io::Write;
use std::os::unix::fs::{chown, OpenOptionsExt, PermissionsExt};
use std::process::Command;

struct FrameFile(FrameRef);

impl FrameFile {
    fn new(mode: u32) -> Self {
        let path = format!("/dev/shm/mv-ownership-{}-{}", std::process::id(), mode);
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
        // A subordinate UID mapping supplies real foreign-owned metadata without sudo.
        // Failure to establish this runner fails the test; there is no skipped path.
        let output = Command::new("unshare")
            .args(["--user", "--map-auto", "--map-root-user"])
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
    let fixture = FrameFile::new(0o600);
    assert_eq!(crate::serve::effective_uid().unwrap(), 0);
    chown(&fixture.0.ramws_path, Some(1), None).unwrap();
    assert_eq!(fs::metadata(&fixture.0.ramws_path).unwrap().uid(), 1);
    assert_eq!(
        read_published_frame(&fixture.0).unwrap_err().kind(),
        io::ErrorKind::InvalidData
    );
}
