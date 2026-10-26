mod support;
use metaviewer_core::*;
use std::fs::{self, Permissions};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::time::Duration;
#[test]
fn private_bind_peer_credentials_live_and_stale_socket() {
    support::run(async {
        let tmp = support::Temp::new();
        let dir = tmp.0.join("runtime");
        let path = dir.join("core.sock");
        let uid = support::uid();
        let listener = bind_owner_only(&path, uid, Duration::from_millis(100))
            .await
            .unwrap();
        assert_eq!(fs::symlink_metadata(&dir).unwrap().mode() & 0o7777, 0o700);
        assert_eq!(fs::symlink_metadata(&path).unwrap().mode() & 0o7777, 0o600);
        let client = tokio::net::UnixStream::connect(&path).await.unwrap();
        let (server, _) = listener.accept().await.unwrap();
        assert_eq!(verify_peer_cred(&server, uid).unwrap().uid(), uid);
        assert_eq!(
            verify_peer_cred(&client, uid.checked_add(1).unwrap()).unwrap_err(),
            PeerCredError::ForeignUid
        );
        assert_eq!(check_uid_equal(0, 1), Err(PeerCredError::ForeignUid));
        assert!(matches!(
            bind_owner_only(&path, uid, Duration::from_millis(100)).await,
            Err(BindError::LiveSocket)
        ));
        drop(client);
        drop(server);
        drop(listener);
        let rebound = bind_owner_only(&path, uid, Duration::from_millis(100))
            .await
            .unwrap();
        drop(rebound);
    });
}
#[test]
fn unsafe_paths_and_regular_targets_are_preserved() {
    support::run(async {
        let tmp = support::Temp::new();
        let dir = tmp.0.join("runtime");
        fs::create_dir(&dir).unwrap();
        let path = dir.join("core.sock");
        fs::write(&path, b"preserve").unwrap();
        let uid = support::uid();
        fs::set_permissions(&dir, Permissions::from_mode(0o777)).unwrap();
        assert!(matches!(
            bind_owner_only(&path, uid, Duration::from_millis(100)).await,
            Err(BindError::UnsafeRuntimeDir)
        ));
        fs::set_permissions(&dir, Permissions::from_mode(0o700)).unwrap();
        assert!(matches!(
            bind_owner_only(&path, uid, Duration::from_millis(100)).await,
            Err(BindError::NotSocket)
        ));
        assert_eq!(fs::read(&path).unwrap(), b"preserve");
        assert!(matches!(
            bind_owner_only(
                &path,
                uid.checked_add(1).unwrap(),
                Duration::from_millis(100)
            )
            .await,
            Err(BindError::UnsafeRuntimeDir)
        ));
        let link = tmp.0.join("link");
        std::os::unix::fs::symlink(&dir, &link).unwrap();
        assert!(matches!(
            bind_owner_only(&link.join("other.sock"), uid, Duration::from_millis(100)).await,
            Err(BindError::UnsafeRuntimeDir)
        ));
        fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink("absent", &path).unwrap();
        assert!(matches!(
            bind_owner_only(&path, uid, Duration::from_millis(100)).await,
            Err(BindError::NotSocket)
        ));
        assert!(fs::symlink_metadata(&path)
            .unwrap()
            .file_type()
            .is_symlink());
    });
}

/// Observe the final path independently under a hostile child-only umask. The
/// child holds publication until the observer acknowledges its first lstat.
#[test]
fn creation_mode_hostile_umask() {
    use std::os::unix::fs::FileTypeExt;
    use std::process::Command;
    use std::time::Instant;
    if let Some(root) = std::env::var_os("MV_BIND_OBSERVER_CHILD") {
        let root = std::path::PathBuf::from(root);
        let path = root.join("runtime/core.sock");
        support::run(async {
            let _listener = if std::env::var_os("MV_BIND_MUTANT").is_some() {
                fs::DirBuilder::new().create(root.join("runtime")).unwrap();
                fs::set_permissions(root.join("runtime"), Permissions::from_mode(0o700)).unwrap();
                // Negative control: the old bind-then-chmod publication.
                tokio::net::UnixListener::bind(&path).unwrap()
            } else {
                bind_owner_only(&path, support::uid(), Duration::from_secs(1))
                    .await
                    .unwrap()
            };
            let deadline = Instant::now() + Duration::from_secs(10);
            while !root.join("observed").exists() {
                assert!(Instant::now() < deadline, "observer did not acknowledge");
                std::thread::yield_now();
            }
            if std::env::var_os("MV_BIND_MUTANT").is_some() {
                fs::set_permissions(path, Permissions::from_mode(0o600)).unwrap();
            }
        });
        return;
    }
    for mutant in [false, true] {
        let tmp = support::Temp::new();
        let mut command = Command::new("/bin/bash");
        command
            .args(["-c", "umask 000; exec \"$@\"", "bind-observer"])
            .arg(std::env::current_exe().unwrap())
            .args(["--exact", "creation_mode_hostile_umask", "--nocapture"])
            .env("MV_BIND_OBSERVER_CHILD", &tmp.0);
        if mutant {
            command.env("MV_BIND_MUTANT", "1");
        }
        let mut child = command.spawn().unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        let first = loop {
            match fs::symlink_metadata(tmp.0.join("runtime/core.sock")) {
                Ok(meta) => break meta,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => panic!("{error}"),
            }
            if child.try_wait().unwrap().is_some() {
                panic!("child exited before publication");
            }
            if Instant::now() >= deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("socket was never published");
            }
            std::thread::yield_now();
        };
        fs::write(tmp.0.join("observed"), b"ack").unwrap();
        assert!(child.wait().unwrap().success());
        let secure = first.file_type().is_socket()
            && first.uid() == fs::metadata(&tmp.0).unwrap().uid()
            && first.mode() & 0o7777 == 0o600;
        assert_eq!(
            secure,
            !mutant,
            "first visible mode {:o}",
            first.mode() & 0o7777
        );
    }
}
