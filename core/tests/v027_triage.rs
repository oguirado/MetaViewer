#![forbid(unsafe_code)]
use metaviewer_core::admission::*;
use metaviewer_core::journal::*;
use metaviewer_core::Refusal;
use metaviewer_core::{Component, Endpoint};
use serde_json::json;
use std::fs;
use std::os::unix::fs::DirBuilderExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "mv-v027-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&path).unwrap();
        Self(path)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn owner() -> Endpoint {
    Endpoint {
        component: Component::Agent,
        instance: "agent-1".into(),
    }
}
fn setup(t: &Temp) -> (Authority, Witness) {
    let mut c = Authority::create(&t.0, CoreState::new("session-1", 10).unwrap()).unwrap();
    c.apply(Input::Connect).unwrap();
    let witness = c.retain_witness(b"synthetic-frame").unwrap();
    c.apply_with_witnesses(
        Input::Surface {
            id: "surface-1".into(),
            surface: Surface {
                display: "display-1".into(),
                owner: owner(),
                agent_controlled: true,
                live: true,
                frame: Some(frame(&witness, 1)),
                refresh_after: None,
                allowed_verbs: vec![],
            },
        },
        vec![witness.clone()],
    )
    .unwrap();
    (c, witness)
}
fn frame(w: &Witness, generation: u64) -> Frame {
    Frame {
        sha256: w.sha256.clone(),
        generation,
        width: 10,
        height: 10,
    }
}
fn proposal(w: &Witness) -> AdmissionRequest {
    let raw = json!({"schema":"envelope/v0.2","msg_id":"input-1","ts_ns":0,
        "from":owner(),"to":{"component":"core","instance":"core-1"},
        "session_id":"session-1","seq":1,"nonce":"nonce-1",
        "body":{"schema":"action_proposal/v0.2","proposal_id":"proposal-1",
        "surface_id":"surface-1","based_on_frame":{"sha256":w.sha256,"generation":1},
        "action":{"type":"click","x":1,"y":2,"button":"left"},
        "expectation":{"type":"text_present","text":"ready"},
        "budget":{"max_ms":10,"max_retries":0}}});
    AdmissionRequest::decode(&raw.to_string(), &owner(), "session-1", 1, 0).unwrap()
}

#[test]
fn v027_ca01_recovered_undispatched_releases_but_dispatched_stays_fenced() {
    for dispatched in [false, true] {
        let t = Temp::new();
        let (mut c, w) = setup(&t);
        assert_eq!(
            c.apply_with_witnesses(Input::Propose(proposal(&w)), vec![w.clone()])
                .unwrap()
                .reason,
            None
        );
        if dispatched {
            assert!(
                c.apply(Input::Dispatch {
                    proposal_id: "proposal-1".into(),
                    now_ns: 1
                })
                .unwrap()
                .dispatch
            );
        }
        // Recover the exact durable crash prefix, before any receipt.
        drop(c);
        let root = t.0.join("sessions/session-1");
        let path = root.join("journal.jsonl");
        let mut c = Authority::recover(&path, &root).unwrap();
        c.apply(Input::Connect).unwrap();
        c.apply_with_witnesses(
            Input::Frame {
                surface_id: "surface-1".into(),
                frame: frame(&w, 2),
            },
            vec![w],
        )
        .unwrap();
        let takeover = c
            .apply(Input::TakeControl {
                surface_id: "surface-1".into(),
            })
            .unwrap();
        assert_eq!(takeover.cancelled, ["proposal-1"]);
        assert_eq!(takeover.control_ready, !dispatched);
        let release = c
            .apply(Input::ReleaseControl {
                surface_id: "surface-1".into(),
            })
            .unwrap();
        assert_eq!(release.reason, dispatched.then_some(Refusal::Policy));
        assert_eq!(
            c.state().remaining_budget,
            9,
            "admitted attempts are never refunded"
        );
        let snapshot = c.state().snapshot().unwrap();
        drop(c);
        assert_eq!(
            scan(&path, &root).unwrap().state.snapshot().unwrap(),
            snapshot
        );
    }
}

#[test]
fn v027_cj01_production_stalled_sync_drop_is_bounded() {
    use std::process::Command;
    use std::time::{Duration, Instant};
    if let Some(base) = std::env::var_os("MV_V027_STALL_ROOT") {
        let t = Temp(PathBuf::from(base).join("state"));
        fs::DirBuilder::new().mode(0o700).create(&t.0).unwrap();
        let (mut c, w) = setup(&t);
        let session = t.0.join("sessions/session-1");
        let checkpoint = fs::read(session.join("checkpoint.json")).unwrap();
        c.apply_with_witnesses(
            Input::Frame {
                surface_id: "surface-1".into(),
                frame: frame(&w, 2),
            },
            vec![w],
        )
        .unwrap();
        let base = t.0.parent().unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while !base.join("entered").exists() {
            assert!(
                Instant::now() < deadline,
                "worker never entered intercepted fsync"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        let started = Instant::now();
        drop(c);
        assert!(started.elapsed() < Duration::from_secs(13));
        // Detached storage I/O must fence recovery until the syscall returns.
        assert!(matches!(
            Authority::recover(&session.join("journal.jsonl"), &session),
            Err(JournalError::Locked)
        ));
        fs::write(base.join("release"), b"release").unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let file = fs::File::open(session.join("journal.jsonl")).unwrap();
            if file.try_lock().is_ok() {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "worker retained writer lock after returning"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(
            fs::read(session.join("checkpoint.json")).unwrap(),
            checkpoint,
            "an aborted worker must never publish its pending checkpoint"
        );
        drop(Authority::recover(&session.join("journal.jsonl"), &session).unwrap());
        return;
    }
    let t = Temp::new();
    let source = t.0.join("stall.c");
    fs::write(
        &source,
        r#"
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
int fsync(int fd) {
    int (*real_sync)(int) = dlsym(RTLD_NEXT, "fsync");
    char name[32] = {0};
    pthread_getname_np(pthread_self(), name, sizeof(name));
    const char *root = getenv("MV_V027_STALL_ROOT");
    if (root && strcmp(name, "mv-journal-sync") == 0) {
        char entered[4096], release[4096];
        snprintf(entered, sizeof(entered), "%s/entered", root);
        snprintf(release, sizeof(release), "%s/release", root);
        int marker = open(entered, O_CREAT | O_WRONLY, 0600);
        if (marker >= 0) close(marker);
        while (access(release, F_OK) != 0) usleep(1000);
    }
    return real_sync(fd);
}
"#,
    )
    .unwrap();
    let library = t.0.join("stall.so");
    assert!(
        Command::new(std::env::var_os("CC").unwrap_or_else(|| "cc".into()))
            .args(["-shared", "-fPIC", "-o"])
            .arg(&library)
            .arg(source)
            .args(["-ldl", "-pthread"])
            .status()
            .unwrap()
            .success()
    );
    // This integration child links the production library: cfg(test) hooks
    // cannot release its genuinely stalled fsync during Drop.
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "v027_cj01_production_stalled_sync_drop_is_bounded",
            "--nocapture",
        ])
        .env("LD_PRELOAD", library)
        .env("MV_V027_STALL_ROOT", &t.0)
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(status.success(), "stalled-sync child failed: {status}");
            break;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("production Drop exceeded watchdog with fsync stalled");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
