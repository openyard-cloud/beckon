// What the UI learns from the machine: the beckon daemon's process and its children, how it
// was started, and the tail of its log. Everything comes from `ps`, `launchctl`/`systemctl` and
// files, so the UI needs no access to beckon's memory and works while beckon is down.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Command;

pub const LABEL: &str = "cloud.openyard.beckon";

pub fn run(cmd: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(cmd).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

pub fn uid() -> String {
    run("id", &["-u"]).map(|s| s.trim().to_string()).unwrap_or_default()
}

/// The pid of the running daemon: from the service manager, else a process search.
pub fn daemon_pid() -> Option<u32> {
    if cfg!(target_os = "macos") {
        if let Some(out) = run("launchctl", &["print", &format!("gui/{}/{}", uid(), LABEL)]) {
            for l in out.lines() {
                if let Some(p) = l.trim().strip_prefix("pid = ") {
                    return p.trim().parse().ok();
                }
            }
        }
    } else if let Some(out) = run("systemctl", &["--user", "show", "-p", "MainPID", "--value", "beckon.service"]) {
        if let Ok(p) = out.trim().parse::<u32>() {
            if p > 0 {
                return Some(p);
            }
        }
    }
    run("pgrep", &["-f", "beckon.mjs start"])?.lines().next()?.trim().parse().ok()
}

pub struct Proc {
    pub pid: u32,
    pub ppid: u32,
    pub rss_kb: u64,
    pub cpu: f64,
    pub etime: String,
    pub args: String,
}

/// Every process, with memory, CPU and command line.
pub fn procs() -> Vec<Proc> {
    let out = run("ps", &["-A", "-o", "pid=,ppid=,rss=,%cpu=,etime=,args="]).unwrap_or_default();
    let mut list = Vec::new();
    for line in out.lines() {
        let mut rest = line.trim_start();
        let mut f: Vec<&str> = Vec::with_capacity(5);
        for _ in 0..5 {
            let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
            f.push(&rest[..end]);
            rest = rest[end..].trim_start();
        }
        let (Ok(pid), Ok(ppid)) = (f[0].parse(), f[1].parse()) else { continue };
        list.push(Proc {
            pid,
            ppid,
            rss_kb: f[2].parse().unwrap_or(0),
            cpu: f[3].replace(',', ".").parse().unwrap_or(0.0),
            etime: f[4].to_string(),
            args: rest.to_string(),
        });
    }
    list
}

/// `root` and everything started under it.
pub fn tree(all: &[Proc], root: u32) -> Vec<&Proc> {
    let mut kids: HashMap<u32, Vec<&Proc>> = HashMap::new();
    for p in all {
        kids.entry(p.ppid).or_default().push(p);
    }
    let mut out: Vec<&Proc> = all.iter().filter(|p| p.pid == root).collect();
    let mut i = 0;
    while i < out.len() {
        if let Some(k) = kids.get(&out[i].pid) {
            out.extend(k.iter().copied());
        }
        i += 1;
    }
    out
}

/// etime ("[[dd-]hh:]mm:ss") in seconds.
pub fn etime_secs(s: &str) -> u64 {
    let (days, rest) = match s.split_once('-') {
        Some((d, r)) => (d.parse().unwrap_or(0), r),
        None => (0u64, s),
    };
    rest.split(':').fold(0u64, |acc, x| acc * 60 + x.parse::<u64>().unwrap_or(0)) + days * 86400
}

/// How beckon runs here: the node binary and the repository, so the UI can use beckon's own
/// config check. BECKON_NODE / BECKON_REPO override; else read from the daemon's command line;
/// else the repository this binary was built in, with `node` from PATH.
pub fn beckon_install(daemon_args: Option<&str>) -> (String, Option<PathBuf>) {
    let mut node = std::env::var("BECKON_NODE").ok().filter(|s| !s.is_empty());
    let mut repo = std::env::var("BECKON_REPO").ok().filter(|s| !s.is_empty()).map(PathBuf::from);
    if let Some(args) = daemon_args {
        let mut it = args.split_whitespace();
        let n = it.next();
        let script = it.find(|a| a.ends_with("bin/beckon.mjs"));
        if node.is_none() {
            node = n.map(str::to_string);
        }
        if repo.is_none() {
            repo = script.and_then(|s| Path::new(s).parent()?.parent().map(Path::to_path_buf));
        }
    }
    if repo.is_none() {
        // ui/target/release/beckon-ui -> the repository
        repo = std::env::current_exe().ok().and_then(|e| e.ancestors().nth(4).map(Path::to_path_buf));
    }
    let repo = repo.filter(|r| r.join("src/config.mjs").exists());
    (node.unwrap_or_else(|| "node".into()), repo)
}

/// The last `max` bytes of a file, from the start of a line.
pub fn tail(path: &Path, max: u64) -> String {
    let Ok(mut f) = File::open(path) else { return String::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(max);
    if f.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    let mut buf = Vec::new();
    let _ = f.read_to_end(&mut buf);
    let s = String::from_utf8_lossy(&buf).into_owned();
    if start > 0 {
        if let Some(i) = s.find('\n') {
            return s[i + 1..].to_string();
        }
    }
    s
}

/// The local UTC offset in seconds, from `date +%z`.
pub fn utc_offset() -> i64 {
    let s = run("date", &["+%z"]).unwrap_or_default();
    let s = s.trim();
    if s.len() != 5 {
        return 0;
    }
    let sign = if s.starts_with('-') { -1 } else { 1 };
    let h: i64 = s[1..3].parse().unwrap_or(0);
    let m: i64 = s[3..5].parse().unwrap_or(0);
    sign * (h * 3600 + m * 60)
}
