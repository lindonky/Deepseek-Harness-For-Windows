# DeepSeek Harness For Windows

Electron 封装的 DeepSeek Harness Windows 桌面版。

## 功能

- 双击即用，无需浏览器和终端
- 内嵌 `@deepseek-ai/dsh` 0.1.0-rc.6
- 已修复 Windows 极简模式持久 bash（Git Bash + ConPTY）

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
