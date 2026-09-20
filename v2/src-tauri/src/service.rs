// Node 服务的探测与拉起（打包后由 Rust 负责；dev 模式由 scripts/dev.mjs 负责，见 tauri.conf.json）。
// - 4318 上已经有 bobo 服务时直接复用，不接管用户自己在终端起的进程；
// - 否则用 runtime/node-path 记录的 node 启动 runtime/src/server.mjs，应用退出时清理。
use std::io::{BufRead, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, Runtime};

pub const DEFAULT_PORT: u16 = 4318;
const READY_TIMEOUT: Duration = Duration::from_secs(20);

/// 服务端口：默认 4318，可用 BOBO_PORT 覆盖（便于同时跑 v1 与 v2，或调试多实例）。
pub fn port() -> u16 {
    std::env::var("BOBO_PORT")
        .ok()
        .and_then(|v| v.trim().parse::<u16>().ok())
        .filter(|p| *p > 0)
        .unwrap_or(DEFAULT_PORT)
}

/// 服务进程状态：Some 表示本次启动拉起的子进程（退出时清理）；None 表示复用了已有服务。
#[derive(Default)]
pub struct Service(pub Mutex<Option<Child>>);

impl Service {
    pub fn stop(&self) {
        if let Some(mut child) = self.0.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// 服务是否已经就绪：首页返回 200 且带 bobo 的 token meta（避免把别的程序误认成自己）。
pub fn ready() -> bool {
    let port = port();
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(800)));
    let request = format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut buf = Vec::new();
    let _ = stream.read_to_end(&mut buf);
    String::from_utf8_lossy(&buf).contains("<meta name=\"token\"")
}

/// runtime 目录：dev 用 v2/runtime（源码树），打包后用 $RESOURCE/runtime。
fn runtime_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    if tauri::is_dev() {
        return Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("runtime"));
    }
    app.path()
        .resolve("runtime", tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("找不到 runtime 资源目录：{e}"))
}

/// 探测 node：构建时记录的路径 → 常见安装位置（含 nvm/volta/scoop）→ PATH 扫描。
/// GUI 应用（尤其 macOS）拿不到用户 shell 的 PATH，所以要逐个兜底。
fn find_node(runtime: &Path) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(p) = std::fs::read_to_string(runtime.join("node-path")) {
        let p = p.trim();
        if !p.is_empty() {
            candidates.push(PathBuf::from(p));
        }
    }
    let home = std::env::var_os("HOME").map(PathBuf::from);
    if cfg!(target_os = "macos") {
        candidates.push(PathBuf::from("/opt/homebrew/bin/node"));
        candidates.push(PathBuf::from("/usr/local/bin/node"));
        if let Some(home) = &home {
            candidates.push(home.join(".volta/bin/node"));
            candidates.push(home.join(".local/bin/node"));
            // nvm：目录名形如 v22.21.0，字符串倒序即版本从高到低。
            if let Ok(entries) = std::fs::read_dir(home.join(".nvm/versions/node")) {
                let mut versions: Vec<PathBuf> = entries
                    .flatten()
                    .map(|e| e.path().join("bin/node"))
                    .filter(|p| p.is_file())
                    .collect();
                versions.sort();
                candidates.extend(versions.into_iter().rev());
            }
        }
    }
    if cfg!(target_os = "windows") {
        candidates.push(PathBuf::from(r"C:\Program Files\nodejs\node.exe"));
        candidates.push(PathBuf::from(r"C:\Program Files (x86)\nodejs\node.exe"));
        if let Some(home) = &home {
            candidates.push(home.join("AppData/Roaming/nvm/node.exe"));
            candidates.push(home.join("scoop/apps/nodejs/current/node.exe"));
        }
    }
    for candidate in &candidates {
        if candidate.is_file() {
            return Some(candidate.clone());
        }
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            for name in ["node", "node.exe"] {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

/// 确保服务可用：已在跑就直接返回，否则启动并等待端口就绪。
pub fn ensure<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let port = port();
    if ready() {
        return Ok(());
    }
    let runtime = runtime_dir(app)?;
    let node = find_node(&runtime).ok_or_else(|| {
        format!(
            "没有找到 Node.js（需要 22 或更高版本）。\n\n安装后重新打开即可：https://nodejs.org\n（服务目录：{}）",
            runtime.display()
        )
    })?;
    let mut child = Command::new(&node)
        .arg(runtime.join("src").join("server.mjs"))
        .current_dir(&runtime)
        .env("NO_COLOR", "1")
        .env("PORT", port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动 Node 服务失败（{}）：{e}", node.display()))?;
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            for line in std::io::BufReader::new(stderr).lines().map_while(Result::ok) {
                eprintln!("[bobo service] {line}");
            }
        });
    }
    let started = Instant::now();
    while started.elapsed() < READY_TIMEOUT {
        if ready() {
            *app.state::<Service>().0.lock().unwrap() = Some(child);
            return Ok(());
        }
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!(
                "Node 服务启动失败（退出码 {status}）。4318 端口可能被其它程序占用。"
            ));
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    let _ = child.kill();
    Err("等待 Node 服务就绪超时（20 秒）。".into())
}
