# MOSS Desk Pet — Windows Tauri 版

这是 MOSS Desk Pet 的 Windows 低内存取向实现。功能、菜单、设置和视觉 UI 与 Electron v1.3 保持一致，前端文件由 `sync-ui.mjs` 从上级项目同步，避免两套 UI 后续分叉。生成后的 `frontend` 不纳入源码交付，运行开发或构建命令时会自动重建。

任务栏图标统一使用新 MOSS 浅色/深色 PNG，默认跟随 Windows 明暗外观自动选择反差版本，也可从托盘或桌宠右键菜单的“任务栏图标”中手动选择浅色或深色图标。

## 运行要求

- Windows 10 1803 或更新版本，或 Windows 11。
- Microsoft Edge WebView2 Runtime。当前 Windows 通常已预装；NSIS 安装包配置为缺失时使用引导程序安装。
- 无需 OpenAI API Key。应用只读取本机 Codex 会话状态文件。

## Windows 本机开发

需要 Node.js 20+、pnpm、Rust stable 和 Tauri 的 Windows 系统依赖：

```powershell
pnpm install --frozen-lockfile
pnpm --dir tauri-windows run dev
```

构建 x64 NSIS 安装包：

```powershell
pnpm --dir tauri-windows run build
```

产物位于：

```text
src-tauri\target\release\bundle\nsis\
```

## UI 同步规则

编辑共享 UI 时，只修改上级项目的 `src` 和 `assets/pets`。构建 Tauri 前会自动运行：

```powershell
pnpm --dir tauri-windows run sync-ui
```

同步后的 `frontend/src/styles.css`、`renderer.js` 和 `animation-config.js` 与 Electron 版逐字节一致；Tauri 只额外注入本地桥接脚本。窗口拖动由共享前端识别左键位移后通过桥接完成，不使用会被 Windows 当作标题栏的原生拖拽区域。

## 源码结构

- `tauri-bridge.js`：Tauri 事件与共享 UI API 之间的轻量桥接。
- `frontend`：构建时生成的共享 UI、动画和桌宠素材，不纳入源码版本控制。
- `src-tauri/src/layout.rs`：面板四向自适应与桌宠坐标锚定。
- `src-tauri/src/monitor.rs`：Codex Desktop / VS Code Codex / CLI 会话监听。
- `src-tauri/src/settings.rs`：与 Electron 版相同的设置模型。
- `src-tauri/src/lib.rs`：透明窗口、托盘、二级菜单、通知、开机启动和应用生命周期。

发布安装包未使用商业代码签名证书，Windows 可能显示 SmartScreen 提示。正式分发时应在 Tauri 配置中加入受信任的 Windows 代码签名证书。
