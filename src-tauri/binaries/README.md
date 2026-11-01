# binaries/

存放 `bundle.externalBin` 需要的 Node 可执行文件。

Tauri 要求文件名带 target triple 后缀，例如：

- `node-aarch64-apple-darwin`（Apple Silicon macOS）
- `node-x86_64-apple-darwin`（Intel macOS）
- `node-x86_64-pc-windows-msvc`
- `node-x86_64-unknown-linux-gnu`

生成方式：

```bash
node scripts/fetch-node.mjs          # 自动推断当前 host triple
```

打包时 Tauri 会把 `node-<triple>` 去掉后缀复制进 app（macOS 下落到 `FeedFuse.app/Contents/MacOS/node`），
Rust 侧的解析顺序见 `src/sidecar.rs::resolve_node`（先看 `FEEDFUSE_NODE_BIN`，
再看可执行文件同目录的 `node`／`../Resources/node`，最后回退到 PATH）。

注意：这个文件约 100 MB，不建议提交到版本库，通常由构建脚本按需下载。
