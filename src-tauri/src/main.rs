// Tauri v2 外壳入口。
//
// 只做三件事：起窗口（先隐藏）→ 由 sidecar 模块拉起 Node 服务 → 收到握手后导航到 baseUrl 并显示。
// 视图完全由 sidecar 同源提供（前端 + API 同一个 origin），所以不使用 tauri://localhost 加载本地资源。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod sidecar;

use tauri::RunEvent;

fn main() {
    let app = tauri::Builder::default()
        .setup(|app| {
            // 起不来不是致命错误：sidecar 模块内部已做兜底（显示窗口 + 打印日志），
            // 这里仍让应用起来，方便开发时看到报错。
            sidecar::start(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build FeedFuse");

    app.run(|_handle, event| match event {
        // ExitRequested 可能被别的插件拦截，所以两个事件都尝试清理一次（kill 是幂等的）。
        RunEvent::ExitRequested { .. } | RunEvent::Exit => sidecar::shutdown(),
        _ => {}
    });
}
