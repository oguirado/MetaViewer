#![forbid(unsafe_code)]
use metaviewer_core::admission::{AdmissionRequest, CoreState, Input, LifecycleUpdate, Surface};
use metaviewer_core::{Component, Endpoint, Refusal};
use serde_json::json;
fn agent() -> Endpoint { Endpoint {component:Component::Agent,instance:"agent-1".into()} }
fn human() -> CoreState {
 let mut s=CoreState::new("role-test",10).unwrap();
 s.apply(&Input::Connect).unwrap();
 s.apply(&Input::Lifecycle{surface_id:"human".into(),update:LifecycleUpdate::Created(Surface{
  display:"display-human".into(),owner:agent(),agent_controlled:false,live:true,frame:None,refresh_after:None,allowed_verbs:vec![]
 })}).unwrap();s
}
fn proposal(n:u64)->AdmissionRequest {
 let raw=json!({"schema":"envelope/v0.2","msg_id":format!("message-{n}"),"session_id":"role-test","ts_ns":0,
 "from":agent(),"to":{"component":"core","instance":"core-1"},"nonce":format!("nonce-{n}"),"seq":n,
 "body":{"schema":"action_proposal/v0.2","proposal_id":format!("proposal-{n}"),"surface_id":"human",
 "based_on_frame":{"generation":1,"sha256":"a".repeat(64)},"action":{"type":"key","keys":["Tab"]},
 "expectation":{"type":"text_present","text":"ready"},"budget":{"max_ms":100,"max_retries":0}}});
 AdmissionRequest::decode(&raw.to_string(),&agent(),"role-test",1,0).unwrap()
}
#[test]
fn human_role_proposal_is_policy_before_frame_or_reservation() {
 let mut s=human();let budget=s.remaining_budget;
 assert_eq!(s.apply(&Input::Propose(proposal(1))).unwrap().reason,Some(Refusal::Policy));
 assert!(s.pending.is_empty());assert!(s.leases.is_empty());assert_eq!(s.remaining_budget,budget);
}
#[test]
fn human_role_cannot_be_released_and_survives_snapshot() {
 let mut s:CoreState=serde_json::from_slice(&human().snapshot().unwrap()).unwrap();
 for input in [Input::TakeControl{surface_id:"human".into()},Input::ReleaseControl{surface_id:"human".into()}] {
  assert_eq!(s.apply(&input).unwrap().reason,Some(Refusal::Policy));
  assert!(!s.surfaces["human"].agent_controlled);
 }
 assert_eq!(s.apply(&Input::Propose(proposal(2))).unwrap().reason,Some(Refusal::Policy));
}
