# DeepSeek Harness For Windows

Electron 封装的 DeepSeek Harness Windows 桌面版。

## 功能

- 双击即用，无需浏览器和终端
- 内嵌 `@deepseek-ai/dsh` **0.1.5-rc.1**
- **默认停在沙箱里**：`workspace-write` + 需要时询问；只有显式切到 `danger-full-access` 才出沙箱（Windows 由受限令牌 + ACL 强制，无法强制时拒绝执行而不是无隔离运行）
- Windows 极简模式走内置 pwsh 方言，**自动回退到 Windows PowerShell 5.1，不需要用户装 PowerShell 7**
- 模型目录以 vendor 为准；启动时后台**增量**补上官方接口新公布的模型（保留 vendor 的能力元数据，绝不覆盖用户手写的条目）
- API 请求失败重试预算 8 次、1s→30s 退避，网络抖动不再直接中断任务
- 跨环境适配：启动失败会写日志并弹窗给出日志路径（`%TEMP%\deepseek-harness.log`）；自动注入系统代理；窗口按屏幕工作区自适应

> ⚠️ 安全说明：默认预设是 `workspace-write` + 需要时询问，所有 shell / 文件调用都强制经沙箱（拿不到沙箱实现会直接报错，不会退化成无隔离执行）。
> 只有显式切到 `danger-full-access`（等同 `DSH_PERMISSION_MODE=danger-full-access`）才会离开沙箱——那等于把整台机器交给模型，请自行确认风险。
> Windows 沙箱目前是**写限制**（工作区 + 私有临时目录），读与网络不做隔离，官方标注为"部分强制"。

## 构建

```powershell
npm install
npm run build:win
```

## 发布

- `dist/DeepSeek Harness Setup <version>.exe`
- `dist/DeepSeek-Harness-<version>-portable.exe`
