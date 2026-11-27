// beckon-ui: a small UI for beckon, one binary with no runtime.
//
//   beckon-ui                         macOS: the menu bar app; elsewhere: serve on 127.0.0.1:7878
//   beckon-ui --listen ADDR           serve the page on ADDR ("tailscale" for the Tailscale address)
//   beckon-ui install [--listen ...]  start it at login (launchd / systemd); on macOS without
//                                     --listen this is the menu bar app, also in ~/Applications
//   beckon-ui uninstall | url
//
// It reads ~/.beckon (config, state, logs) and Claude Code's transcripts, and writes only
// config.json, after beckon's own config check passes. beckon notices the change and applies it.
// Every API call needs the token in ~/.beckon/ui-token; `url` prints a link that carries it.

mod sys;
#[cfg(target_os = "macos")]
mod tray;
mod usage;

use std::collections::{BTreeMap, HashMap};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tiny_http::{Header, Method, Request, Response, Server};

const PAGE: &str = include_str!("../index.html");
const DEFAULT_LISTEN: &str = "127.0.0.1:7878";
const UI_LABEL: &str = "cloud.openyard.beckon-ui";
const MAX_BODY: u64 = 1 << 20;

fn die(msg: &str) -> ! {
    eprintln!("beckon-ui: {msg}");
    std::process::exit(1)
}

fn home_dir() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| die("HOME is not set")))
}

/// The LaunchAgent that `beckon-ui install` writes and `beckon-ui uninstall` removes (macOS).
fn launch_agent() -> PathBuf {
    // vetcode-ignore-next-line[mal-persistence] starting at login is what `beckon-ui install` is for; only that command writes it
    home_dir().join(format!("Library/LaunchAgents/{UI_LABEL}.plist"))
}

fn beckon_home() -> PathBuf {
    std::env::var("BECKON_HOME").map(PathBuf::from).unwrap_or_else(|_| home_dir().join(".beckon"))
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut listen: Option<String> = None;
    let mut cmd: Option<String> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--listen" => {
                i += 1;
                listen = Some(args.get(i).cloned().unwrap_or_else(|| die("--listen needs an address, like 127.0.0.1:7878 or tailscale")));
            }
            "-h" | "--help" | "help" => cmd = Some("help".into()),
            c @ ("install" | "uninstall" | "url" | "app") if cmd.is_none() => cmd = Some(c.into()),
            other => die(&format!("unknown argument \"{other}\"; see beckon-ui --help")),
        }
        i += 1;
    }
    let home = beckon_home();
    match cmd.as_deref() {
        Some("help") => {
            println!("beckon-ui                          macOS: the menu bar app; elsewhere: serve the page on {DEFAULT_LISTEN}\nbeckon-ui --listen ADDR             serve the page on ADDR\nbeckon-ui install [--listen ADDR]  start it at login (macOS without --listen: the menu bar app)\nbeckon-ui uninstall                stop starting it at login\nbeckon-ui url [--listen ADDR]      print the page's link with the access token\n\nADDR is host:port, or \"tailscale\" / \"tailscale:PORT\" for this machine's Tailscale address.");
            return;
        }
        Some("uninstall") => return uninstall(),
        _ => {}
    }
    let token = token(&home);
    // The menu bar app is the default on macOS; asking for an address means serving the page.
    let menu_bar = cfg!(target_os = "macos") && listen.is_none();
    let listen = resolve_listen(listen.as_deref().unwrap_or(DEFAULT_LISTEN));
    match cmd.as_deref() {
        Some("install") => return install(if menu_bar { None } else { Some(&listen) }, &token),
        Some("url") => return println!("{}", link(&listen, &token)),
        Some("app") if !cfg!(target_os = "macos") => die("the menu bar app is for macOS; use --listen to serve the page"),
        _ => {}
    }
    #[cfg(target_os = "macos")]
    if menu_bar || cmd.as_deref() == Some("app") {
        return tray::run(home, token);
    }
    let server = Server::http(&listen).unwrap_or_else(|e| die(&format!("cannot listen on {listen}: {e}")));
    // The link carries the token: print it to a terminal, never into a log file.
    if std::io::IsTerminal::is_terminal(&std::io::stderr()) {
        eprintln!("beckon-ui: open {}", link(&listen, &token));
    } else {
        eprintln!("beckon-ui: serving on {listen}; `beckon-ui url` prints the link");
    }
    let mut app = App::new(home, token);
    for req in server.incoming_requests() {
        app.handle(req);
    }
}

/// "tailscale" or "tailscale:PORT" -> this machine's Tailscale IPv4 address.
fn resolve_listen(listen: &str) -> String {
    let Some(rest) = listen.strip_prefix("tailscale") else { return listen.to_string() };
    let port = rest.strip_prefix(':').unwrap_or("7878");
    let ip = ["tailscale", "/usr/local/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]
        .iter()
        .find_map(|bin| sys::run(bin, &["ip", "-4"]))
        .and_then(|s| s.lines().next().map(|l| l.trim().to_string()))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| die("could not read the Tailscale address (is Tailscale running?)"));
    format!("{ip}:{port}")
}

fn link(listen: &str, token: &str) -> String {
    let host = if listen.starts_with("0.0.0.0:") {
        let name = sys::run("hostname", &[]).unwrap_or_default();
        listen.replacen("0.0.0.0", name.trim(), 1)
    } else {
        listen.to_string()
    };
    format!("http://{host}/#t={token}")
}

/// The access token, made on first use: 32 random bytes, hex, in a file only the user can read.
fn token(home: &Path) -> String {
    let file = home.join("ui-token");
    if let Ok(t) = fs::read_to_string(&file) {
        let t = t.trim().to_string();
        if t.len() >= 32 {
            return t;
        }
    }
    let mut bytes = [0u8; 32];
    fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut bytes)).unwrap_or_else(|e| die(&format!("no randomness: {e}")));
    let t: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let _ = fs::create_dir_all(home);
    OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&file)
        .and_then(|mut f| f.write_all(t.as_bytes()))
        .unwrap_or_else(|e| die(&format!("cannot write {}: {e}", file.display())));
    t
}

fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn header(k: &str, v: &str) -> Header {
    Header::from_bytes(k.as_bytes(), v.as_bytes()).expect("valid header")
}

type Reply = Result<Value, (u16, String)>;

fn bad(code: u16, msg: impl Into<String>) -> (u16, String) {
    (code, msg.into())
}

struct App {
    home: PathBuf,
    token: String,
    offset: i64,
    usage: usage::Cache,
    /// POST /api/show: the menu bar app opens its window (a second start asks the first this way).
    on_show: Option<Box<dyn Fn() + Send>>,
}

impl App {
    fn new(home: PathBuf, token: String) -> Self {
        let claude_dir = std::env::var("CLAUDE_CONFIG_DIR").map(PathBuf::from).unwrap_or_else(|_| home_dir().join(".claude"));
        let offset = sys::utc_offset();
        App { home, token, offset, usage: usage::Cache::new(claude_dir, offset), on_show: None }
    }

    fn handle(&mut self, mut req: Request) {
        let url = req.url().to_string();
        let (path, query) = url.split_once('?').unwrap_or((&url, ""));
        let method = req.method().clone();
        if method == Method::Get && (path == "/" || path == "/index.html") {
            let res = Response::from_string(PAGE)
                .with_header(header("Content-Type", "text/html; charset=utf-8"))
                .with_header(header("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"))
                .with_header(header("X-Content-Type-Options", "nosniff"))
                .with_header(header("Referrer-Policy", "no-referrer"))
                .with_header(header("Cache-Control", "no-store"));
            let _ = req.respond(res);
            return;
        }
        let authed = req.headers().iter().any(|h| {
            h.field.equiv("Authorization") && same(h.value.as_str().as_bytes(), format!("Bearer {}", self.token).as_bytes())
        });
        let reply: Reply = if !path.starts_with("/api/") {
            Err(bad(404, "not found"))
        } else if !authed {
            Err(bad(401, "open the link from `beckon-ui url`"))
        } else {
            let mut body = String::new();
            if method == Method::Post && req.as_reader().take(MAX_BODY).read_to_string(&mut body).is_err() {
                Err(bad(400, "the body is not UTF-8"))
            } else {
                match (method, path) {
                    (Method::Get, "/api/overview") => Ok(self.overview()),
                    (Method::Get, "/api/config") => self.config(),
                    (Method::Post, "/api/config") => self.save_config(&body),
                    (Method::Post, "/api/config/check") => self.check(&body),
                    (Method::Get, "/api/threads") => Ok(self.threads()),
                    (Method::Get, "/api/usage") => Ok(self.usage(query)),
                    (Method::Post, "/api/restart") => self.restart(),
                    (Method::Post, "/api/show") => match &self.on_show {
                        Some(show) => {
                            show();
                            Ok(json!({ "ok": true }))
                        }
                        None => Err(bad(404, "this beckon-ui has no window")),
                    },
                    _ => Err(bad(404, "not found")),
                }
            }
        };
        let (code, v) = match reply {
            Ok(v) => (200, v),
            Err((c, m)) => (c, json!({ "error": m })),
        };
        let res = Response::from_data(v.to_string().into_bytes())
            .with_status_code(code)
            .with_header(header("Content-Type", "application/json"))
            .with_header(header("Cache-Control", "no-store"));
        let _ = req.respond(res);
    }

    fn state(&self) -> Value {
        fs::read_to_string(self.home.join("state.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(json!({}))
    }

    fn config_value(&self) -> Value {
        fs::read_to_string(self.home.join("config.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(json!({}))
    }

    // ---- overview: is beckon up, connected, and what is it costing the machine ----

    fn overview(&self) -> Value {
        let pid = sys::daemon_pid();
        let all = sys::procs();
        let tree = pid.map(|p| sys::tree(&all, p)).unwrap_or_default();
        let daemon = tree.first();
        let state = self.state();
        let threads = state["threads"].as_object().cloned().unwrap_or_default();
        let mut runs = Vec::new();
        for p in tree.iter().skip(1) {
            if !p.args.contains("--session-id") && !p.args.contains("--resume") {
                continue;
            }
            let t = threads.values().find(|t| t["sessionId"].as_str().is_some_and(|s| p.args.contains(s)));
            if let Some(t) = t {
                // the claude process and everything it started (MCP servers, builds, browsers)
                let sub = sys::tree(&all, p.pid);
                runs.push(json!({
                    "project": t["project"], "agent": t["agent"], "title": t["title"], "pid": p.pid,
                    // team members working inside this run (subagents of the lead, beckon's records)
                    "members": t["team"].as_array().map(|a| a.iter().filter(|m| m["status"] == "working").filter_map(|m| m["agent"].as_str()).collect::<Vec<_>>()).unwrap_or_default(),
                    "rssKb": sub.iter().map(|x| x.rss_kb).sum::<u64>(),
                    "cpu": sub.iter().map(|x| x.cpu).sum::<f64>(),
                    "secs": sys::etime_secs(&p.etime),
                }));
            }
        }
        let me = all.iter().find(|p| p.pid == std::process::id());
        let log = sys::tail(&self.home.join("logs/beckon.log"), 48 * 1024);
        let lines: Vec<&str> = log.lines().collect();
        let find = |pats: &[(&str, &str)]| -> Value {
            for l in lines.iter().rev() {
                for (pat, status) in pats {
                    if l.contains(pat) {
                        return json!({ "status": status, "at": l.split(' ').next().unwrap_or(""), "line": l });
                    }
                }
            }
            json!({ "status": "unknown" })
        };
        let slack = find(&[
            ("Listening for Slack messages", "connected"),
            ("went quiet, reconnecting", "reconnecting"),
            ("Slack socket error", "reconnecting"),
            ("Could not reconnect to Slack", "down"),
            ("Slack asked to reconnect", "reconnecting"),
        ]);
        let cfg = self.config_value();
        let relay = if cfg["secretRelay"].is_object() {
            find(&[("Connected to the secret relay", "connected"), ("Relay connection failed", "down"), ("refused beckon", "down"), ("Secret handoff is off", "off")])
        } else {
            json!({ "status": "off" })
        };
        let config = find(&[("Config applied", "applied"), ("keeping the old config", "rejected"), ("Connected to Slack as", "applied")]);
        json!({
            "now": now_ms(),
            "daemon": daemon.map(|d| json!({
                "pid": d.pid,
                "secs": sys::etime_secs(&d.etime),
                "rssKb": d.rss_kb, "cpu": d.cpu,
                "treeRssKb": tree.iter().map(|x| x.rss_kb).sum::<u64>(),
                "treeCpu": tree.iter().map(|x| x.cpu).sum::<f64>(),
                "procs": tree.len(),
            })),
            "ui": me.map(|m| json!({ "rssKb": m.rss_kb, "cpu": m.cpu })),
            "slack": slack, "relay": relay, "config": config,
            "runs": runs,
            "threads": threads.len(),
            "projects": cfg["projects"].as_object().map(|o| o.len()).unwrap_or(0),
            "projectList": project_list(&cfg, &runs),
            // the Claude account the runs use, and the connectors and MCP servers runs start with
            "account": state["account"].clone(),
            "connections": state["connections"].clone(),
            "schedules": cfg["schedules"].as_array().map(|a| a.len()).unwrap_or(0),
            "watches": cfg["watches"].as_array().map(|a| a.len()).unwrap_or(0),
            "log": lines[lines.len().saturating_sub(80)..].join("\n"),
            "home": self.home.display().to_string(),
        })
    }

    // ---- config: read, check with beckon's own validator, write atomically ----

    fn version(&self) -> String {
        fs::metadata(self.home.join("config.json"))
            .map(|m| format!("{}-{}", m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0), m.len()))
            .unwrap_or_default()
    }

    fn config(&self) -> Reply {
        let file = self.home.join("config.json");
        let text = fs::read_to_string(&file).map_err(|e| bad(404, format!("cannot read {}: {e}", file.display())))?;
        Ok(json!({ "text": text, "version": self.version(), "path": file.display().to_string() }))
    }

    /// beckon's validateConfig, run with the node and repository beckon runs from.
    fn validate(&self, text: &str) -> Result<Vec<String>, String> {
        if let Err(e) = serde_json::from_str::<Value>(text) {
            return Ok(vec![format!("not valid JSON: {e}")]);
        }
        let pid = sys::daemon_pid();
        let args = pid.and_then(|p| sys::procs().into_iter().find(|x| x.pid == p)).map(|p| p.args);
        let (node, repo) = sys::beckon_install(args.as_deref());
        let repo = repo.ok_or("beckon's repository was not found, so the config cannot be checked; set BECKON_REPO")?;
        let module = format!("file://{}", repo.join("src/config.mjs").display());
        let script = format!(
            "import {{ validateConfig }} from {};\nlet s = ''; process.stdin.setEncoding('utf8');\nprocess.stdin.on('data', (d) => (s += d)).on('end', () => process.stdout.write(JSON.stringify(validateConfig(JSON.parse(s)).errors)));",
            Value::String(module)
        );
        let mut child = Command::new(&node)
            .args(["--input-type=module", "-e", &script])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("cannot run {node}: {e}"))?;
        child.stdin.take().ok_or("no stdin")?.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(format!("the config check failed: {}", String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("")));
        }
        serde_json::from_slice(&out.stdout).map_err(|e| format!("the config check said something unexpected: {e}"))
    }

    fn check(&self, body: &str) -> Reply {
        let v: Value = serde_json::from_str(body).map_err(|e| bad(400, e.to_string()))?;
        let errors = self.validate(v["text"].as_str().unwrap_or("")).map_err(|e| bad(500, e))?;
        Ok(json!({ "errors": errors }))
    }

    fn save_config(&self, body: &str) -> Reply {
        let v: Value = serde_json::from_str(body).map_err(|e| bad(400, e.to_string()))?;
        let text = v["text"].as_str().ok_or_else(|| bad(400, "text is required"))?;
        if v["version"].as_str() != Some(&self.version()) {
            return Err(bad(409, "config.json changed since you opened it (from Slack or by hand). Reload, then make your change again."));
        }
        let errors = self.validate(text).map_err(|e| bad(500, e))?;
        if !errors.is_empty() {
            return Ok(json!({ "ok": false, "errors": errors }));
        }
        let file = self.home.join("config.json");
        let tmp = self.home.join("config.json.ui-tmp");
        let mut text = text.to_string();
        if !text.ends_with('\n') {
            text.push('\n');
        }
        fs::write(&tmp, &text).map_err(|e| bad(500, e.to_string()))?;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
        fs::rename(&tmp, &file).map_err(|e| bad(500, e.to_string()))?;
        Ok(json!({ "ok": true, "errors": [], "version": self.version() }))
    }

    // ---- threads and usage ----

    fn running_sessions(&self) -> Vec<String> {
        let Some(pid) = sys::daemon_pid() else { return vec![] };
        let all = sys::procs();
        sys::tree(&all, pid).iter().skip(1).map(|p| p.args.clone()).collect()
    }

    fn threads(&mut self) -> Value {
        let state = self.state();
        let procs = self.running_sessions();
        let mut list = Vec::new();
        for (key, t) in state["threads"].as_object().into_iter().flatten() {
            let session = t["sessionId"].as_str().unwrap_or("");
            let worktree = t["worktree"].as_str().unwrap_or("");
            let sums = if t["started"].as_bool() == Some(true) { self.usage.session(worktree, session).total() } else { [0; 5] };
            list.push(json!({
                "key": key, "project": t["project"], "agent": t["agent"], "title": t["title"], "channel": t["channel"],
                "createdAt": t["createdAt"], "lastActive": t["lastActive"], "createdBy": t["createdBy"],
                "worktree": worktree, "worktreeRemoved": t["worktreeRemoved"].as_bool().unwrap_or(false),
                "allowAll": t["allowAll"].as_bool().unwrap_or(false),
                "running": !session.is_empty() && procs.iter().any(|a| a.contains(session)),
                "tokens": sums,
                // the lead's team members: one record per task, with its report (beckon's state)
                "team": t["team"].as_array().cloned().unwrap_or_default(),
            }));
        }
        list.sort_by_key(|t| std::cmp::Reverse(t["lastActive"].as_u64().unwrap_or(0)));
        json!({ "threads": list })
    }

    fn usage(&mut self, query: &str) -> Value {
        let days: i64 = query
            .split('&')
            .find_map(|kv| kv.strip_prefix("days="))
            .and_then(|d| d.parse().ok())
            .unwrap_or(14)
            .clamp(1, 365);
        let today = (now_ms() as i64 / 1000 + self.offset).div_euclid(86400);
        let first = usage::day_string(today - days + 1);
        let state = self.state();
        let mut by_day: BTreeMap<String, usage::Counts> = BTreeMap::new();
        let mut runs_by_day: HashMap<String, u64> = HashMap::new();
        let mut by_model: BTreeMap<String, usage::Counts> = BTreeMap::new();
        let mut by_project: BTreeMap<String, usage::Counts> = BTreeMap::new();
        let mut top = Vec::new();
        for d in (today - days + 1)..=today {
            by_day.insert(usage::day_string(d), [0; 5]);
        }
        for t in state["threads"].as_object().into_iter().flatten().map(|(_, t)| t) {
            if let Some(c) = t["createdAt"].as_i64() {
                let day = usage::day_string((c / 1000 + self.offset).div_euclid(86400));
                if day >= first {
                    *runs_by_day.entry(day).or_default() += 1;
                }
            }
            if t["started"].as_bool() != Some(true) {
                continue;
            }
            let sums = self.usage.session(t["worktree"].as_str().unwrap_or(""), t["sessionId"].as_str().unwrap_or(""));
            let mut in_range = [0; 5];
            for ((day, model), c) in &sums.by_day_model {
                if *day < first {
                    continue;
                }
                if let Some(d) = by_day.get_mut(day) {
                    usage::add(d, c);
                }
                usage::add(by_model.entry(model.clone()).or_default(), c);
                usage::add(by_project.entry(t["project"].as_str().unwrap_or("?").to_string()).or_default(), c);
                usage::add(&mut in_range, c);
            }
            if in_range[4] > 0 {
                top.push(json!({ "project": t["project"], "title": t["title"], "lastActive": t["lastActive"], "tokens": in_range }));
            }
        }
        let weight = |v: &Value| v["tokens"].as_array().map(|a| a[1].as_u64().unwrap_or(0) * 5 + a[0].as_u64().unwrap_or(0) + a[3].as_u64().unwrap_or(0)).unwrap_or(0);
        top.sort_by_key(|t| std::cmp::Reverse(weight(t)));
        top.truncate(10);
        json!({
            "days": by_day.iter().map(|(d, c)| json!({ "day": d, "tokens": c, "runs": runs_by_day.get(d).copied().unwrap_or(0) })).collect::<Vec<_>>(),
            "models": by_model.iter().map(|(m, c)| json!({ "model": m, "tokens": c })).collect::<Vec<_>>(),
            "projects": by_project.iter().map(|(p, c)| json!({ "project": p, "tokens": c })).collect::<Vec<_>>(),
            "top": top,
        })
    }

    fn restart(&self) -> Reply {
        let pid = sys::daemon_pid().ok_or_else(|| bad(409, "beckon is not running"))?;
        // SIGUSR2: beckon finishes running tasks, exits, and its service manager starts it again.
        let ok = Command::new("kill").args(["-USR2", &pid.to_string()]).status().map(|s| s.success()).unwrap_or(false);
        if !ok {
            return Err(bad(500, "could not signal beckon"));
        }
        Ok(json!({ "ok": true, "pid": pid }))
    }
}

// ---- projects and their agents, for the overview and the menu bar ----

/// Each project with its agents: role, whether beckon defines it (a prompt), and whether it is
/// working now. All agents post through beckon's own Slack app; with a lead, only the lead posts.
fn project_list(cfg: &Value, runs: &[Value]) -> Value {
    let projects = cfg["projects"].as_object().cloned().unwrap_or_default();
    Value::Array(
        projects
            .iter()
            .map(|(name, p)| {
                let running_of = |agent: Option<&str>| {
                    runs.iter()
                        .filter(|r| r["project"].as_str() == Some(name))
                        .filter(|r| agent.is_none() || r["agent"].as_str() == agent || r["members"].as_array().is_some_and(|m| m.iter().any(|x| x.as_str() == agent)))
                        .count()
                };
                let agents: Vec<Value> = p["agents"]
                    .as_object()
                    .map(|o| {
                        o.iter()
                            .map(|(key, a)| {
                                json!({
                                    "name": key,
                                    "agent": a["agent"].as_str().unwrap_or(key),
                                    "description": a["description"],
                                    "defined": a["prompt"].as_str().is_some_and(|p| !p.trim().is_empty()),
                                    "lead": p["lead"].as_str() == Some(key),
                                    "default": p["defaultAgent"].as_str() == Some(key),
                                    "running": running_of(Some(key)),
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                json!({ "name": name, "agents": agents, "lead": p["lead"], "running": running_of(None) })
            })
            .collect(),
    )
}

// ---- running in the background ----

fn xml(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// Start beckon-ui at login. `listen` None: the menu bar app (macOS); Some: serve the page there.
fn install(listen: Option<&str>, token: &str) {
    let exe = std::env::current_exe().unwrap_or_else(|e| die(&e.to_string()));
    let exe = exe.display().to_string();
    let logs = beckon_home().join("logs");
    let _ = fs::create_dir_all(&logs);
    let path_env = std::env::var("PATH").unwrap_or_default();
    // The repository this binary was built in, for beckon's config check when beckon is stopped
    // (a copy of the binary runs from ~/Applications and cannot find it by its own path).
    let repo = sys::beckon_install(None).1.map(|r| r.display().to_string()).unwrap_or_default();
    if cfg!(target_os = "macos") {
        let file = launch_agent();
        // The menu bar app runs from beckon.app, so the Dock and the app switcher show its name
        // and logo. It is not restarted after Quit (a clean exit), only after a crash.
        let (args, keep_alive, kind) = match listen {
            None => (vec![app_bundle(&exe, &repo), "app".to_string()], "<dict><key>SuccessfulExit</key><false/></dict>", "Interactive"),
            Some(l) => (vec![exe.clone(), "--listen".to_string(), l.to_string()], "<true/>", "Background"),
        };
        let args: String = args.iter().map(|a| format!("<string>{}</string>", xml(a))).collect();
        let plist = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{UI_LABEL}</string>
  <key>ProgramArguments</key><array>{args}</array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>{}</string><key>BECKON_REPO</key><string>{}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>{keep_alive}
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>{kind}</string>
  <key>StandardErrorPath</key><string>{}</string>
</dict>
</plist>
"#,
            xml(&path_env),
            xml(&repo),
            xml(&logs.join("ui.log").display().to_string())
        );
        let _ = fs::create_dir_all(file.parent().unwrap());
        fs::write(&file, plist).unwrap_or_else(|e| die(&e.to_string()));
        let domain = format!("gui/{}", sys::uid());
        let _ = Command::new("launchctl").args(["bootout", &format!("{domain}/{UI_LABEL}")]).output();
        let ok = Command::new("launchctl").args(["bootstrap", &domain, &file.display().to_string()]).status().map(|s| s.success()).unwrap_or(false);
        if !ok {
            die("launchctl bootstrap failed");
        }
    } else {
        let listen = listen.unwrap_or(DEFAULT_LISTEN);
        let file = home_dir().join(".config/systemd/user/beckon-ui.service");
        let unit = format!(
            "[Unit]\nDescription=beckon UI\nAfter=network-online.target\n\n[Service]\nExecStart=\"{exe}\" --listen {listen}\nEnvironment=PATH={path_env}\nRestart=always\nRestartSec=10\n\n[Install]\nWantedBy=default.target\n"
        );
        let _ = fs::create_dir_all(file.parent().unwrap());
        fs::write(&file, unit).unwrap_or_else(|e| die(&e.to_string()));
        for a in [&["--user", "daemon-reload"][..], &["--user", "enable", "--now", "beckon-ui.service"], &["--user", "restart", "beckon-ui.service"]] {
            let _ = Command::new("systemctl").args(a).status();
        }
    }
    match (listen, cfg!(target_os = "macos")) {
        (None, true) => println!("beckon is in the menu bar and starts at login. To open its window, use the menu, or open beckon from Applications or Spotlight."),
        (l, _) => println!("beckon-ui runs in the background at login.\nOpen: {}", link(l.unwrap_or(DEFAULT_LISTEN), token)),
    }
}

/// ~/Applications/beckon.app, with the logo as its icon, so Spotlight, Launchpad and the Dock show
/// beckon. It holds a copy of this binary: started from there with no arguments it is the menu bar
/// app, or, when that is already running, opens its window. Returns the path of that copy.
fn app_bundle(exe: &str, repo: &str) -> String {
    let app = home_dir().join("Applications/beckon.app");
    let contents = app.join("Contents");
    let _ = fs::create_dir_all(contents.join("MacOS"));
    let _ = fs::create_dir_all(contents.join("Resources"));
    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>beckon</string>
  <key>CFBundleDisplayName</key><string>beckon</string>
  <key>CFBundleIdentifier</key><string>{UI_LABEL}</string>
  <key>CFBundleExecutable</key><string>beckon</string>
  <key>CFBundleIconFile</key><string>beckon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>{v}</string>
  <key>CFBundleShortVersionString</key><string>{v}</string>
  <key>LSUIElement</key><true/>
  <key>LSEnvironment</key><dict><key>BECKON_REPO</key><string>{}</string></dict>
</dict>
</plist>
"#,
        xml(repo),
        v = env!("CARGO_PKG_VERSION")
    );
    let run = contents.join("MacOS/beckon");
    // Replace the file rather than write into it: the old copy may be running.
    let _ = fs::remove_file(&run);
    let ok = fs::write(contents.join("Info.plist"), plist).is_ok() && fs::copy(exe, &run).is_ok();
    if !ok {
        die(&format!("could not write {}", app.display()));
    }
    icns(&contents.join("Resources/beckon.icns"));
    // Sign the bundle for this machine (ad hoc), so macOS treats it as one app.
    let _ = Command::new("codesign").args(["--force", "--sign", "-", &app.display().to_string()]).output();
    // Ask Launch Services to read the new icon.
    let _ = Command::new("touch").arg(&app).status();
    run.display().to_string()
}

/// The app icon: assets/logo-1024.png at every size macOS wants, packed with iconutil.
fn icns(out: &Path) {
    const LOGO: &[u8] = include_bytes!("../../assets/logo-1024.png");
    let dir = std::env::temp_dir().join(format!("beckon-{}.iconset", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let _ = fs::create_dir_all(&dir);
    let src = dir.join("logo.png");
    if fs::write(&src, LOGO).is_err() {
        return;
    }
    for (px, name) in [(16, "16x16"), (32, "16x16@2x"), (32, "32x32"), (64, "32x32@2x"), (128, "128x128"), (256, "128x128@2x"), (256, "256x256"), (512, "256x256@2x"), (512, "512x512"), (1024, "512x512@2x")] {
        let to = dir.join(format!("icon_{name}.png"));
        let _ = Command::new("sips").args(["-z", &px.to_string(), &px.to_string()]).arg(&src).arg("--out").arg(&to).output();
    }
    let _ = fs::remove_file(&src);
    let _ = Command::new("iconutil").args(["-c", "icns"]).arg(&dir).arg("-o").arg(out).output();
    let _ = fs::remove_dir_all(&dir);
}

fn uninstall() {
    if cfg!(target_os = "macos") {
        let file = launch_agent();
        let _ = Command::new("launchctl").args(["bootout", &format!("gui/{}/{UI_LABEL}", sys::uid())]).output();
        let _ = fs::remove_file(file);
        let _ = fs::remove_dir_all(home_dir().join("Applications/beckon.app"));
    } else {
        let _ = Command::new("systemctl").args(["--user", "disable", "--now", "beckon-ui.service"]).status();
        let _ = fs::remove_file(home_dir().join(".config/systemd/user/beckon-ui.service"));
    }
    println!("beckon-ui no longer starts at login.");
}
