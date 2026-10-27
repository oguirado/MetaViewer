mod support;
use metaviewer_core::*;
use std::fs::{self, Permissions};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::time::Duration;

// [TARGET, unit decision] Every test body runs in its own process. A fork in
// another test can retain both listener and directory-lock descriptors until
// exec, even with CLOEXEC. The harness process must own neither kind of fd.
fn isolated_test(name: &str) -> bool {
    const CHILD: &str = "MV_SOCKET_BIND_TEST_CHILD";
    if std::env::var(CHILD).as_deref() == Ok(name) {
        return false;
    }
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", name, "--nocapture"])
        .env(CHILD, name)
        .env_remove("MV_BIND_OBSERVER_CHILD")
        .env_remove("MV_BIND_OBSERVER_ROOT")
        .status()
        .unwrap();
    assert!(status.success(), "isolated {name}: {status}");
    true
}

// Test names distinguish directories without a process-global counter. Fail on
// collision rather than reusing any existing directory or repairing its mode.
struct SocketTemp(std::path::PathBuf);
impl SocketTemp {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!("mv-bind-{}-{name}", std::process::id()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for SocketTemp {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn private_bind_peer_credentials_live_and_stale_socket() {
    if isolated_test("private_bind_peer_credentials_live_and_stale_socket") {
        return;
    }
    support::run(async {
        let tmp = SocketTemp::new("lifecycle");
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

        // Hold a child before exec to make descriptor inheritance deterministic.
        // The child performs only socket read/write syscalls in pre_exec; no
        // allocation, locking, sleeps, or scheduler-dependent observation.
        use std::io::{Read, Write};
        use std::os::unix::process::CommandExt;
        let (mut parent_barrier, mut child_barrier) =
            std::os::unix::net::UnixStream::pair().unwrap();
        // Negative control for the sibling's NotSocket failure: a pre-exec
        // child also retains an unrelated runtime-directory publication lock.
        let regular_dir = tmp.0.join("regular-runtime");
        fs::create_dir(&regular_dir).unwrap();
        fs::set_permissions(&regular_dir, Permissions::from_mode(0o700)).unwrap();
        let regular_path = regular_dir.join("core.sock");
        fs::write(&regular_path, b"preserve").unwrap();
        let directory_lock = fs::File::open(&regular_dir).unwrap();
        directory_lock.try_lock().unwrap();
        let spawn = std::thread::spawn(move || {
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command.arg("--list");
            // SAFETY: the callback only exchanges fixed stack buffers through
            // already-open descriptors, then returns to exec.
            unsafe {
                command.pre_exec(move || {
                    child_barrier.write_all(b"H")?;
                    child_barrier.read_exact(&mut [0])?;
                    Ok(())
                });
            }
            command.spawn().unwrap().wait().unwrap()
        });
        parent_barrier.read_exact(&mut [0]).unwrap();
        let live_inode = fs::symlink_metadata(&path).unwrap().ino();
        drop(listener);
        drop(directory_lock);
        let inherited = bind_owner_only(&path, uid, Duration::from_millis(100)).await;
        let inherited_lock = bind_owner_only(&regular_path, uid, Duration::from_millis(100)).await;
        eprintln!(
            "listener dropped, child before exec, {}: {inherited:?}; regular target {}: {inherited_lock:?}",
            path.display(), regular_path.display()
        );
        // Release and reap even if the subsequent assertion fails.
        parent_barrier.write_all(b"E").unwrap();
        assert!(spawn.join().unwrap().success());
        assert!(matches!(inherited, Err(BindError::LiveSocket)));
        assert!(matches!(inherited_lock, Err(BindError::IdentityChanged)));
        assert!(matches!(
            bind_owner_only(&regular_path, uid, Duration::from_millis(100)).await,
            Err(BindError::NotSocket)
        ));
        assert_eq!(fs::read(&regular_path).unwrap(), b"preserve");
        assert_eq!(fs::symlink_metadata(&path).unwrap().ino(), live_inode);
        let rebound = bind_owner_only(&path, uid, Duration::from_millis(100))
            .await
            .unwrap_or_else(|error| panic!("stale socket {}: {error:?}", path.display()));
        drop(rebound);
    });
}

#[test]
fn unsafe_paths_and_regular_targets_are_preserved() {
    if isolated_test("unsafe_paths_and_regular_targets_are_preserved") {
        return;
    }
    support::run(async {
        let tmp = SocketTemp::new("unsafe");
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
        let regular = bind_owner_only(&path, uid, Duration::from_millis(100)).await;
        assert!(
            matches!(regular, Err(BindError::NotSocket)),
            "regular target {}: {regular:?}",
            path.display()
        );
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
    if isolated_test("creation_mode_hostile_umask") {
        return;
    }
    let observer = std::env::var("MV_BIND_OBSERVER_CHILD");
    if let Ok("creation_mode_hostile_umask:secure" | "creation_mode_hostile_umask:mutant") =
        observer.as_deref()
    {
        let mutant = observer.as_deref() == Ok("creation_mode_hostile_umask:mutant");
        let root = std::path::PathBuf::from(std::env::var_os("MV_BIND_OBSERVER_ROOT").unwrap());
        let path = root.join("runtime/core.sock");
        support::run(async {
            let _listener = if mutant {
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
            if mutant {
                fs::set_permissions(path, Permissions::from_mode(0o600)).unwrap();
            }
        });
        return;
    }
    for mutant in [false, true] {
        let tmp = SocketTemp::new(if mutant { "mode-mutant" } else { "mode-secure" });
        let mut command = Command::new("/bin/bash");
        command
            .args(["-c", "umask 000; exec \"$@\"", "bind-observer"])
            .arg(std::env::current_exe().unwrap())
            .args(["--exact", "creation_mode_hostile_umask", "--nocapture"])
            .env("MV_BIND_OBSERVER_ROOT", &tmp.0)
            .env(
                "MV_BIND_OBSERVER_CHILD",
                if mutant {
                    "creation_mode_hostile_umask:mutant"
                } else {
                    "creation_mode_hostile_umask:secure"
                },
            );
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
