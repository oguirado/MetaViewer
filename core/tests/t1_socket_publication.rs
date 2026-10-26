#![forbid(unsafe_code)]
mod support;

use metaviewer_core::{bind_owner_only, BindError};
use std::fs::{self, File, Permissions, TryLockError};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Barrier, Mutex};
use std::time::Duration;

// A fork in the subprocess test can transiently inherit a different test's
// just-bound listener before exec closes it, making a stale fixture look live.
// Serialize fixtures with subprocess spawning; the stress binders still race.
static FIXTURES: Mutex<()> = Mutex::new(());

// [TARGET, unit decision] Publication contenders lock the runtime directory
// inode through the stale probe and atomic replacement, without blocking Tokio.
#[test]
fn competing_binder_is_excluded_during_stale_probe() {
    let _fixture = FIXTURES.lock().unwrap();
    support::run(async {
        let tmp = support::Temp::new();
        let dir = tmp.0.join("runtime");
        fs::create_dir(&dir).unwrap();
        fs::set_permissions(&dir, Permissions::from_mode(0o700)).unwrap();
        let path = dir.join("core.sock");
        drop(std::os::unix::net::UnixListener::bind(&path).unwrap());
        let old = fs::symlink_metadata(&path).unwrap();
        // Deterministically pause a competing publisher inside the exclusion
        // protocol, before it probes/replaces this stale inode.
        let publisher = File::open(&dir).unwrap();
        publisher.try_lock().unwrap();
        let observer = File::open(&dir).unwrap();
        assert!(matches!(observer.try_lock(), Err(TryLockError::WouldBlock)));
        assert!(matches!(
            bind_owner_only(&path, support::uid(), Duration::from_secs(1)).await,
            Err(BindError::IdentityChanged)
        ));
        assert_eq!(fs::symlink_metadata(&path).unwrap().ino(), old.ino());
        // Negative control: releasing exclusion permits stale replacement.
        publisher.unlock().unwrap();
        let winner = bind_owner_only(&path, support::uid(), Duration::from_secs(1))
            .await
            .unwrap();
        let published = fs::symlink_metadata(&path).unwrap();
        assert_ne!(published.ino(), old.ino());
        assert_eq!(published.mode() & 0o7777, 0o600);
        let _client = tokio::net::UnixStream::connect(&path).await.unwrap();
        let _server = winner.accept().await.unwrap();
        // Negative control: the publication lock is released after completion;
        // a later contender reaches the live-socket check, preserving the winner.
        observer.try_lock().unwrap();
        observer.unlock().unwrap();
        assert!(matches!(
            bind_owner_only(&path, support::uid(), Duration::from_secs(1)).await,
            Err(BindError::LiveSocket)
        ));
        assert_eq!(fs::symlink_metadata(&path).unwrap().ino(), published.ino());
    });
}

#[test]
fn eight_competing_binders_two_hundred_rounds() {
    let _fixture = FIXTURES.lock().unwrap();
    let tmp = support::Temp::new();
    let dir = tmp.0.join("runtime");
    fs::create_dir(&dir).unwrap();
    fs::set_permissions(&dir, Permissions::from_mode(0o700)).unwrap();
    for round in (1..200).step_by(2) {
        let path = dir.join(format!("s{round}"));
        drop(std::os::unix::net::UnixListener::bind(&path).unwrap());
        fs::set_permissions(path, Permissions::from_mode(0o600)).unwrap();
    }
    let barrier = Arc::new(Barrier::new(8));
    let finished = AtomicBool::new(false);
    let results = std::thread::scope(|scope| {
        let observer = scope.spawn(|| {
            let mut missing = false;
            while !finished.load(Ordering::Acquire) {
                for round in (1..200).step_by(2) {
                    missing |= fs::symlink_metadata(dir.join(format!("s{round}"))).is_err();
                }
            }
            missing
        });
        let mut workers = Vec::new();
        for _ in 0..8 {
            let barrier = barrier.clone();
            let dir = &dir;
            workers.push(scope.spawn(move || {
                support::run(async {
                    let mut results = Vec::new();
                    for round in 0..200 {
                        let path = dir.join(format!("s{round}"));
                        barrier.wait();
                        let result =
                            bind_owner_only(&path, support::uid(), Duration::from_secs(1)).await;
                        let inode = result
                            .as_ref()
                            .ok()
                            .and_then(|_| fs::symlink_metadata(&path).ok().map(|m| m.ino()));
                        // Keep every successful listener alive until all
                        // contenders finish and its reachability is verified.
                        barrier.wait();
                        let mut owned_and_live = true;
                        if let Ok(listener) = &result {
                            owned_and_live = fs::symlink_metadata(&path).is_ok_and(|m| {
                                Some(m.ino()) == inode && m.mode() & 0o7777 == 0o600
                            });
                            owned_and_live &= tokio::time::timeout(Duration::from_secs(1), async {
                                let _client = tokio::net::UnixStream::connect(&path).await?;
                                listener.accept().await
                            })
                            .await
                            .is_ok_and(|r| r.is_ok());
                        }
                        barrier.wait();
                        results.push((result.map(|_| inode), owned_and_live));
                    }
                    results
                })
            }));
        }
        let results = workers
            .into_iter()
            .map(|w| w.join().unwrap())
            .collect::<Vec<_>>();
        finished.store(true, Ordering::Release);
        assert!(
            !observer.join().unwrap(),
            "stale path disappeared during replacement"
        );
        results
    });
    for round in 0..200 {
        assert!(
            results.iter().all(|w| w[round].1),
            "winner lost ownership/reachability"
        );
        let outcomes = results.iter().map(|w| &w[round].0).collect::<Vec<_>>();
        assert_eq!(
            outcomes.iter().filter(|r| r.is_ok()).count(),
            1,
            "{outcomes:?}"
        );
        for result in outcomes {
            assert!(
                matches!(
                    result,
                    Ok(_) | Err(BindError::LiveSocket | BindError::IdentityChanged)
                ),
                "unexpected loser: {result:?}"
            );
        }
    }
}

#[test]
fn publication_lock_excludes_another_process_and_releases_on_exit() {
    let _fixture = FIXTURES.lock().unwrap();
    const CHILD: &str = "MV_SOCKET_PUBLICATION_CHILD";
    if let Some(dir) = std::env::var_os(CHILD) {
        support::run(async {
            let path = std::path::PathBuf::from(dir).join("core.sock");
            let result = bind_owner_only(&path, support::uid(), Duration::from_secs(1)).await;
            if std::env::var_os("MV_SOCKET_PUBLICATION_LOCKED").is_some() {
                assert!(matches!(result, Err(BindError::IdentityChanged)));
            } else {
                let _listener = result.unwrap();
                assert_eq!(fs::symlink_metadata(&path).unwrap().mode() & 0o7777, 0o600);
            }
        });
        return;
    }
    let tmp = support::Temp::new();
    fs::set_permissions(&tmp.0, Permissions::from_mode(0o700)).unwrap();
    let publisher = File::open(&tmp.0).unwrap();
    publisher.try_lock().unwrap();
    let run = |locked| {
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "publication_lock_excludes_another_process_and_releases_on_exit",
            ])
            .env(CHILD, &tmp.0);
        if locked {
            command.env("MV_SOCKET_PUBLICATION_LOCKED", "1");
        }
        assert!(command.status().unwrap().success());
    };
    run(true);
    assert!(!tmp.0.join("core.sock").exists());
    // Negative control: closing the owner's descriptor releases the OS lock.
    drop(publisher);
    run(false);
}
