//! [TARGET, unit decision] Export is a deterministic ustar of RGB24 PNGs, with
//! zero timestamps/owners and private entries. Bounds: 16 MiB archive, 4096
//! frames, 4096 pixels per axis. No disk access occurs before RAM validation.
//! Linux descriptor-relative publication uses an exclusive temporary and a
//! no-clobber hard link. The serve owner journals the receipt before commit;
//! dropping an uncommitted publication removes it (including on journal error).
use super::*;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::PathBuf;
#[cfg(test)]
use std::sync::atomic::{AtomicU64, Ordering};

const EXPORT_LIMIT: usize = 16 * 1024 * 1024;
#[cfg(test)]
static SERIAL: AtomicU64 = AtomicU64::new(0);

pub struct ExportPlan {
    pub receipt: Value,
    bytes: Vec<u8>,
    name: String,
}
/// Only unlink names created by this transaction, anchored to its directory FD.
pub struct Publication {
    directory: File,
    temporary: Option<PathBuf>,
    published: Option<PathBuf>,
}
impl Drop for Publication {
    fn drop(&mut self) {
        if let Some(path) = &self.published {
            let _ = fs::remove_file(path);
        }
        if let Some(path) = &self.temporary {
            let _ = fs::remove_file(path);
        }
        let _ = self.directory.sync_all();
    }
}
impl Publication {
    pub fn commit(mut self) {
        self.published = None;
    }
}

impl Host {
    pub fn export_plan(&self, id: &str) -> Result<ExportPlan, &'static str> {
        if !valid_id(id) {
            return Err("CAPTURE_UNKNOWN");
        }
        let row = self.rows.get(id).ok_or("CAPTURE_UNKNOWN")?;
        if row["sealed"] != true {
            return Err("NOT_SEALED");
        }
        let frames = self.pixels.get(id).ok_or("CAPTURE_UNAVAILABLE")?;
        if frames.is_empty() {
            return Err("CAPTURE_UNAVAILABLE");
        }
        if frames.len() > 4096 {
            return Err("LIMIT");
        }
        let mut bytes = Vec::new();
        for (index, frame) in frames.iter().enumerate() {
            let png = png(frame)?;
            let padded = png.len().div_ceil(512) * 512;
            if bytes.len() + 512 + padded + 1024 > EXPORT_LIMIT {
                return Err("LIMIT");
            }
            let name = format!("frames/{index:08}.png");
            let mut header = [0_u8; 512];
            header[..name.len()].copy_from_slice(name.as_bytes());
            header[100..108].copy_from_slice(b"0000600\0");
            header[108..116].copy_from_slice(b"0000000\0");
            header[116..124].copy_from_slice(b"0000000\0");
            header[124..136].copy_from_slice(format!("{:011o}\0", png.len()).as_bytes());
            header[136..148].copy_from_slice(b"00000000000\0");
            header[148..156].fill(b' ');
            header[156] = b'0';
            header[257..263].copy_from_slice(b"ustar\0");
            header[263..265].copy_from_slice(b"00");
            let sum: u32 = header.iter().map(|b| *b as u32).sum();
            header[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
            bytes.extend_from_slice(&header);
            bytes.extend_from_slice(&png);
            bytes.resize(bytes.len() + padded - png.len(), 0);
        }
        bytes.resize(bytes.len() + 1024, 0);
        let digest = sha256_hex(&bytes);
        Ok(ExportPlan {
            receipt: json!({"id":id,"bytes":bytes.len(),"sha256":digest}),
            name: format!("{id}-{digest}.tar"),
            bytes,
        })
    }
}

impl ExportPlan {
    #[cfg(test)]
    pub fn publish(&self, destination: &Path) -> Result<Publication, &'static str> {
        self.publish_transaction(destination, SERIAL.fetch_add(1, Ordering::Relaxed))
    }
    pub fn publish_transaction(
        &self,
        destination: &Path,
        transaction: u64,
    ) -> Result<Publication, &'static str> {
        let directory = pin_directory(destination).map_err(|_| "DESTINATION_UNAVAILABLE")?;
        // Refuse explicitly read-only directories even for a privileged host.
        if directory
            .metadata()
            .map_err(|_| "DESTINATION_UNAVAILABLE")?
            .mode()
            & 0o222
            == 0
        {
            return Err("DESTINATION_UNAVAILABLE");
        }
        let base = PathBuf::from(format!("/proc/self/fd/{}", directory.as_raw_fd()));
        let final_path = base.join(&self.name);
        let mut publication = Publication {
            directory,
            temporary: None,
            published: None,
        };
        let temporary = base.join(format!(".mv-export-{}-{transaction}", self.name));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)
            .map_err(|_| "DESTINATION_UNAVAILABLE")?;
        publication.temporary = Some(temporary.clone());
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|_| "DESTINATION_UNAVAILABLE")?;
        file.write_all(&self.bytes)
            .and_then(|()| file.sync_all())
            .map_err(|_| "DESTINATION_UNAVAILABLE")?;
        // Re-open the entire configured path: a vanished/replaced grant refuses.
        let check = pin_directory(destination).map_err(|_| "DESTINATION_UNAVAILABLE")?;
        let before = publication
            .directory
            .metadata()
            .map_err(|_| "DESTINATION_UNAVAILABLE")?;
        let after = check.metadata().map_err(|_| "DESTINATION_UNAVAILABLE")?;
        if (before.dev(), before.ino()) != (after.dev(), after.ino()) {
            return Err("DESTINATION_UNAVAILABLE");
        }
        fs::hard_link(&temporary, &final_path).map_err(|e| {
            if e.kind() == io::ErrorKind::AlreadyExists {
                "DESTINATION_EXISTS"
            } else {
                "DESTINATION_UNAVAILABLE"
            }
        })?;
        publication.published = Some(final_path.clone());
        // A directory writer may replace a temporary name. Prove the published
        // inode is our still-open regular file without following a substituted link.
        let held = file.metadata().map_err(|_| "DESTINATION_UNAVAILABLE")?;
        let linked = fs::symlink_metadata(&final_path).map_err(|_| "DESTINATION_UNAVAILABLE")?;
        if !linked.is_file() || (held.dev(), held.ino()) != (linked.dev(), linked.ino()) {
            return Err("DESTINATION_UNAVAILABLE");
        }
        fs::remove_file(&temporary).map_err(|_| "DESTINATION_UNAVAILABLE")?;
        publication.temporary = None;
        publication
            .directory
            .sync_all()
            .map_err(|_| "DESTINATION_UNAVAILABLE")?;
        Ok(publication)
    }
}

/// Reconcile only a journal-pinned final name. Never follow a replaced link or
/// read an unbounded archive; a mismatch is removed before capture resumes.
pub fn recover(destination: &Path, receipt: &Value, transaction: u64) -> io::Result<bool> {
    let id = receipt["id"]
        .as_str()
        .filter(|id| valid_id(id))
        .ok_or_else(|| io::Error::other("export recovery id"))?;
    let digest = receipt["sha256"]
        .as_str()
        .filter(|s| {
            s.len() == 64
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
        .ok_or_else(|| io::Error::other("export recovery digest"))?;
    let directory = pin_directory(destination)?;
    let base = PathBuf::from(format!("/proc/self/fd/{}", directory.as_raw_fd()));
    let path = base.join(format!("{id}-{digest}.tar"));
    match fs::remove_file(base.join(format!(".mv-export-{id}-{digest}.tar-{transaction}"))) {
        Ok(()) => directory.sync_all()?,
        Err(e) if e.kind() == io::ErrorKind::NotFound => (),
        Err(e) => return Err(e),
    }
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    };
    let mut valid = false;
    if metadata.is_file() && metadata.len() <= EXPORT_LIMIT as u64 {
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(libc_flags())
            .open(&path)?;
        let held = file.metadata()?;
        if (held.dev(), held.ino()) != (metadata.dev(), metadata.ino()) {
            return Err(io::Error::other("export recovery inode"));
        }
        let mut bytes = Vec::new();
        (&mut file)
            .take(EXPORT_LIMIT as u64 + 1)
            .read_to_end(&mut bytes)?;
        valid = receipt["bytes"].as_u64() == Some(bytes.len() as u64)
            && sha256_hex(&bytes) == digest
            && held.mode() & 0o777 == 0o600;
    }
    if !valid {
        fs::remove_file(&path)?;
        directory.sync_all()?;
    }
    Ok(valid)
}
fn libc_flags() -> i32 {
    // O_NOFOLLOW | O_NONBLOCK, Linux ABIs supported by pin_directory.
    if cfg!(target_arch = "aarch64") {
        0x8000 | 0x800
    } else {
        0x20000 | 0x800
    }
}

fn pin_directory(path: &Path) -> io::Result<File> {
    let text = path
        .to_str()
        .ok_or_else(|| io::Error::other("destination encoding"))?;
    if !absolute(text) {
        return Err(io::Error::other("destination path"));
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    let flags = 0x8000 | 0x4000;
    #[cfg(all(target_os = "linux", any(target_arch = "x86", target_arch = "x86_64")))]
    let flags = 0x20000 | 0x10000;
    #[cfg(not(all(
        target_os = "linux",
        any(target_arch = "aarch64", target_arch = "x86", target_arch = "x86_64")
    )))]
    let flags = return Err(io::Error::other("unsupported destination ABI"));
    let open = |p: &Path| OpenOptions::new().read(true).custom_flags(flags).open(p);
    let mut directory = open(Path::new("/"))?;
    for part in path.components() {
        match part {
            Component::RootDir => (),
            Component::Normal(name) => {
                directory = open(
                    &PathBuf::from(format!("/proc/self/fd/{}", directory.as_raw_fd())).join(name),
                )?;
            }
            _ => return Err(io::Error::other("destination component")),
        }
    }
    Ok(directory)
}

fn png(frame: &CapturedFrame) -> Result<Vec<u8>, &'static str> {
    let (width, height) = (frame.frame.width, frame.frame.height);
    if width == 0 || height == 0 || width > 4096 || height > 4096 {
        return Err("LIMIT");
    }
    if width * height * 3 != frame.bytes.len() as u64 {
        return Err("CAPTURE_UNAVAILABLE");
    }
    let mut raw = Vec::with_capacity(frame.bytes.len() + height as usize);
    for row in frame.bytes.chunks_exact(width as usize * 3) {
        raw.push(0); // PNG filter: none
        raw.extend_from_slice(row);
    }
    // RFC1950 zlib with RFC1951 stored blocks; deterministic, no codec dependency.
    let mut zlib = vec![0x78, 0x01];
    for (index, block) in raw.chunks(65535).enumerate() {
        zlib.push(u8::from((index + 1) * 65535 >= raw.len()));
        let length = block.len() as u16;
        zlib.extend_from_slice(&length.to_le_bytes());
        zlib.extend_from_slice(&(!length).to_le_bytes());
        zlib.extend_from_slice(block);
    }
    let (mut a, mut b) = (1_u32, 0_u32);
    for byte in raw {
        a = (a + byte as u32) % 65521;
        b = (b + a) % 65521;
    }
    zlib.extend_from_slice(&((b << 16) | a).to_be_bytes());
    let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&(width as u32).to_be_bytes());
    ihdr.extend_from_slice(&(height as u32).to_be_bytes());
    ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
    chunk(&mut out, b"IHDR", &ihdr);
    chunk(&mut out, b"IDAT", &zlib);
    chunk(&mut out, b"IEND", &[]);
    Ok(out)
}
fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let mut crc = !0_u32;
    for byte in kind.iter().chain(data) {
        crc ^= *byte as u32;
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb88320 & (0_u32.wrapping_sub(crc & 1)));
        }
    }
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    out.extend_from_slice(&(!crc).to_be_bytes());
}

#[cfg(test)]
mod tests;
