# DeepSeek Harness For Windows

Electron 封装的 DeepSeek Harness Windows 桌面版。

## 功能

- 双击即用，无需浏览器和终端
- 内嵌 `@deepseek-ai/dsh` 0.1.0-rc.6
- 已修复 Windows 极简模式持久 bash（Git Bash + ConPTY）
- 模型选择器内置最新的 `deepseek-flash`（与 `deepseek-v4-pro` 同一 endpoint、同一 API key）
- 每次启动在后台核对官方模型列表（不阻塞启动）：新增的自动出现，下架的自动移除
- 文件夹选择对话框以 Harness 窗口为 owner，不会再弹到窗口后面（修 "选择目录没反应"）
- API 请求失败重试预算提高到 8 次、1s→30s 退避，网络抖动不再直接中断任务

> ⚠️ 警告：Windows 极简模式的 bash 当前不经过文件沙箱，请勿在极简模式运行不可信命令。
> 需要文件沙箱请使用 standard 预设；不要使用 `danger-full-access`。

## 构建

```powershell
npm install
npm run build:win
```

## 发布

- `dist/DeepSeek Harness Setup <version>.exe`
- `dist/DeepSeek-Harness-<version>-portable.exe`
