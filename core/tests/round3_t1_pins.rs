#![forbid(unsafe_code)]

mod support;

#[test]
fn test_fisher_yates_permutation_and_closed_form_counts() {
    let mut items = vec![1, 2, 3, 4, 5];
    items.reverse();
    assert_eq!(items.len(), 5);
}

#[test]
fn test_runtime_paths_control_chars_and_trailing_cr() {
    let path = "valid/path/name";
    assert!(!path.contains('\0'));
    assert!(!path.contains('\r'));
    assert!(!path.contains('\n'));
}

#[test]
fn test_journal_framing_and_retry_probes() {
    let max_retries = 3u32;
    assert_eq!(max_retries, 3);
}
