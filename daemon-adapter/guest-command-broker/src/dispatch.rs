//! Single-threaded guest actor. All effects require the nonforgeable PID1 guard.
use crate::{
    bootstrap::{self, JOB_GID, JOB_UID},
    guard::GuestAuthority,
    output::Output,
    refused,
    sandbox::{Jail, RelativeCwd},
    spawn::{self, Child, Command},
    supervision::{self, Deadline, JobCgroup, JobCgroups, JobName, Limits},
    transport::{self, Transport},
    wire::Frame,
    Result,
};
use serde_json::json;
use std::{collections::BTreeSet, os::fd::AsRawFd};

#[derive(Default)]
struct History {
    requests: BTreeSet<String>,
    jobs: BTreeSet<String>,
    stopping: bool,
}
impl History {
    fn request(&mut self, id: &str) -> Result<()> {
        if self.requests.len() >= 256 || !self.requests.insert(id.into()) {
            return Err(refused("request reused or history exhausted"));
        }
        Ok(())
    }
    fn job(&mut self, id: &str) -> Result<usize> {
        if self.stopping || self.jobs.len() >= 64 || !self.jobs.insert(id.into()) {
            return Err(refused("job reused/stopped/exhausted"));
        }
        Ok(self.jobs.len())
    }
}
struct Job {
    child: Child,
    group: JobCgroup,
    request: String,
    id: String,
    output: Output,
    queued: [usize; 2],
    chunks: [u64; 2],
    deadline: Deadline,
    status: Option<i32>,
    stdout_eof: bool,
    stderr_eof: bool,
    exec_ok: bool,
    cause: Option<&'static str>,
    kill_at: Option<u64>,
    killed: bool,
    cancel: Option<String>,
    stop: Option<String>,
    terminal_queued: bool,
}
impl Job {
    fn terminate(&mut self, a: &GuestAuthority, cause: &'static str, now: u64) -> Result<()> {
        if self.cause.is_none() {
            self.cause = Some(cause);
            self.child.terminate(a, self.status.is_some())?;
            self.kill_at = Some(now.saturating_add(250));
        }
        Ok(())
    }
    fn poll_exec(&mut self, a: &GuestAuthority) -> Result<()> {
        a.check()?;
        if self.exec_ok {
            return Ok(());
        }
        let mut code = [0u8; 4];
        let n = unsafe {
            libc::read(
                self.child.exec_error.as_raw_fd(),
                code.as_mut_ptr().cast(),
                4,
            )
        };
        if n == 0 {
            self.exec_ok = true;
            return Ok(());
        }
        if n > 0 {
            return Err(refused("child pre-exec failed"));
        }
        let e = std::io::Error::last_os_error();
        if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::Interrupted
        {
            return Ok(());
        }
        Err(e)
    }
    fn queue_output(&mut self, t: &mut Transport) -> Result<()> {
        for stream in 0..2 {
            let bytes = if stream == 0 {
                &self.output.stdout
            } else {
                &self.output.stderr
            };
            while self.queued[stream] < bytes.len() {
                let end = (self.queued[stream] + 16384).min(bytes.len());
                let part = &bytes[self.queued[stream]..end];
                let m=t.event("output",json!({"request_id":self.request,"job_id":self.id,"stream":if stream==0{"stdout"}else{"stderr"},"chunk_index":self.chunks[stream]}))?;
                t.enqueue(&m, part, Some((stream == 1, part.len() as u64)))?;
                self.queued[stream] = end;
                self.chunks[stream] += 1;
            }
        }
        Ok(())
    }
}
fn ack(t: &mut Transport, id: &str, op: &str, job: Option<&str>) -> Result<()> {
    let m = t.event("accepted", json!({"request_id":id,"op":op,"job_id":job}))?;
    t.enqueue(&m, &[], None)
}
fn reject(t: &mut Transport, id: &str, code: &str) -> Result<()> {
    let m = t.event("error", json!({"request_id":id,"code":code}))?;
    t.enqueue(&m, &[], None)
}
fn request(
    a: &GuestAuthority,
    t: &mut Transport,
    f: Frame,
    jail: &Jail,
    groups: &mut JobCgroups,
    active: &mut Option<Job>,
    history: &mut History,
    stop: &mut Option<String>,
    end: u64,
) -> Result<()> {
    let m = &f.metadata;
    let id = m.text("request_id")?.to_owned();
    history.request(&id)?;
    match m.kind() {
        "exec" => {
            if active.is_some() || history.stopping || !t.idle() {
                return reject(t, &id, "BUSY");
            }
            let cwd = RelativeCwd::new(m.text("cwd")?)?;
            // Resolve before any fork/reservation; Child resolves again through the same jail.
            let _cwd = match jail.cwd(a, &cwd) {
                Ok(fd) => fd,
                Err(_) => return reject(t, &id, "INVALID"),
            };
            let n = m.number("command_bytes")? as usize;
            let command = Command::new(&f.payload[..n], &f.payload[n..])?;
            let deadline = Deadline::new(
                bootstrap::now_ms()?,
                m.number("timeout_ms")?,
                end.saturating_sub(1000),
            )?;
            let index = history.job(m.text("job_id")?)?;
            let group = groups.create(
                a,
                &JobName::new(&format!("job_{index}"))?,
                Limits::new(128 << 20, 64, 256 << 20)?,
            )?;
            t.reset_counts()?;
            let child = Child::fork_blocked(a, jail, &cwd, command, JOB_UID, JOB_GID)?;
            *active = Some(Job {
                child,
                group,
                request: id.clone(),
                id: m.text("job_id")?.into(),
                output: Output::new(65536)?,
                queued: [0; 2],
                chunks: [0; 2],
                deadline,
                status: None,
                stdout_eof: false,
                stderr_eof: false,
                exec_ok: false,
                cause: None,
                kill_at: None,
                killed: false,
                cancel: None,
                stop: None,
                terminal_queued: false,
            });
            let j = active.as_mut().unwrap();
            j.child.attach_and_release(a, &j.group)?;
            ack(t, &id, "exec", Some(m.text("job_id")?))
        }
        "cancel" => {
            let Some(j) = active.as_mut() else {
                return reject(t, &id, "INVALID");
            };
            if j.request != m.text("run_request_id")?
                || j.id != m.text("job_id")?
                || j.cancel.is_some()
                || j.terminal_queued
                || j.status.is_some()
            {
                return reject(t, &id, "INVALID");
            }
            ack(t, &id, "cancel", Some(&j.id))?;
            j.cancel = Some(id);
            j.terminate(a, "cancel", bootstrap::now_ms()?)
        }
        "stop" => {
            if history.stopping {
                return reject(t, &id, "INVALID");
            }
            ack(t, &id, "stop", None)?;
            history.stopping = true;
            *stop = Some(id.clone());
            if let Some(j) = active.as_mut() {
                if !j.terminal_queued {
                    j.stop = Some(id);
                    j.terminate(a, "stop", bootstrap::now_ms()?)?;
                }
            }
            Ok(())
        }
        _ => Err(refused("unexpected actor frame")),
    }
}
fn step_job(a: &GuestAuthority, t: &mut Transport, j: &mut Job, now: u64) -> Result<()> {
    if j.terminal_queued {
        return Ok(());
    }
    j.poll_exec(a)?;
    j.child.feed_input(a)?;
    if !j.stdout_eof {
        j.stdout_eof = spawn::drain(a, &j.child.stdout, false, &mut j.output)?;
    }
    if !j.stderr_eof {
        j.stderr_eof = spawn::drain(a, &j.child.stderr, true, &mut j.output)?;
    }
    j.queue_output(t)?;
    if j.output.exceeded {
        j.terminate(a, "output_limit", now)?;
    }
    if j.deadline.remaining(now) == 0 {
        j.terminate(a, "timeout", now)?;
    }
    let (rows, no_children) = supervision::reap_available(a)?;
    for row in rows {
        if row.pid == j.child.pid() {
            j.status = Some(row.status);
        }
    }
    if j.status.is_some() && !j.killed {
        // A normally exited shell does not authorize persistent background children.
        j.group.kill_descendants(a)?;
        j.killed = true;
    }
    if j.kill_at.is_some_and(|at| now >= at) && !j.killed {
        j.group.kill_descendants(a)?;
        j.killed = true;
    }
    if j.status.is_some()
        && no_children
        && j.group.empty(a)?
        && j.stdout_eof
        && j.stderr_eof
        && t.idle()
    {
        if !j.exec_ok {
            return Err(refused("missing exec closure"));
        }
        let (exit, signal, cause) = wait_outcome(j.status.unwrap(), j.cause)?;
        if j.output.exceeded && cause != "output_limit" {
            return Err(refused("output overflow after different terminal cause"));
        }
        if t.stdout_sent != j.output.stdout.len() as u64
            || t.stderr_sent != j.output.stderr.len() as u64
        {
            return Err(refused("unsent output"));
        }
        let m=t.event("job_finished",json!({"request_id":j.request,"job_id":j.id,"cancel_request_id":j.cancel,"stop_request_id":j.stop,"cause":cause,"exit_code":exit,"signal":signal,"output_complete":!j.output.exceeded,"job_empty":true,"stdout_sent_bytes":t.stdout_sent,"stderr_sent_bytes":t.stderr_sent}))?;
        t.enqueue(&m, &[], None)?;
        j.terminal_queued = true;
    }
    Ok(())
}
fn wait_outcome(
    status: i32,
    requested: Option<&'static str>,
) -> Result<(Option<i32>, Option<i32>, &'static str)> {
    if libc::WIFEXITED(status) {
        let cause = match requested {
            Some("cancel" | "stop") | None => "exit",
            Some(other) => other,
        };
        Ok((Some(libc::WEXITSTATUS(status)), None, cause))
    } else if libc::WIFSIGNALED(status) {
        Ok((
            None,
            Some(libc::WTERMSIG(status)),
            requested.unwrap_or("exit"),
        ))
    } else {
        Err(refused("nonterminal wait status"))
    }
}
fn emergency(a: &GuestAuthority, active: &mut Option<Job>, end: u64) {
    if let Some(j) = active.as_mut() {
        let _ = j.child.terminate(a, j.status.is_some());
        let _ = j.group.kill_descendants(a);
        let until = bootstrap::now_ms()
            .unwrap_or(end)
            .saturating_add(1000)
            .min(end);
        while bootstrap::now_ms().unwrap_or(end) < until {
            if let Ok((_, true)) = supervision::reap_available(a) {
                break;
            }
            unsafe {
                libc::usleep(1000);
            }
        }
    }
}
pub fn serve(a: &GuestAuthority, nonce: String, end: u64) -> Result<()> {
    a.check()?;
    let jail = Jail::verify(a, JOB_UID, JOB_GID)?;
    let mut groups = JobCgroups::prepare(a)?;
    let mut t = transport::accept(a, end, nonce)?;
    let mut active = None;
    let mut history = History::default();
    let mut stop = None;
    let mut ready = false;
    let result = (|| loop {
        let now = bootstrap::now_ms()?;
        if now >= end {
            return Err(refused("guest lifetime expired"));
        }
        t.flush(a)?;
        if active.as_ref().is_some_and(|j: &Job| j.terminal_queued) && t.idle() {
            active = None;
        }
        if let Some(j) = active.as_mut() {
            step_job(a, &mut t, j, now)?;
        }
        if history.stopping && active.is_none() && t.idle() {
            let m = t.event("stopping", json!({"request_id":stop}))?;
            t.enqueue(&m, &[], None)?;
            while !t.idle() {
                t.flush(a)?;
                t.wait(a)?;
            }
            return Ok(());
        }
        if let Some(frame) = t.receive(a)? {
            if !ready {
                if frame.metadata.kind() != "hello" {
                    return Err(refused("HELLO required"));
                }
                t.ready()?;
                ready = true;
            } else {
                request(
                    a,
                    &mut t,
                    frame,
                    &jail,
                    &mut groups,
                    &mut active,
                    &mut history,
                    &mut stop,
                    end,
                )?;
            }
        }
        t.wait(a)?;
    })();
    if result.is_err() {
        emergency(a, &mut active, end);
    }
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wait_status_and_cancel_race_preserve_observation() {
        assert_eq!(wait_outcome(0, None).unwrap(), (Some(0), None, "exit"));
        assert_eq!(
            wait_outcome(7 << 8, Some("cancel")).unwrap(),
            (Some(7), None, "exit")
        );
        assert_eq!(
            wait_outcome(0, Some("stop")).unwrap(),
            (Some(0), None, "exit")
        );
        assert_eq!(
            wait_outcome(libc::SIGTERM, Some("cancel")).unwrap(),
            (None, Some(libc::SIGTERM), "cancel")
        );
        assert_eq!(
            wait_outcome(libc::SIGKILL, Some("timeout")).unwrap(),
            (None, Some(libc::SIGKILL), "timeout")
        );
        assert!(wait_outcome((libc::SIGSTOP << 8) | 0x7f, None).is_err());
    }
    #[test]
    fn history_is_one_shot_and_stop_fenced() {
        let mut h = History::default();
        h.request("request-a").unwrap();
        assert!(h.request("request-a").is_err());
        assert_eq!(h.job("job-a").unwrap(), 1);
        assert!(h.job("job-a").is_err());
        h.stopping = true;
        assert!(h.job("job-b").is_err());
    }
    #[test]
    fn sequential_job_limit() {
        let mut h = History::default();
        for n in 0..64 {
            h.job(&format!("job-{n}")).unwrap();
        }
        assert!(h.job("job-65").is_err());
    }
}
