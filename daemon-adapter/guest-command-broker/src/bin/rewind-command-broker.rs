use guest_command_broker::{bootstrap, guard::GuestAuthority, rewind};
fn main() {
    let authority=match GuestAuthority::detect() { Ok(a)=>a, Err(_)=>{eprintln!("rewind broker requires root ARM64 PID1");std::process::exit(78);} };
    let mut phase="read_rewind_boot";
    let result=(|| {let boot=bootstrap::read_rewind_boot(&authority)?; phase="prepare";bootstrap::prepare(&authority)?;phase="rewind_serve";rewind::serve(&authority,boot)})();
    if let Err(error)=result {eprintln!("rewind_broker failed phase={} errno={:?} kind={:?}",phase,error.raw_os_error(),error.kind());}
    let _=bootstrap::poweroff(&authority);
    std::process::exit(78);
}
