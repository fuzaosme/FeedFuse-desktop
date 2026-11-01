//! Node sidecar 生命周期管理。
//!
//! 流程：解析 node / server.mjs / 前端目录 → 生成一次性 token → spawn 子进程
//! → 逐行读 stdout 等 `[feedfuse-ready] {...}` → 把 WebView 导航到 baseUrl 并显示窗口。
//!
//! 不引入 tauri-plugin-shell：直接用 std::process::Command，省掉一层权限/配置。

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::{AppHandle, Manager};

/// sidecar 打印的握手指令前缀，格式见 server/src/main.ts。
const READY_PREFIX: &str = "[feedfuse-ready]";

/// 单次等待握手的切片时长。首次启动（尤其刚从 dmg 拖出、带 quarantine 属性时）
/// Gatekeeper 需要扫描 100MB+ 的 node 二进制，实测可能超过 10 秒，
/// 所以这里切片轮询，总预算放宽到 120 秒，而不是一次超时就放弃。
const READY_TICK: Duration = Duration::from_secs(5);

/// 握手总预算：超过这个时间才判定启动失败。
const READY_BUDGET: Duration = Duration::from_secs(120);


static CHILD: OnceLock<Mutex<Option<Child>>> = OnceLock::new();

fn child_slot() -> &'static Mutex<Option<Child>> {
    CHILD.get_or_init(|| Mutex::new(None))
}

/// 握手行解析结果。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Ready {
    port: u16,
    #[serde(default)]
    token: String,
    base_url: String,
    #[serde(default)]
    db_path: String,
    #[serde(default)]
    version: String,
}

/// 启动 sidecar。失败时只打印日志并显示窗口（错误页），不 panic。
pub fn start(app: AppHandle) {
    match try_start(&app) {
        Ok(child) => {
            *child_slot().lock().unwrap() = Some(child);
        }
        Err(err) => {
            eprintln!("[feedfuse] sidecar 启动失败: {err}");
            show_error(&app, &format!("本地服务启动失败：{err}"));
        }
    }
}

/// 优雅退出的等待上限：node 关库、dispose 连接一般几十毫秒，
/// 给 5 秒是留给磁盘慢/机器卡的情况，超过就说明真的卡死了。
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

/// 轮询 `try_wait` 的间隔：100ms 足够及时，也不会空转烧 CPU。
const SHUTDOWN_POLL: Duration = Duration::from_millis(100);

/// 杀掉子进程（幂等）。退出路径和异常路径都会调。
pub fn shutdown() {
    let mut slot = child_slot().lock().unwrap();
    if let Some(mut child) = slot.take() {
        let pid = child.id();

        // 先礼：Unix 上必须显式发 SIGTERM。
        // std 的 Child::kill() 在 Unix 里就是 SIGKILL，进程没有任何收尾机会，
        // SQLite 的 WAL 只能靠下次打开时的崩溃恢复来兜底；SIGTERM 才能让 node
        // 走正常退出流程，把 WAL checkpoint 回去。
        #[cfg(unix)]
        {
            // pid_t 是 i32，实际进程数离溢出还差得远，这里的窄化是安全的。
            if unsafe { libc::kill(pid as i32, libc::SIGTERM) } != 0 {
                eprintln!(
                    "[feedfuse] 向 sidecar({pid}) 发送 SIGTERM 失败: {}",
                    std::io::Error::last_os_error()
                );
            }
        }

        // Windows 没有 SIGTERM 语义，TerminateProcess 已经是能做到的最好情况。
        #[cfg(windows)]
        {
            if let Err(err) = child.kill() {
                eprintln!("[feedfuse] 结束 sidecar({pid}) 失败: {err}");
            }
        }

        // 后兵：轮询等它自己退出，最多 SHUTDOWN_GRACE。
        let deadline = Instant::now() + SHUTDOWN_GRACE;
        let mut exited = false;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => {
                    // 已经被回收，不需要再 wait()。
                    exited = true;
                    break;
                }
                Ok(None) => {}
                Err(err) => {
                    eprintln!("[feedfuse] 无法获取 sidecar({pid}) 的退出状态: {err}");
                    break;
                }
            }
            if Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(SHUTDOWN_POLL);
        }

        if !exited {
            eprintln!(
                "[feedfuse] sidecar({pid}) 在 {}s 内未退出，改为强制结束",
                SHUTDOWN_GRACE.as_secs()
            );
            if let Err(err) = child.kill() {
                eprintln!("[feedfuse] 结束 sidecar({pid}) 失败: {err}");
            }
            let _ = child.wait();
        }

        println!("[feedfuse] sidecar({pid}) 已退出");
    }
}

fn try_start(app: &AppHandle) -> Result<Child, String> {
    // 1) 数据目录：默认用 app_data_dir（macOS 下即 ~/Library/Application Support/com.feedfuse.desktop）。
    //    支持 FEEDFUSE_DATA_DIR 覆盖，用于便携模式（把数据放在 U 盘/自定义目录）与自动化测试。
    let data_dir = match std::env::var_os("FEEDFUSE_DATA_DIR") {
        Some(raw) if !raw.is_empty() => PathBuf::from(raw),
        _ => app
            .path()
            .app_data_dir()
            .map_err(|e| format!("无法取得 app_data_dir: {e}"))?,
    };
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("无法创建数据目录 {}: {e}", data_dir.display()))?;

    // 2) node 可执行文件。
    let node = resolve_node().ok_or_else(|| {
        "未找到 node 可执行文件。请先运行 `node scripts/fetch-node.mjs` 生成 src-tauri/binaries/node-<triple>，\
         或用 FEEDFUSE_NODE_BIN 指定路径"
            .to_string()
    })?;

    // 3) sidecar 入口。
    let server_entry = resolve_server_entry(app).ok_or_else(|| {
        "未找到 server/dist/server.mjs。开发时先执行 `pnpm build:server`，打包时需要把 server 产物放进 Resources/server"
            .to_string()
    })?;

    // 4) 前端静态目录（sidecar 同源提供 SPA）。
    let static_dir = resolve_static_dir(app);

    let token = random_token();
    let mut cmd = Command::new(&node);
    cmd.arg(&server_entry)
        .env("FEEDFUSE_DATA_DIR", &data_dir)
        .env("FEEDFUSE_PORT", "0")
        .env("FEEDFUSE_TOKEN", &token)
        .env_remove("FEEDFUSE_ALLOW_ANON")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    match static_dir.as_deref() {
        Some(dir) => {
            cmd.env("FEEDFUSE_STATIC_DIR", dir);
        }
        None => {
            cmd.env_remove("FEEDFUSE_STATIC_DIR");
        }
    }

    println!("[feedfuse] node      = {}", node.display());
    println!("[feedfuse] server    = {}", server_entry.display());
    println!("[feedfuse] staticDir = {:?}", static_dir);
    println!("[feedfuse] dataDir   = {}", data_dir.display());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("spawn `{}` 失败: {e}", node.display()))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法捕获 sidecar stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "无法捕获 sidecar stderr".to_string())?;

    // 5) 读线程：转发日志 + 把握手行送回主流程。
    let (tx, rx) = mpsc::channel::<Ready>();
    let tx_ready = tx.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            println!("[sidecar] {line}");
            if let Some(rest) = line.trim_start().strip_prefix(READY_PREFIX) {
                match serde_json::from_str::<Ready>(rest.trim()) {
                    Ok(ready) => {
                        // 只关心第一次握手，之后重复打印忽略。
                        let _ = tx_ready.send(ready);
                    }
                    Err(err) => eprintln!("[feedfuse] 握手行解析失败: {err}（原文: {rest}）"),
                }
            }
        }
    });

    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            eprintln!("[sidecar!] {line}");
        }
    });

    // 6) 等待握手：切片轮询，超时不清空等待，只在总预算耗尽或子进程退出时才算失败。
    let app_for_wait = app.clone();
    std::thread::spawn(move || {
        let started = Instant::now();
        let mut showed_loading = false;

        loop {
            match rx.recv_timeout(READY_TICK) {
                Ok(ready) => {
                    println!(
                        "[feedfuse] sidecar ready: port={} version={} db={} token_len={}（耗时 {}s）",
                        ready.port,
                        ready.version,
                        ready.db_path,
                        ready.token.len(),
                        started.elapsed().as_secs()
                    );
                    if let Err(err) = navigate(&app_for_wait, &ready.base_url) {
                        eprintln!("[feedfuse] 导航到 {} 失败: {err}", ready.base_url);
                        show_error(&app_for_wait, &format!("加载界面失败：{err}"));
                    }
                    return;
                }
                Err(RecvTimeoutError::Timeout) => {
                    let elapsed = started.elapsed();
                    if elapsed >= READY_BUDGET {
                        eprintln!(
                            "[feedfuse] {}s 内未收到 `{READY_PREFIX}` 握手行，放弃等待",
                            elapsed.as_secs()
                        );
                        show_error(
                            &app_for_wait,
                            // 文案直接取 READY_BUDGET，避免改了超时预算后提示还写着旧秒数。
                            &format!(
                                "本地服务初始化超时（{} 秒内未就绪），请查看终端日志。",
                                READY_BUDGET.as_secs()
                            ),
                        );
                        return;
                    }
                    if !showed_loading {
                        // 先让用户看到「正在启动」，而不是对着一个隐藏窗口等。
                        println!("[feedfuse] 等待 sidecar 就绪…（已等待 {}s）", elapsed.as_secs());
                        show_message(
                            &app_for_wait,
                            "正在启动本地服务…",
                            "首次启动需要解压并校验运行环境，可能需要几十秒。",
                        );
                        showed_loading = true;
                    }
                }
                Err(RecvTimeoutError::Disconnected) => {
                    eprintln!("[feedfuse] sidecar 在握手前已退出");
                    show_error(&app_for_wait, "本地服务已退出，请查看终端日志。");
                    return;
                }
            }
        }
    });

    Ok(child)
}

/// 导航到 sidecar 同源地址，然后显示窗口（窗口配置里 visible=false，避免白屏）。
fn navigate(app: &AppHandle, base_url: &str) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "找不到 label=main 的窗口".to_string())?;

    let url = tauri::Url::parse(base_url).map_err(|e| format!("非法 baseUrl `{base_url}`: {e}"))?;
    window.navigate(url).map_err(|e| e.to_string())?;
    // 给首屏一点渲染时间再显示，避免从隐藏切到可见时闪一下白底。
    std::thread::sleep(Duration::from_millis(150));
    window.show().map_err(|e| e.to_string())?;
    Ok(())
}

/// 出错时的兜底：把页面覆盖成一条错误提示并显示窗口。
fn show_error(app: &AppHandle, message: &str) {
    show_message(app, "FeedFuse 启动失败", message);
}

/// 在 WebView 里绘制一个极简提示页（启动中 / 启动失败共用）。
/// 不依赖任何前端资源，因为这时候前端可能还没加载。
fn show_message(app: &AppHandle, title: &str, message: &str) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let title = escape_js(title);
    let text = escape_js(message);
    let script = format!(
        r#"document.title = "{title}";
(function () {{
  const msg = "{text}";
  const paint = () => {{
    document.body.innerHTML = '';
    const box = document.createElement('div');
    box.style.cssText = 'font-family:-apple-system,system-ui,sans-serif;padding:48px;line-height:1.7;color:#0f172a';
    const h = document.createElement('h1');
    h.textContent = "{title}";
    h.style.cssText = 'font-size:20px;margin:0 0 12px';
    const p = document.createElement('p');
    p.textContent = msg;
    p.style.cssText = 'color:#334155;margin:0 0 8px;white-space:pre-wrap';
    const tip = document.createElement('p');
    tip.textContent = '详细日志见启动它的终端。';
    tip.style.cssText = 'color:#94a3b8;font-size:13px';
    box.append(h, p, tip);
    document.body.style.background = '#f8fafc';
    document.body.appendChild(box);
  }};
  if (document.readyState === 'loading') {{
    document.addEventListener('DOMContentLoaded', paint);
  }} else {{
    paint();
  }}
}})();"#
    );
    let _ = window.eval(&script);
    let _ = window.show();
}

fn escape_js(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "")
}

// ---------------------------------------------------------------------------
// 路径解析
// ---------------------------------------------------------------------------

fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
}

fn resource_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().resource_dir().ok()
}

fn is_file(path: &Path) -> bool {
    path.is_file()
}

/// node 可执行文件名（Windows 需要 .exe 后缀）。
fn node_file_name() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

/// 解析顺序：
/// a) 环境变量 `FEEDFUSE_NODE_BIN`
/// b) 打包后的 externalBin 位置：`<exe 目录>/node`、`<exe 目录>/../Resources/node`、resource_dir/node
/// c) 开发模式回退：PATH 里的 node
fn resolve_node() -> Option<PathBuf> {
    if let Some(raw) = std::env::var_os("FEEDFUSE_NODE_BIN") {
        let path = PathBuf::from(raw);
        if is_file(&path) {
            return Some(path);
        }
        eprintln!(
            "[feedfuse] FEEDFUSE_NODE_BIN={} 不存在，继续尝试默认位置",
            path.display()
        );
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = exe_dir() {
        candidates.push(dir.join(node_file_name()));
        // macOS bundle: Contents/MacOS/FeedFuse → Contents/Resources/node
        candidates.push(dir.join("../Resources").join(node_file_name()));
        candidates.push(dir.join("resources").join(node_file_name()));
    }
    for candidate in &candidates {
        if is_file(candidate) {
            return Some(candidate.clone());
        }
    }

    // c) 开发模式回退：PATH 里的 node（tauri dev 时用本机 node 即可，不必先 fetch-node）。
    which_node()
}

/// 最简单的 PATH 查找，避免为了一行 which 引入额外的 crate。
fn which_node() -> Option<PathBuf> {
    let name = node_file_name();
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if is_file(&candidate) {
            return Some(candidate);
        }
    }
    None
}

/// sidecar 入口解析顺序：打包后的 Resources/server/server.mjs → 开发态仓库内 server/dist/server.mjs。
fn resolve_server_entry(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = resource_dir(app) {
        // Tauri 的 bundle.resources 会保留 pattern 里的目录前缀，所以两种布局都试。
        candidates.push(dir.join("server").join("server.mjs"));
        candidates.push(dir.join("resources").join("server").join("server.mjs"));
    }
    if let Some(dir) = exe_dir() {
        candidates.push(dir.join("../Resources").join("server").join("server.mjs"));
        candidates.push(dir.join("server").join("server.mjs"));
    }
    // 开发模式（cargo run / tauri dev）：编译期路径指向 src-tauri 的上一级仓库根。
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("server")
            .join("dist")
            .join("server.mjs"),
    );

    candidates.into_iter().find(|p| is_file(p))
}

/// 前端静态目录解析顺序与 server 入口一致。
fn resolve_static_dir(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = resource_dir(app) {
        candidates.push(dir.join("web"));
        candidates.push(dir.join("resources").join("web"));
    }
    if let Some(dir) = exe_dir() {
        candidates.push(dir.join("../Resources").join("web"));
        candidates.push(dir.join("web"));
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("web")
            .join("dist"),
    );

    candidates
        .into_iter()
        .find(|p| p.join("index.html").is_file())
}

/// 随机 token：优先读 /dev/urandom，拿不到就退回时间戳 + pid。
fn random_token() -> String {
    let mut bytes = [0u8; 16];

    #[cfg(unix)]
    {
        use std::io::Read;
        if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
            if f.read_exact(&mut bytes).is_ok() {
                return hex(&bytes);
            }
        }
    }

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id() as u128;
    let mixed = nanos ^ (pid << 64) ^ (nanos.rotate_left(17));
    for (i, slot) in bytes.iter_mut().enumerate() {
        *slot = (mixed >> ((i % 16) * 8)) as u8;
    }
    hex(&bytes)
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}
