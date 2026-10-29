// Included by journal::recovery_fix so the regressions use the existing private
// crash hooks. The standalone integration target intentionally exposes no hooks.
#[allow(unused_macros)]
macro_rules! journal_recovery_regressions {
    () => {
        struct Fixture {
            base: PathBuf,
            state_dir: PathBuf,
            session: PathBuf,
        }
        impl Fixture {
            fn new(name: &str) -> Self {
                let base =
                    std::env::temp_dir().join(format!("mv-recovery-{name}-{}", std::process::id()));
                fs::DirBuilder::new().mode(0o700).create(&base).unwrap();
                let state_dir = base.join("nested/state");
                let session = state_dir.join("sessions/session-1");
                Self {
                    base,
                    state_dir,
                    session,
                }
            }
            fn path(&self) -> PathBuf {
                self.session.join("journal.jsonl")
            }
        }
        impl Drop for Fixture {
            fn drop(&mut self) {
                clear_root_hooks(&self.session);
                let _ = fs::remove_dir_all(&self.base);
            }
        }
        fn connect(journal: &mut Journal, state: &mut CoreState) {
            let outcome = state.apply(&Input::Connect).unwrap();
            journal
                .append(&Input::Connect, &outcome, state, vec![])
                .unwrap();
        }

        #[test]
        fn stale_json_valid_next_torn_tail_keeps_newest() {
            let f = Fixture::new("newest");
            let mut state = CoreState::session("session-1").unwrap();
            let mut journal = Journal::create(&f.state_dir, &state).unwrap();
            connect(&mut journal, &mut state);
            let older = fs::read(f.session.join("checkpoint.json")).unwrap();
            connect(&mut journal, &mut state);
            let newer = fs::read(f.session.join("checkpoint.json")).unwrap();
            let committed = state.clone();
            fail_next_append_with_torn_journal(&f.session);
            let outcome = state.apply(&Input::Connect).unwrap();
            assert_eq!(
                journal.append(&Input::Connect, &outcome, &state, vec![]),
                Err(JournalError::Io)
            );
            drop(journal);
            fs::write(f.session.join("checkpoint.json"), older).unwrap();
            fs::write(f.session.join("checkpoint.next"), newer).unwrap();
            assert_eq!(
                scan(&f.path(), &f.session).unwrap_err(),
                JournalError::MissingLf
            );

            let (recovered, actual) = Journal::recover(&f.path(), &f.session).unwrap();
            assert_eq!(recovered.count, 2);
            assert_eq!(actual, committed);
            assert_eq!(scan(&f.path(), &f.session).unwrap().state, committed);
            assert!(f.session.join("events/2.json").exists());
            assert!(!f.session.join("events/3.json").exists());
        }

        #[test]
        fn tail_state_corruption_treated_as_torn() {
            let f = Fixture::new("tail-state");
            let mut state = CoreState::session("session-1").unwrap();
            let mut journal = Journal::create(&f.state_dir, &state).unwrap();
            connect(&mut journal, &mut state);
            let committed = state.clone();
            let checkpoint = fs::read(f.session.join("checkpoint.json")).unwrap();
            connect(&mut journal, &mut state);
            // Model a crash after the next journal sync, before checkpoint publication.
            fail_next_after_journal_sync(&f.session);
            let outcome = state.apply(&Input::Connect).unwrap();
            assert_eq!(
                journal.append(&Input::Connect, &outcome, &state, vec![]),
                Err(JournalError::Io)
            );
            drop(journal);
            fs::write(f.session.join("checkpoint.json"), checkpoint).unwrap();
            let event_path = f.session.join("events/3.json");
            let mut event: Event = parse(&fs::read(&event_path).unwrap()).unwrap();
            let original_record = event.record.clone();
            // Named mutation: valid canonical JSON and identical linkage/record,
            // but a snapshot from the committed prefix rather than the tail state.
            event.state = serde_json::from_slice(&committed.snapshot().unwrap()).unwrap();
            assert_eq!(event.record, original_record);
            fs::write(&event_path, json(&event).unwrap()).unwrap();
            assert!(scan(&f.path(), &f.session).is_err());

            let (recovered, actual) = Journal::recover(&f.path(), &f.session).unwrap();
            assert_eq!(recovered.count, 1);
            assert_eq!(actual, committed);
            assert_eq!(scan(&f.path(), &f.session).unwrap().state, committed);
            assert!(!f.session.join("events/2.json").exists());
            assert!(!f.session.join("events/3.json").exists());
        }

        #[test]
        fn create_syncs_state_dir() {
            let f = Fixture::new("create-sync");
            enable_sync_trace(&f.session);
            let state = CoreState::session("session-1").unwrap();
            let journal = Journal::create(&f.state_dir, &state).unwrap();
            let trace = take_sync_trace(&f.session);
            let sessions = trace.iter().position(|p| p == "..").unwrap();
            let state_dir = trace
                .iter()
                .position(|p| p == "../..")
                .expect("state-dir sync");
            assert!(
                sessions < state_dir,
                "child entries must persist before their parent"
            );
            assert_eq!(&trace[state_dir + 1..], ["state-parent", "state-parent"]);
            drop(journal);
            let (_recovered, actual) = Journal::recover(&f.path(), &f.session).unwrap();
            assert_eq!(actual, state);
        }
    };
}
