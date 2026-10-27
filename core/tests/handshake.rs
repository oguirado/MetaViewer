mod support;
use metaviewer_core::*;
use tokio::io::AsyncWriteExt;
fn hello_env() -> Envelope {
    let mut env: serde_json::Value = serde_json::to_value(support::fixture()).unwrap();
    env["body"] = serde_json::from_str(include_str!(
        "../../contracts/examples/v0.2/hello.valid.json"
    ))
    .unwrap();
    env["from"]["component"] = env["body"]["component"].clone();
    decode_envelope(&env.to_string()).unwrap()
}
fn policy(env: &Envelope, uid: u32) -> HandshakePolicy {
    let Command::Hello(hello) = &env.body else {
        panic!("expected hello")
    };
    HandshakePolicy::new(
        uid,
        env.from.clone(),
        env.to.clone(),
        env.session_id.clone(),
        *hello.clone(),
    )
    .unwrap()
}
#[test]
fn handshake_completes_within_budget() {
    support::run(async {
        let env = hello_env();
        let expected = policy(&env, support::uid());
        let (mut sender, mut receiver) = tokio::net::UnixStream::pair().unwrap();
        let budget = std::time::Duration::from_secs(10);
        let started = std::time::Instant::now();
        write_frame(&mut sender, &env).await.unwrap();
        let ready = tokio::time::timeout(
            budget,
            handshake(&mut receiver, &expected, &WireLimits::default()),
        )
        .await
        .expect("hello exceeded the handshake budget")
        .expect("valid hello must complete successfully");
        let elapsed = started.elapsed();
        eprintln!("handshake elapsed [MEASURED]: {elapsed:?}");
        assert!(elapsed < budget, "handshake took {elapsed:?}");
        assert_eq!(ready.endpoint(), &env.from);
        assert_eq!(ready.session_id(), env.session_id);
        assert_eq!(ready.uid(), support::uid());
    });
}

#[test]
fn authenticated_hello_binds_identity_and_pins() {
    support::run(async {
        let env = hello_env();
        let uid = support::uid();
        let policy = policy(&env, uid);
        let (mut sender, mut receiver) = tokio::net::UnixStream::pair().unwrap();
        write_frame(&mut sender, &env).await.unwrap();
        let ready = handshake(&mut receiver, &policy, &WireLimits::default())
            .await
            .unwrap();
        assert_eq!(ready.endpoint(), &env.from);
        assert_eq!(ready.uid(), uid);
        assert_eq!(ready.session_id(), env.session_id);
        assert_eq!(ready.check_sender(&env), Err(HandshakeError::AlreadyReady));
        let mut next = support::fixture();
        next.from = env.from.clone();
        next.session_id = env.session_id.clone();
        ready.check_sender(&next).unwrap();
        next.from.instance = "other".into();
        assert_eq!(
            ready.check_sender(&next),
            Err(HandshakeError::IdentityMismatch)
        );
    });
}
#[test]
fn command_identity_pin_version_uid_and_timeout_controls() {
    support::run(async {
        let env = hello_env();
        let uid = support::uid();
        let expected = policy(&env, uid);
        for change in ["command", "identity", "pin", "version"] {
            let mut value = serde_json::to_value(&env).unwrap();
            match change {
                "command" => value["body"] = serde_json::to_value(support::fixture().body).unwrap(),
                "identity" => value["from"]["instance"] = "foreign".into(),
                "pin" => value["body"]["component_version"] = "unexpected".into(),
                "version" => value["body"]["contract_version"] = "v0.0".into(),
                _ => unreachable!(),
            }
            let (mut sender, mut receiver) = tokio::net::UnixStream::pair().unwrap();
            sender
                .write_all(format!("{value}\n").as_bytes())
                .await
                .unwrap();
            let error = match change {
                "command" => HandshakeError::ExpectedHello,
                "identity" => HandshakeError::IdentityMismatch,
                "pin" => HandshakeError::PinMismatch,
                "version" => HandshakeError::VersionMismatch,
                _ => unreachable!(),
            };
            assert_eq!(
                handshake(&mut receiver, &expected, &WireLimits::default()).await,
                Err(error),
                "{change}"
            );
        }
        let (_sender, mut receiver) = tokio::net::UnixStream::pair().unwrap();
        assert!(matches!(
            handshake(
                &mut receiver,
                &policy(&env, uid.checked_add(1).unwrap()),
                &WireLimits::default()
            )
            .await,
            Err(HandshakeError::Peer(PeerCredError::ForeignUid))
        ));
        assert_eq!(
            handshake(&mut receiver, &expected, &support::limits(MAX_FRAME_BYTES)).await,
            Err(HandshakeError::Frame(FrameError::Timeout))
        );
    });
}

#[test]
fn scheduling_does_not_extend_acceptance_deadline() {
    support::run(async {
        let env = hello_env();
        let expected = policy(&env, support::uid());
        let (mut sender, mut receiver) = tokio::net::UnixStream::pair().unwrap();
        write_frame(&mut sender, &env).await.unwrap();
        let accepted_at = tokio::time::Instant::now()
            .checked_sub(std::time::Duration::from_secs(6))
            .unwrap();
        assert_eq!(
            handshake_at(
                &mut receiver,
                &expected,
                &WireLimits::default(),
                accepted_at
            )
            .await,
            Err(HandshakeError::Timeout)
        );
    });
}
