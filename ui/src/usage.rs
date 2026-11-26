// Token usage of beckon's Claude runs, read from Claude Code's own session transcripts
// (~/.claude/projects/<worktree path with every non-alphanumeric as "-">/<session id>.jsonl, plus
// subagent transcripts in <session id>/subagents/). Each file is parsed once and kept as small
// per-day, per-model sums until it changes, so a refresh costs a few `stat` calls.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde_json::Value;

/// input, output, cache read, cache write, messages
pub type Counts = [u64; 5];

#[derive(Default)]
pub struct Sums {
    /// (local day "YYYY-MM-DD", model) -> counts
    pub by_day_model: HashMap<(String, String), Counts>,
}

impl Sums {
    pub fn total(&self) -> Counts {
        let mut t = [0; 5];
        for c in self.by_day_model.values() {
            add(&mut t, c);
        }
        t
    }
}

pub fn add(a: &mut Counts, b: &Counts) {
    for i in 0..5 {
        a[i] += b[i];
    }
}

struct Entry {
    stamp: (u64, u64),
    sums: Sums,
}

pub struct Cache {
    claude_dir: PathBuf,
    offset: i64,
    files: HashMap<PathBuf, Entry>,
}

impl Cache {
    pub fn new(claude_dir: PathBuf, offset: i64) -> Self {
        Cache { claude_dir, offset, files: HashMap::new() }
    }

    /// The usage of one beckon thread: its session in its worktree, with subagents.
    pub fn session(&mut self, worktree: &str, session: &str) -> Sums {
        let dir = self.claude_dir.join("projects").join(sanitize(worktree));
        let mut files = vec![dir.join(format!("{session}.jsonl"))];
        if let Ok(rd) = fs::read_dir(dir.join(session).join("subagents")) {
            files.extend(rd.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "jsonl")));
        }
        let mut out = Sums::default();
        for f in files {
            if let Some(s) = self.file(&f) {
                for (k, c) in &s.by_day_model {
                    add(out.by_day_model.entry(k.clone()).or_default(), c);
                }
            }
        }
        out
    }

    fn file(&mut self, path: &Path) -> Option<&Sums> {
        let meta = fs::metadata(path).ok()?;
        let mtime = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs();
        let stamp = (mtime, meta.len());
        let fresh = self.files.get(path).is_some_and(|e| e.stamp == stamp);
        if !fresh {
            let sums = parse(path, self.offset);
            self.files.insert(path.to_path_buf(), Entry { stamp, sums });
        }
        self.files.get(path).map(|e| &e.sums)
    }
}

/// Claude Code's project folder name for a path.
pub fn sanitize(path: &str) -> String {
    path.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

fn parse(path: &Path, offset: i64) -> Sums {
    let mut sums = Sums::default();
    let Ok(f) = File::open(path) else { return sums };
    // One message is written once per content block, with the same usage: count each id once.
    let mut seen: HashSet<String> = HashSet::new();
    for line in BufReader::new(f).lines().map_while(Result::ok) {
        if !line.contains("\"usage\"") || !line.contains("\"assistant\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        let msg = &v["message"];
        let u = &msg["usage"];
        if !u.is_object() {
            continue;
        }
        if let Some(id) = msg["id"].as_str() {
            if !seen.insert(id.to_string()) {
                continue;
            }
        }
        let model = msg["model"].as_str().unwrap_or("unknown");
        if model == "<synthetic>" {
            continue;
        }
        let day = v["timestamp"].as_str().and_then(|t| local_day(t, offset)).unwrap_or_else(|| "unknown".into());
        let n = |k: &str| u[k].as_u64().unwrap_or(0);
        let c = [n("input_tokens"), n("output_tokens"), n("cache_read_input_tokens"), n("cache_creation_input_tokens"), 1];
        add(sums.by_day_model.entry((day, model.to_string())).or_default(), &c);
    }
    sums
}

/// "2026-11-26T02:18:48.553Z" -> the local day, "2026-11-26".
pub fn local_day(ts: &str, offset: i64) -> Option<String> {
    let secs = parse_utc(ts)? + offset;
    Some(day_string(secs.div_euclid(86400)))
}

pub fn parse_utc(ts: &str) -> Option<i64> {
    let b = ts.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let num = |r: std::ops::Range<usize>| ts.get(r)?.parse::<i64>().ok();
    let days = days_from_civil(num(0..4)?, num(5..7)?, num(8..10)?);
    Some(days * 86400 + num(11..13)? * 3600 + num(14..16)? * 60 + num(17..19)?)
}

pub fn day_string(days: i64) -> String {
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

// Howard Hinnant's date algorithms.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { yoe + era * 400 + 1 } else { yoe + era * 400 }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates() {
        assert_eq!(local_day("2026-11-25T17:30:00.000Z", 7 * 3600).unwrap(), "2026-11-26");
        assert_eq!(local_day("2024-02-29T00:00:00Z", 0).unwrap(), "2024-02-29");
        assert_eq!(parse_utc("1970-01-01T00:00:01Z"), Some(1));
        assert_eq!(sanitize("/Users/a/.beckon/worktrees/p/1-2"), "-Users-a--beckon-worktrees-p-1-2");
    }

    #[test]
    fn counts_each_message_once() {
        let dir = std::env::temp_dir().join(format!("beckon-ui-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("s.jsonl");
        let line = r#"{"type":"assistant","timestamp":"2026-11-26T02:00:00Z","message":{"id":"m1","model":"claude-x","usage":{"input_tokens":2,"output_tokens":10,"cache_read_input_tokens":100,"cache_creation_input_tokens":5}}}"#;
        let other = r#"{"type":"assistant","timestamp":"2026-11-26T02:00:01Z","message":{"id":"m2","model":"claude-x","usage":{"input_tokens":1,"output_tokens":1}}}"#;
        fs::write(&f, format!("{line}\n{line}\n{other}\n{{\"type\":\"user\"}}\n")).unwrap();
        let s = parse(&f, 0);
        assert_eq!(s.total(), [3, 11, 100, 5, 2]);
        fs::remove_dir_all(&dir).unwrap();
    }
}
