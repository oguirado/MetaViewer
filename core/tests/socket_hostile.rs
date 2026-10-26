#![forbid(unsafe_code)]
use metaviewer_core::journal::{scan, sha256_hex};
use metaviewer_core::transport::*;
use metaviewer_core::wire::*;
use std::fs;
use std::os::unix::fs::{DirBuilderExt, MetadataExt};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "mv-socket-hostile-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&p).unwrap();
        Self(p)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub fn uid() -> u32 {
    tokio::net::UnixStream::pair()
        .unwrap()
        .0
        .peer_cred()
        .unwrap()
        .uid()
}

fn hello_env() -> Envelope {
    let raw = include_str!("../../contracts/examples/v0.2/envelope.valid.json");
    let mut env_val: serde_json::Value = serde_json::from_str(raw).unwrap();
    env_val["body"] = serde_json::from_str(include_str!(
        "../../contracts/examples/v0.2/hello.valid.json"
    ))
    .unwrap();
    env_val["from"]["component"] = env_val["body"]["component"].clone();
    decode_envelope(&env_val.to_string()).unwrap()
}

#[test]
fn hostile_socket_binding_and_symlinks() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();

    rt.block_on(async {
        let tmp = Temp::new();
        let runtime_dir = tmp.0.join("runtime");
        let path = runtime_dir.join("core.sock");
        let my_uid = uid();

        // 1. Hostile umask parent creation yields 0700 dir and 0600 socket
        let listener = bind_owner_only(&path, my_uid, Duration::from_millis(100))
            .await
            .unwrap();
        assert_eq!(
            fs::symlink_metadata(&runtime_dir).unwrap().mode() & 0o7777,
            0o700
        );
        assert_eq!(fs::symlink_metadata(&path).unwrap().mode() & 0o7777, 0o600);
        drop(listener);

        // 2. Symlink in any parent component is refused
        let link_parent = tmp.0.join("sym_runtime");
        std::os::unix::fs::symlink(&runtime_dir, &link_parent).unwrap();
        assert_eq!(
            bind_owner_only(
                &link_parent.join("core.sock"),
                my_uid,
                Duration::from_millis(100)
            )
            .await
            .err(),
            Some(BindError::UnsafeRuntimeDir)
        );

        // 3. Preexisting regular file / symlink at target path preserved, never replaced
        let reg_path = runtime_dir.join("regular.file");
        fs::write(&reg_path, b"do-not-overwrite").unwrap();
        assert_eq!(
            bind_owner_only(&reg_path, my_uid, Duration::from_millis(100))
                .await
                .err(),
            Some(BindError::NotSocket)
        );
        assert_eq!(fs::read(&reg_path).unwrap(), b"do-not-overwrite");

        let sym_path = runtime_dir.join("sym.sock");
        std::os::unix::fs::symlink(&path, &sym_path).unwrap();
        assert_eq!(
            bind_owner_only(&sym_path, my_uid, Duration::from_millis(100))
                .await
                .err(),
            Some(BindError::NotSocket)
        );

        // 4. Live socket refusal
        let live_listener = bind_owner_only(&path, my_uid, Duration::from_millis(100))
            .await
            .unwrap();
        let _conn = tokio::net::UnixStream::connect(&path).await.unwrap();

        assert_eq!(
            bind_owner_only(&path, my_uid, Duration::from_millis(100))
                .await
                .err(),
            Some(BindError::LiveSocket)
        );
        drop(_conn);
        drop(live_listener);
    });
}

#[test]
fn handshake_hostility_version_pin_identity_timeout() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();

    rt.block_on(async {
        let env = hello_env();
        let Command::Hello(hello) = &env.body else {
            panic!("expected hello")
        };
        let my_uid = uid();

        let policy = HandshakePolicy::new(
            my_uid,
            env.from.clone(),
            env.to.clone(),
            env.session_id.clone(),
            *hello.clone(),
        )
        .unwrap();

        let limits = WireLimits::default();

        // 1. Successful handshake
        let (mut client, mut server) = tokio::net::UnixStream::pair().unwrap();
        let pol = policy.clone();
        let lim = limits.clone();
        let server_handle = tokio::spawn(async move { handshake(&mut server, &pol, &lim).await });

        write_frame(&mut client, &env).await.unwrap();
        let ready_peer = server_handle.await.unwrap().unwrap();
        assert_eq!(ready_peer.uid(), my_uid);
        assert_eq!(ready_peer.endpoint(), &env.from);
        assert_eq!(ready_peer.session_id(), env.session_id);

        // Double hello error on ready peer check
        assert_eq!(
            ready_peer.check_sender(&env).err(),
            Some(HandshakeError::AlreadyReady)
        );

        // 2. Pin mismatch
        let (mut client, mut server) = tokio::net::UnixStream::pair().unwrap();
        let mut env_val = serde_json::to_value(&env).unwrap();
        env_val["body"]["component_version"] = serde_json::json!("unexpected");
        let env_bad_pin: Envelope = serde_json::from_value(env_val).unwrap();

        let pol = policy.clone();
        let lim = limits.clone();
        let server_handle = tokio::spawn(async move { handshake(&mut server, &pol, &lim).await });

        write_frame(&mut client, &env_bad_pin).await.unwrap();
        assert_eq!(
            server_handle.await.unwrap().err(),
            Some(HandshakeError::PinMismatch)
        );

        // 3. Deadline enforced from accepted_at (sleep past deadline -> Timeout)
        let (mut _client, mut server) = tokio::net::UnixStream::pair().unwrap();
        let past_accepted = tokio::time::Instant::now() - Duration::from_secs(6);
        let res_timeout = handshake_at(&mut server, &policy, &limits, past_accepted).await;
        assert_eq!(res_timeout.err(), Some(HandshakeError::Timeout));
    });
}

#[test]
fn mv_replay_cli_exit_codes_and_verify_only() {
    let tmp = Temp::new();

    // Create a valid journal
    let mut c = metaviewer_core::admission::Authority::create(
        &tmp.0,
        metaviewer_core::admission::CoreState::session("session-1").unwrap(),
    )
    .unwrap();
    c.apply(metaviewer_core::admission::Input::Connect).unwrap();
    drop(c);

    let path = tmp.0.join("sessions/session-1/journal.jsonl");
    let root = path.parent().unwrap();

    let run_cmd = |extra: &[&str]| {
        std::process::Command::new(env!("CARGO_BIN_EXE_mv-replay"))
            .args([
                "--journal",
                path.to_str().unwrap(),
                "--witness-root",
                root.to_str().unwrap(),
            ])
            .args(extra)
            .output()
            .unwrap()
    };

    // Exit 0 on valid journal with digest matching scan
    let ok_out = run_cmd(&[]);
    assert_eq!(ok_out.status.code(), Some(0));
    let digest = String::from_utf8(ok_out.stdout).unwrap().trim().to_owned();
    let scan_replay = scan(&path, root).unwrap();
    assert_eq!(digest, sha256_hex(&scan_replay.state.snapshot().unwrap()));

    // --verify-only mode prints nothing on stdout and exits 0
    let verify_out = run_cmd(&["--verify-only"]);
    assert_eq!(verify_out.status.code(), Some(0));
    assert!(verify_out.stdout.is_empty());

    // Exit 2 on corrupt journal
    fs::write(&path, b"corrupt").unwrap();
    let corrupt_out = run_cmd(&[]);
    assert_eq!(corrupt_out.status.code(), Some(2));
    assert!(corrupt_out.stdout.is_empty());
}
