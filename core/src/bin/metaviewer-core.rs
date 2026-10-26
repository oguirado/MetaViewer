#![forbid(unsafe_code)]
use metaviewer_core::serve::{self, Config, Result, Server};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
async fn run() -> Result<()> {
    let config: Config = serde_json::from_slice(&std::fs::read(
        std::env::var_os("MV_CORE_CONFIG").ok_or("MV_CORE_CONFIG required")?,
    )?)?;
    let uid = serve::effective_uid()?;
    config.validate(uid)?;
    let path =
        PathBuf::from(std::env::var_os("XDG_RUNTIME_DIR").ok_or("XDG_RUNTIME_DIR required")?)
            .join("metaviewer/core.sock");
    let listener = serve::bind(&path, uid).await?;
    let server = Server::open(config, &serve::state_dir()?, uid)?;
    serve::serve(listener, Arc::new(Mutex::new(server)), uid).await
}
fn main() {
    let result = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(Into::into)
        .and_then(|rt| rt.block_on(run()));
    if let Err(error) = result {
        eprintln!("metaviewer-core: {error}");
        std::process::exit(2);
    }
}
