use guest_command_broker::{bootstrap, dispatch, guard::GuestAuthority};
fn main() {
    let authority = match GuestAuthority::detect() {
        Ok(a) => a,
        Err(_) => {
            eprintln!("guest broker requires root ARM64 PID1");
            std::process::exit(78);
        }
    };
    let mut phase = "clock";
    let outcome = (|| {
        let start = bootstrap::now_ms()?;
        phase = "read_boot";
        eprintln!("guest_broker phase=read_boot");
        let boot = bootstrap::read_boot(&authority)?;
        phase = "prepare";
        eprintln!("guest_broker phase=prepare");
        bootstrap::prepare(&authority)?;
        phase = "serve";
        eprintln!("guest_broker phase=serve");
        dispatch::serve(&authority, boot.nonce, start + bootstrap::GUEST_MS)
    })();
    if let Err(error) = outcome {
        eprintln!(
            "guest_broker failed phase={} errno={:?} kind={:?} detail={}",
            phase,
            error.raw_os_error(),
            error.kind(),
            error
        );
    }
    let _ = bootstrap::poweroff(&authority);
    std::process::exit(78);
}
