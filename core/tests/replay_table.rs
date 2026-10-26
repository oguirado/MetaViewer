use metaviewer_core::{Component, Endpoint, ReplayError, ReplayTable};

fn sender(instance: &str) -> Endpoint {
    Endpoint {
        component: Component::Agent,
        instance: instance.into(),
    }
}

#[test]
fn replay_refusals_preserve_exact_state() {
    let mut table = ReplayTable::new(4).unwrap();
    let peer = sender("a");
    table.record("s", &peer, "n1", 1).unwrap();
    assert!(table.contains("s", &peer, "n1"));
    for (nonce, seq, error) in [
        ("n1", 2, ReplayError::DuplicateNonce),
        ("n2", 0, ReplayError::ZeroSequence),
        ("n2", 1, ReplayError::NonIncreasingSequence),
    ] {
        let before = table.snapshot();
        assert_eq!(table.record("s", &peer, nonce, seq), Err(error));
        assert_eq!(table.snapshot(), before);
    }
    table.record("s", &peer, "n2", 2).unwrap();
    table.record("s", &sender("b"), "n1", 1).unwrap();
    table.record("other", &peer, "n1", u64::MAX).unwrap();
    let before = table.snapshot();
    assert_eq!(
        table.record("other", &peer, "n2", 1),
        Err(ReplayError::Exhausted)
    );
    assert_eq!(
        table.record("s", &peer, "n3", 3),
        Err(ReplayError::CapacityExceeded)
    );
    assert_eq!(table.snapshot(), before);
}

#[test]
fn identity_limits_use_contract_characters_and_failed_admission_is_atomic() {
    let mut table = ReplayTable::new(2).unwrap();
    let peer = sender(&"é".repeat(128));
    table
        .record(&"é".repeat(128), &peer, &"é".repeat(128), 1)
        .unwrap();
    let before = table.snapshot();
    assert_eq!(
        table.record("", &peer, "new", 2),
        Err(ReplayError::InvalidIdentity)
    );
    assert_eq!(
        table.record("s", &sender(&"é".repeat(129)), "new", 2),
        Err(ReplayError::InvalidIdentity)
    );
    assert_eq!(table.snapshot(), before);
    assert!(ReplayTable::new(0).is_err());
}
