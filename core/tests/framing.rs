mod support;
use metaviewer_core::*;
use tokio::io::AsyncWriteExt;
#[test]
fn exact_cap_adjacent_frames_and_clean_eof() {
    support::run(async {
        let env = support::fixture();
        let raw = serde_json::to_string(&env).unwrap();
        let limits = support::limits(raw.len() + 1);
        let mut output = Vec::new();
        write_frame_with_limits(&mut output, &env, &limits)
            .await
            .unwrap();
        assert_eq!(output, format!("{raw}\n").into_bytes());
        let doubled = [output.clone(), output].concat();
        let mut input = doubled.as_slice();
        assert_eq!(
            read_frame_with_limits(&mut input, &limits).await.unwrap(),
            Some(env.clone())
        );
        assert_eq!(
            read_frame_with_limits(&mut input, &limits).await.unwrap(),
            Some(env)
        );
        assert_eq!(read_frame(&mut input).await.unwrap(), None);
    });
}
#[test]
fn malformed_incomplete_utf8_and_cap_controls() {
    support::run(async {
        for (data, error) in [
            (b"{".as_slice(), FrameError::Incomplete),
            (b"\xff\n", FrameError::InvalidUtf8),
            (b"{bad}\n", FrameError::Decode(DecodeError::Malformed)),
            (b"\n", FrameError::Decode(DecodeError::Malformed)),
        ] {
            let mut input = data;
            assert_eq!(read_frame(&mut input).await, Err(error));
        }
        let data = vec![b' '; 128];
        let mut input = data.as_slice();
        assert_eq!(
            read_frame_with_limits(&mut input, &support::limits(128)).await,
            Err(FrameError::Oversized)
        );
        let env = support::fixture();
        let raw = serde_json::to_string(&env).unwrap();
        let mut sink = Vec::new();
        assert_eq!(
            write_frame_with_limits(&mut sink, &env, &support::limits(raw.len())).await,
            Err(FrameError::Oversized)
        );
        assert!(sink.is_empty());
        let mut bad = env;
        bad.seq = 0;
        assert!(matches!(
            write_frame(&mut sink, &bad).await,
            Err(FrameError::Decode(_))
        ));
        assert!(sink.is_empty());
    });
}
#[test]
fn fragmented_multibyte_and_deadlines() {
    support::run(async {
        let mut env = support::fixture();
        env.msg_id = "message-é".into();
        let raw = format!("{}\n", serde_json::to_string(&env).unwrap());
        let (mut tx, mut rx) = tokio::io::duplex(1);
        let task = tokio::spawn(async move {
            for b in raw.as_bytes() {
                tx.write_all(&[*b]).await.unwrap();
            }
        });
        assert_eq!(read_frame(&mut rx).await.unwrap(), Some(env.clone()));
        task.await.unwrap();
        let (_tx, mut rx) = tokio::io::duplex(1);
        assert_eq!(
            read_frame_with_limits(&mut rx, &support::limits(MAX_FRAME_BYTES)).await,
            Err(FrameError::Timeout)
        );
        let (mut tx, _rx) = tokio::io::duplex(1);
        assert_eq!(
            write_frame_with_limits(&mut tx, &env, &support::limits(MAX_FRAME_BYTES)).await,
            Err(FrameError::Timeout)
        );
    });
}
