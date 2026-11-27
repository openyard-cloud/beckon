// The macOS menu bar app: an icon in the top bar whose menu shows whether beckon is up, what it is
// running and what today cost, plus a window with the full page. The page is served on a thread on
// 127.0.0.1 with a port the system picks, so there is no address to remember. The window, which is
// the only heavy part (a WebKit view), exists only while it is open.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::rc::Rc;
use std::time::{Duration, Instant};

use serde_json::Value;
use tao::dpi::{LogicalPosition, LogicalSize};
use tao::event::{Event, StartCause, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopWindowTarget};
use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS, EventLoopWindowTargetExtMacOS, WindowBuilderExtMacOS};
use tao::window::{Window, WindowBuilder};
use tiny_http::Server;
use tray_icon::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tray_icon::{Icon, TrayIcon, TrayIconBuilder};
use wry::{WebView, WebViewBuilder};

use crate::{usage, App};

// Each refresh costs about 12 ms of CPU (a `ps` and reading the log): every 15 s is about 0.08%.
const REFRESH: Duration = Duration::from_secs(15);
const USAGE_EVERY: Duration = Duration::from_secs(60);
const MAX_RUNS: usize = 6;

enum UserEvent {
    Menu(MenuEvent),
    Show,
}

pub fn run(home: PathBuf, token: String) {
    // One copy at a time. A second start (from the Applications folder, or `beckon-ui` in a
    // terminal) asks the running one to open its window and exits.
    let lock = File::create(home.join("ui.lock")).unwrap_or_else(|e| crate::die(&format!("cannot open the lock file: {e}")));
    if lock.try_lock().is_err() {
        if !ask_to_show(&home, &token) {
            crate::die("another beckon-ui is running but did not answer");
        }
        return;
    }

    let server = Server::http("127.0.0.1:0").unwrap_or_else(|e| crate::die(&format!("cannot listen on 127.0.0.1: {e}")));
    let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or_else(|| crate::die("no port"));
    let _ = fs::write(home.join("ui-port"), port.to_string());

    let mut event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    event_loop.set_activation_policy(ActivationPolicy::Accessory);
    let proxy = event_loop.create_proxy();
    let menu_proxy = proxy.clone();
    MenuEvent::set_event_handler(Some(std::sync::Arc::new(move |e| {
        let _ = menu_proxy.send_event(UserEvent::Menu(e));
    })));

    let show_proxy = std::sync::Mutex::new(proxy);
    let mut served = App::new(home.clone(), token.clone());
    served.on_show = Some(Box::new(move || {
        let _ = show_proxy.lock().map(|p| p.send_event(UserEvent::Show));
    }));
    std::thread::spawn(move || {
        for req in server.incoming_requests() {
            served.handle(req);
        }
    });

    let url = format!("http://127.0.0.1:{port}/#t={token}");
    let origin = format!("http://127.0.0.1:{port}/");
    let mut bar = Bar::new(App::new(home, token));
    let mut tray: Option<TrayIcon> = None;
    let mut window: Option<(Rc<Window>, WebView)> = None;
    let mut next = Instant::now();

    event_loop.run(move |event, target, flow| {
        *flow = ControlFlow::WaitUntil(next);
        match event {
            Event::NewEvents(StartCause::Init) => {
                // Edit and Window menus, so copy, paste and Cmd-W work in the window's text fields.
                main_menu().init_for_nsapp();
                let (menu, title) = bar.menu();
                tray = TrayIconBuilder::new()
                    .with_icon_templated(icon())
                    .with_title(title)
                    .with_tooltip("beckon")
                    .with_menu(Box::new(menu))
                    .build()
                    .ok();
                next = Instant::now() + REFRESH;
                *flow = ControlFlow::WaitUntil(next);
            }
            Event::NewEvents(StartCause::ResumeTimeReached { .. }) => {
                if let Some(t) = &tray {
                    match bar.refresh() {
                        Change::None => {}
                        Change::Text(title) => t.set_title(Some(title)),
                        Change::Menu(menu, title) => {
                            t.set_menu(Some(Box::new(menu)));
                            t.set_title(Some(title));
                        }
                    }
                }
                next = Instant::now() + REFRESH;
                *flow = ControlFlow::WaitUntil(next);
            }
            Event::UserEvent(UserEvent::Show) => show(&mut window, target, &url, &origin),
            Event::UserEvent(UserEvent::Menu(e)) => match bar.action(e.id().as_ref()) {
                Some(Action::Open) => show(&mut window, target, &url, &origin),
                Some(Action::Restart) => {
                    let _ = bar.app.restart();
                    next = Instant::now() + Duration::from_secs(2);
                    *flow = ControlFlow::WaitUntil(next);
                }
                Some(Action::Log) => {
                    let _ = Command::new("open").arg(bar.app.home.join("logs/beckon.log")).spawn();
                }
                Some(Action::Quit) => *flow = ControlFlow::Exit,
                None => {}
            },
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => {
                // Dropping the view ends its WebKit process: the memory goes back when the window closes.
                window = None;
                target.set_activation_policy_at_runtime(ActivationPolicy::Accessory);
            }
            _ => {}
        }
    });
}

fn show(window: &mut Option<(Rc<Window>, WebView)>, target: &EventLoopWindowTarget<UserEvent>, url: &str, origin: &str) {
    // While the window is open the app has a Dock icon and a menu bar, like any app.
    target.set_activation_policy_at_runtime(ActivationPolicy::Regular);
    if let Some((w, _)) = window {
        w.set_focus();
        return;
    }
    // A Mac window without a title bar: the page draws its sidebar under the traffic lights, and
    // its top strip moves the window (the page asks with an IPC message on mouse down).
    let Ok(w) = WindowBuilder::new()
        .with_title("beckon")
        .with_inner_size(LogicalSize::new(1120.0, 780.0))
        .with_min_inner_size(LogicalSize::new(780.0, 480.0))
        .with_titlebar_transparent(true)
        .with_title_hidden(true)
        .with_fullsize_content_view(true)
        .with_traffic_light_inset(LogicalPosition::new(18.0, 20.0))
        .build(target)
    else {
        return;
    };
    let w = Rc::new(w);
    let weak = Rc::downgrade(&w);
    let allowed = origin.to_string();
    let view = WebViewBuilder::new()
        .with_url(url)
        .with_ipc_handler(move |req| {
            let Some(w) = weak.upgrade() else { return };
            match req.body().as_str() {
                "drag" => {
                    let _ = w.drag_window();
                }
                "zoom" => w.set_maximized(!w.is_maximized()),
                _ => {}
            }
        })
        .with_navigation_handler(move |to| {
            if to.starts_with(&allowed) || to == "about:blank" {
                return true;
            }
            if to.starts_with("https://") {
                let _ = Command::new("open").arg(&to).spawn();
            }
            false
        })
        .build(&w);
    match view {
        Ok(v) => {
            w.set_focus();
            *window = Some((w, v));
        }
        Err(e) => eprintln!("beckon-ui: cannot open the window: {e}"),
    }
}

/// Ask the copy that holds the lock to open its window. True when it answered.
fn ask_to_show(home: &Path, token: &str) -> bool {
    let Some(port) = fs::read_to_string(home.join("ui-port")).ok().and_then(|p| p.trim().parse::<u16>().ok()) else { return false };
    let Ok(mut s) = TcpStream::connect(("127.0.0.1", port)) else { return false };
    let _ = s.set_read_timeout(Some(Duration::from_secs(3)));
    let req = format!("POST /api/show HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    if s.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut res = String::new();
    let _ = s.read_to_string(&mut res);
    res.starts_with("HTTP/1.1 200") || res.starts_with("HTTP/1.0 200")
}

fn main_menu() -> Menu {
    let app = Submenu::new("beckon", true);
    let _ = app.append(&PredefinedMenuItem::hide(None));
    let _ = app.append(&PredefinedMenuItem::close_window(None));
    let edit = Submenu::new("Edit", true);
    for item in [
        PredefinedMenuItem::undo(None),
        PredefinedMenuItem::redo(None),
        PredefinedMenuItem::separator(),
        PredefinedMenuItem::cut(None),
        PredefinedMenuItem::copy(None),
        PredefinedMenuItem::paste(None),
        PredefinedMenuItem::select_all(None),
    ] {
        let _ = edit.append(&item);
    }
    let menu = Menu::new();
    let _ = menu.append(&app);
    let _ = menu.append(&edit);
    menu
}

/// The menu bar icon: the beckon logo as a one-colour silhouette, from ui/menubar-icon.svg. It is a
/// template image, so macOS colours it for light and dark menu bars. 24x34 px at scale 2.
fn icon() -> Icon {
    let rgba: Vec<u8> = ICON_ALPHA.iter().flat_map(|&a| [0, 0, 0, a]).collect();
    Icon::from_rgba_with_scale(rgba, ICON_W, ICON_H, 2.0).expect("valid icon")
}

const ICON_W: u32 = 24;
const ICON_H: u32 = 34;
/// Alpha of each pixel, row by row: ui/menubar-icon.svg drawn at 24x34.
#[rustfmt::skip]
const ICON_ALPHA: [u8; (ICON_W * ICON_H) as usize] = [
      0, 13,127,181,137, 24,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,
      0,193,255,255,255,219,  6,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,
     16,255,255,255,255,255, 48,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,
     27,255,255,255,255,255, 61,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,
     27,255,255,255,255,255, 61,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,
     27,255,255,255,255,255, 61,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,
     27,255,255,255,255,255, 61,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,
     27,255,255,255,255,255, 61,  0,  0,  0,  0,  0,  0,  0,  0, 72,166, 64,  0,  0,  0,  0,  0,  0,
     27,255,255,255,255,255, 61,  0,  0,  0,  0,  0,  0,  0, 10,245,255,235,  5,  0,  0,  0,  0,  0,
     27,255,255,255,255,255, 61,  0,  0,  0,  0,  0,  0,  0,  0,219,255,202,  0,  0,  0,  0,  0,  0,
     27,255,255,255,255,255, 61,  0,  0,  0,  0,  0,  0,  0,  0, 55,255, 36,  0,  0,  0,  0,  0,  0,
     27,255,255,255,255,255, 61,  0,  0,  0,  0,  0,  0,  0,  0, 46,255, 29,  0,  0,  0,  0,  0,  0,
     27,255,255,255,255,255, 61,  0,  0,  0,  0,  0,  0,  0,  0, 46,255, 29,  0,  0,  0,  0,  0,  0,
     27,255,255,255,255,255,158,128,128,128,128,128,128,128,128,145,255, 89, 24,  0,  0,  0,  0,  0,
     27,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,167, 14,  0,  0,  0,
     27,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,229, 42,  0,  0,
     27,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,208,  4,  0,
     27,255,255,255,255,255,255,232, 99, 33,  1,  0,  0,  0,  0,  0,  6, 48,140,254,255,255,131,  0,
     27,255,255,255,255,255,255, 95,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,175,255,255,231,  0,
     27,255,255,255,255,255,252, 12,  0,114,242,147,  0,  0,  6,214,234, 41,  0, 95,255,255,254,  1,
     27,255,255,255,255,255,223,  0,  0,216,255,232,  0,  0, 72,255,255,120,  0, 63,255,255,255, 23,
     27,255,255,255,255,255,251,  4,  0, 73,179, 98,  0,  0,  5,151,168, 28,  0, 95,255,255,255, 26,
     27,255,255,255,255,255,255,111,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,193,255,255,255, 26,
     27,255,255,255,255,255,255,250,122, 64, 64, 64, 64, 64, 64, 64, 64, 65,178,255,255,255,255, 23,
     27,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,246,  0,
     27,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,193,  0,
     27,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255, 90,  0,
     27,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,197,  0,  0,
      4,241,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,229, 39,  0,  0,
      0, 90,250,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,173, 16,  0,  0,  0,
      0,  0,140,255,255,255,255,222,129,128,128,128,128,128,128,128,121, 76, 26,  0,  0,  0,  0,  0,
      0,  0,138,255,255,240,115,  5,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,
      0,  0,138,252,150, 20,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,
      0,  0, 82, 42,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,
];

enum Action {
    Open,
    Restart,
    Log,
    Quit,
}

enum Change {
    None,
    /// only text changed: the items were updated in place; this is the new title
    Text(String),
    Menu(Menu, String),
}

/// What the menu shows, refreshed every few seconds. Changed text is set on the existing items;
/// the menu is rebuilt only when lines come or go (a run starts or ends).
struct Bar {
    app: App,
    shown: Vec<String>,
    items: Vec<Option<MenuItem>>,
    today: String,
    usage_at: Option<Instant>,
    actions: HashMap<String, fn() -> Action>,
}

impl Bar {
    fn new(app: App) -> Self {
        Bar { app, shown: Vec::new(), items: Vec::new(), today: String::new(), usage_at: None, actions: HashMap::new() }
    }

    fn action(&self, id: &str) -> Option<Action> {
        self.actions.get(id).map(|f| f())
    }

    fn refresh(&mut self) -> Change {
        let lines = self.lines();
        if lines == self.shown {
            return Change::None;
        }
        let kind = |l: &String| if l == "-" { '-' } else if l.starts_with('#') { '#' } else { 'r' };
        let n = lines.len().saturating_sub(1);
        let same_shape = lines.len() == self.shown.len() && lines[..n].iter().zip(&self.shown).all(|(a, b)| kind(a) == kind(b));
        if !same_shape {
            let (menu, title) = self.build(lines);
            return Change::Menu(menu, title);
        }
        for i in 0..n {
            if lines[i] != self.shown[i] {
                if let Some(Some(item)) = self.items.get(i) {
                    item.set_text(lines[i].strip_prefix('#').unwrap_or(&lines[i]));
                }
            }
        }
        let title = lines[n].clone();
        self.shown = lines;
        Change::Text(title)
    }

    fn menu(&mut self) -> (Menu, String) {
        let lines = self.lines();
        self.build(lines)
    }

    /// Every line of the menu, as text (a leading "#" marks a disabled line, "-" a separator), and
    /// the title next to the icon as the last entry.
    fn lines(&mut self) -> Vec<String> {
        let ov = self.app.overview();
        if self.usage_at.is_none_or(|t| t.elapsed() >= USAGE_EVERY) {
            self.today = today(&self.app.usage("days=1"));
            self.usage_at = Some(Instant::now());
        }
        let mut out = Vec::new();
        let up = ov["daemon"].is_object();
        let slack = ov["slack"]["status"].as_str().unwrap_or("unknown");
        let relay = ov["relay"]["status"].as_str().unwrap_or("off");
        if up {
            let d = &ov["daemon"];
            out.push(format!("#● beckon is running · up {}", dur(d["secs"].as_u64().unwrap_or(0))));
        } else {
            out.push("#○ beckon is stopped".into());
        }
        out.push(format!("#Slack: {slack}{}", if relay == "off" { String::new() } else { format!(" · secret relay: {relay}") }));
        out.push("-".into());
        let runs = ov["runs"].as_array().cloned().unwrap_or_default();
        if runs.is_empty() {
            out.push("#Nothing running".into());
        } else {
            out.push(format!("#Running now ({})", runs.len()));
            for r in runs.iter().take(MAX_RUNS) {
                let title: String = r["title"].as_str().unwrap_or("").chars().take(48).collect();
                out.push(format!(
                    "{} · {} · {} · {}",
                    match r["agent"].as_str() {
                        Some(a) => format!("{}/{a}", r["project"].as_str().unwrap_or("")),
                        None => r["project"].as_str().unwrap_or("").to_string(),
                    },
                    title,
                    dur(r["secs"].as_u64().unwrap_or(0)),
                    mb(r["rssKb"].as_u64().unwrap_or(0))
                ));
            }
            if runs.len() > MAX_RUNS {
                out.push(format!("#and {} more", runs.len() - MAX_RUNS));
            }
        }
        // each project with agents: who they are, the lead, who is working
        for p in ov["projectList"].as_array().cloned().unwrap_or_default() {
            let agents = p["agents"].as_array().cloned().unwrap_or_default();
            if agents.is_empty() {
                continue;
            }
            let names: Vec<String> = agents
                .iter()
                .map(|a| {
                    let n = a["name"].as_str().unwrap_or("");
                    let mark = if a["running"].as_u64().unwrap_or(0) > 0 { "● " } else { "" };
                    if a["lead"].as_bool() == Some(true) { format!("{mark}{n} (lead)") } else { format!("{mark}{n}") }
                })
                .collect();
            out.push(format!("#{} · {} agents: {}", p["name"].as_str().unwrap_or(""), agents.len(), names.join(", ")));
        }
        out.push("-".into());
        out.push(format!("#{}", self.today));
        if up {
            let d = &ov["daemon"];
            out.push(format!("#Memory: {} · CPU {:.0}%", mb(d["treeRssKb"].as_u64().unwrap_or(0)), d["treeCpu"].as_f64().unwrap_or(0.0)));
        }
        let config = ov["config"]["status"].as_str().unwrap_or("");
        if config == "rejected" {
            out.push("#⚠ Config change rejected: see the log".into());
        }
        // title next to the icon: the number of runs, or a mark when something is wrong
        let title = if !up || slack == "down" {
            "!".to_string()
        } else if !runs.is_empty() {
            runs.len().to_string()
        } else {
            String::new()
        };
        out.push(title);
        out
    }

    fn build(&mut self, lines: Vec<String>) -> (Menu, String) {
        let menu = Menu::new();
        self.actions.clear();
        self.items.clear();
        let title = lines.last().cloned().unwrap_or_default();
        for (i, l) in lines[..lines.len().saturating_sub(1)].iter().enumerate() {
            if l == "-" {
                let _ = menu.append(&PredefinedMenuItem::separator());
                self.items.push(None);
            } else if let Some(text) = l.strip_prefix('#') {
                let item = MenuItem::new(text, false, None);
                let _ = menu.append(&item);
                self.items.push(Some(item));
            } else {
                // a running task: opens the window
                let item = MenuItem::with_id(format!("run-{i}"), l, true, None);
                self.actions.insert(item.id().as_ref().to_string(), || Action::Open);
                let _ = menu.append(&item);
                self.items.push(Some(item));
            }
        }
        let _ = menu.append(&PredefinedMenuItem::separator());
        let fixed: [(&str, &str, fn() -> Action); 4] = [
            ("open", "Open beckon…", || Action::Open),
            ("restart", "Restart beckon", || Action::Restart),
            ("log", "Open the log", || Action::Log),
            ("quit", "Quit the menu bar app", || Action::Quit),
        ];
        for (n, (id, text, act)) in fixed.into_iter().enumerate() {
            if n == 3 {
                let _ = menu.append(&PredefinedMenuItem::separator());
            }
            let item = MenuItem::with_id(id, text, true, None);
            self.actions.insert(id.to_string(), act);
            let _ = menu.append(&item);
        }
        self.shown = lines;
        (menu, title)
    }
}

fn today(u: &Value) -> String {
    let day = u["days"].as_array().and_then(|d| d.last()).cloned().unwrap_or(Value::Null);
    let runs = day["runs"].as_u64().unwrap_or(0);
    let t: usage::Counts = serde_json::from_value(day["tokens"].clone()).unwrap_or_default();
    if t[4] == 0 {
        return "Today: no runs yet".into();
    }
    format!("Today: {} run{} · {} output tokens · {} messages", runs, if runs == 1 { "" } else { "s" }, num(t[1]), num(t[4]))
}

fn num(n: u64) -> String {
    match n {
        n if n >= 1_000_000 => format!("{:.1}M", n as f64 / 1e6),
        n if n >= 10_000 => format!("{}k", n / 1000),
        n if n >= 1000 => format!("{:.1}k", n as f64 / 1e3),
        n => n.to_string(),
    }
}

fn mb(kb: u64) -> String {
    format!("{} MB", (kb + 512) / 1024)
}

fn dur(s: u64) -> String {
    match s {
        s if s < 60 => format!("{s}s"),
        s if s < 3600 => format!("{}m", s / 60),
        s if s < 86400 => format!("{}h {}m", s / 3600, s % 3600 / 60),
        s => format!("{}d {}h", s / 86400, s % 86400 / 3600),
    }
}
