#![forbid(unsafe_code)]
// [TARGET, unit decision] Hosted core slice, not a live adapter/UI substitute.
use metaviewer_core::admission::*;
use metaviewer_core::{Component, Endpoint, Refusal};
use serde_json::json;
use std::{fs, path::PathBuf, os::unix::fs::DirBuilderExt};
fn request(n:u64, generation:u64, hash:&str) -> AdmissionRequest {
    let value=json!({"schema":"envelope/v0.2","msg_id":format!("m{n}"),"ts_ns":0,
      "from":{"component":"agent","instance":"agent-1"},"to":{"component":"core","instance":"core-1"},
      "session_id":"session-1","seq":n,"nonce":format!("n{n}"),
      "body":{"schema":"action_proposal/v0.2","proposal_id":format!("p{n}"),"surface_id":"capsule-e2e-1",
      "based_on_frame":{"sha256":hash,"generation":generation},
      "action":{"type":"click","x":1,"y":2,"button":"left"},
      "expectation":{"type":"text_present","text":"ready"},"budget":{"max_ms":100,"max_retries":0}}});
    AdmissionRequest::decode(&value.to_string(), &Endpoint{component:Component::Agent,instance:"agent-1".into()},"session-1",1,0).unwrap()
}
fn main(){
 let root=PathBuf::from(std::env::args().nth(1).unwrap());
 fs::DirBuilder::new().mode(0o700).recursive(true).create(&root).unwrap();
 let mut a=Authority::create(&root,CoreState::session("session-1").unwrap()).unwrap();
 let w7=a.retain_witness(b"frame7").unwrap(); let w8=a.retain_witness(b"a").unwrap();
 let frame=|generation,sha256:String|Frame{generation,sha256,width:10,height:10};
 // Six fixed events: connect, create+initial frame, admit, advance, refuse, take.
 a.apply(Input::Connect).unwrap();
 a.apply_with_witnesses(Input::Surface{id:"capsule-e2e-1".into(),surface:Surface{
 display:"display-1".into(),owner:Endpoint{component:Component::Agent,instance:"agent-1".into()},
 agent_controlled:true,live:true,frame:Some(frame(7,w7.sha256.clone())),refresh_after:None,allowed_verbs:vec![]}},vec![w7.clone()]).unwrap();
 assert_eq!(a.apply_with_witnesses(Input::Propose(request(1,7,&w7.sha256)),vec![w7.clone()]).unwrap().reason,None);
 assert_eq!(a.state().remaining_budget,9999);
 a.apply_with_witnesses(Input::Frame{surface_id:"capsule-e2e-1".into(),frame:frame(8,w8.sha256.clone())},vec![w8.clone()]).unwrap();
 let before=a.state().domain_snapshot().unwrap(); let budget=a.state().remaining_budget; let seq=a.state().core_seq;
 let stale=a.apply(Input::Propose(request(2,7,&w7.sha256))).unwrap();
 assert_eq!(stale.reason,Some(Refusal::StaleFrame)); assert!(!stale.dispatch);
 assert_eq!(stale.core_seq,seq+1);
 assert_eq!(before,a.state().domain_snapshot().unwrap()); assert_eq!(budget,a.state().remaining_budget);
 let take=a.apply(Input::TakeControl{surface_id:"capsule-e2e-1".into()}).unwrap();
 assert_eq!(take.cancelled,vec!["p1"]); assert_eq!(take.cancellation_reason,Some(Refusal::SurfaceNotAgentControlled));
 fs::write(root.join("golden-snapshot.json"),a.state().snapshot().unwrap()).unwrap();
 // Stop the six-event journal here for the independent golden oracle.
 drop(a);
 let session=root.join("sessions/session-1");
 let mut a=Authority::recover(&session.join("journal.jsonl"),&session).unwrap();
 // Remaining handoff/dispatch/receipt path is checked in a separate session
 // when --full is given, leaving the six-event golden stable.
 if std::env::args().any(|arg|arg=="--full") {
  a.apply_with_witnesses(Input::Frame{surface_id:"capsule-e2e-1".into(),frame:frame(9,w8.sha256.clone())},vec![w8.clone()]).unwrap();
  assert_eq!(a.apply(Input::Propose(request(3,9,&w8.sha256))).unwrap().reason,Some(Refusal::SurfaceNotAgentControlled));
  assert!(a.apply(Input::ReleaseControl{surface_id:"capsule-e2e-1".into()}).unwrap().reason.is_none());
  a.apply_with_witnesses(Input::Frame{surface_id:"capsule-e2e-1".into(),frame:frame(10,w8.sha256.clone())},vec![w8.clone()]).unwrap();
  assert!(a.apply_with_witnesses(Input::Propose(request(4,10,&w8.sha256)),vec![w8.clone()]).unwrap().reason.is_none());
  assert!(a.apply(Input::Dispatch{proposal_id:"p4".into(),now_ns:0}).unwrap().dispatch);
  let take=a.apply(Input::TakeControl{surface_id:"capsule-e2e-1".into()}).unwrap(); assert!(!take.control_ready);
  assert_eq!(a.apply(Input::ReleaseControl{surface_id:"capsule-e2e-1".into()}).unwrap().reason,Some(Refusal::Policy));
  assert!(a.apply(Input::Drain{proposal_id:"p4".into(),epoch:1}).unwrap().control_ready);
  a.apply(Input::ReleaseControl{surface_id:"capsule-e2e-1".into()}).unwrap();
  a.apply_with_witnesses(Input::Frame{surface_id:"capsule-e2e-1".into(),frame:frame(11,w8.sha256.clone())},vec![w8.clone()]).unwrap();
  assert!(a.apply_with_witnesses(Input::Propose(request(5,11,&w8.sha256)),vec![w8.clone()]).unwrap().reason.is_none());
  assert!(a.apply(Input::Dispatch{proposal_id:"p5".into(),now_ns:0}).unwrap().dispatch);
  assert!(a.apply(Input::Receipt{proposal_id:"p5".into(),epoch:1}).unwrap().reason.is_none());
  assert!(a.state().pending.is_empty());
 }
 println!("{}",String::from_utf8(a.state().snapshot().unwrap()).unwrap());
}
