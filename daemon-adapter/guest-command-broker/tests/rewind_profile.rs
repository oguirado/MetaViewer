#![cfg(feature = "rewind-profile")]
use guest_command_broker::{bootstrap, rewind::{Boot,Counter,Reset,ResetLedger,reset_length}};
use serde_json::{json,Value};
fn value() -> Value {json!({"schema":"rewind_guest_reset/v0.2","op":"reseed","boot_token":"a".repeat(64),"session_id":"session-first","authority_epoch":1,"command_generation":1,"workload_id":"workload-first","owner_id":"actor-first","reservation_id":"reservation-first","challenge":"b".repeat(64),"entropy":"cd".repeat(64)})}
fn parse(v:Value)->std::io::Result<Reset>{Reset::parse(&serde_json::to_vec(&v).unwrap())}
#[test] fn explicit_new_boot_only_normal_unchanged(){
 let nonce="a".repeat(64);let r=format!("console=ttyS0 mv_rewind=1 mv_nonce={nonce}");
 assert!(Boot::parse(&r).is_ok());assert!(bootstrap::Boot::parse(&r).is_err());
 for bad in [format!("{r} mv_rewind=1"),format!("{r} mv_guest_command=1"),r.replace("=1","=0"),r.replace("aaaa","AAAA")] {assert!(Boot::parse(&bad).is_err());}
 assert_eq!(bootstrap::GUEST_MS,60000);
}
#[test] fn closed_reset_bound_and_identity_grammars(){
 assert!(parse(value()).is_ok());
 for (key,bad) in [("schema",json!("other")),("op",json!("exec")),("authority_epoch",json!(0)),("command_generation",json!(9007199254740992u64)),("owner_id",json!("foreign")),("workload_id",json!("bad")),("reservation_id",json!("bad")),("session_id",json!("../bad")),("entropy",json!("0".repeat(128))),("challenge",json!("B".repeat(64)))]{let mut v=value();v[key]=bad;assert!(parse(v).is_err(),"{key}");}
 let mut v=value();v["extra"]=json!(true);assert!(parse(v).is_err());
 let raw=serde_json::to_string(&value()).unwrap();let duplicate=raw.replacen("{","{\"op\":\"reseed\",",1);assert!(Reset::parse(duplicate.as_bytes()).is_err());
 assert!(Reset::parse(&vec![b' ';4097]).is_err());
}
#[test] fn reset_header_does_not_accept_mvgc_or_unbounded(){
 let mut h=b"RWR1\0\0\0\x01".to_vec();assert_eq!(reset_length(&h).unwrap(),1);
 for n in [0u32,4097,u32::MAX]{h[4..].copy_from_slice(&n.to_be_bytes());assert!(reset_length(&h).is_err());}
 assert!(reset_length(b"MVGC\0\0\0\x01").is_err());assert!(reset_length(b"RWR1").is_err());
}
#[test] fn authority_requires_fresh_epoch_session_challenge_entropy(){
 let boot="a".repeat(64);let r=parse(value()).unwrap();let mut l=ResetLedger::default();
 assert!(l.validate(&r,&"f".repeat(64)).is_err());l.record_validated(&r,&boot).unwrap();assert!(l.validate(&r,&boot).is_err());
 for unchanged in ["authority_epoch","command_generation","session_id","challenge","entropy"] {let mut v=value();v["authority_epoch"]=json!(2);v["command_generation"]=json!(2);v["session_id"]=json!("session-new");v["challenge"]=json!("e".repeat(64));v["entropy"]=json!("ef".repeat(64));v[unchanged]=value()[unchanged].clone();assert!(l.validate(&parse(v).unwrap(),&boot).is_err(),"{unchanged}");}
 let mut next=value();next["authority_epoch"]=json!(2);next["command_generation"]=json!(2);next["session_id"]=json!("session-new");next["challenge"]=json!("e".repeat(64));next["entropy"]=json!("ef".repeat(64));l.record_validated(&parse(next).unwrap(),&boot).unwrap();
}
#[test] fn counter_survives_ten_minutes_without_changing_command_deadline(){
 let mut c=Counter::new(500);assert!(!c.advance(1499).unwrap());assert!(c.advance(600500).unwrap());assert_eq!(c.value(),600);assert!(c.advance(600499).is_err());
 assert!(guest_command_broker::supervision::Deadline::new(0,60001,u64::MAX-10000).is_err());assert!(guest_command_broker::supervision::Deadline::new(0,60000,u64::MAX-10000).is_ok());
}
