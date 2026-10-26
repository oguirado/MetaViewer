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
