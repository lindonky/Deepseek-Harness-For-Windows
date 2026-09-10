# Runtime patches

`npm install` 之后，`postinstall` 会执行 `scripts/apply-patches.cjs`，把这些修复复制或改写进 `node_modules`。

## 整文件替换

| 文件 | 修复 |
| --- | --- |
| `dsh-subprocess-local/index.js` | 为 `spawnTerminal` 增加 Windows 进程检查器，否则 win32 报 `terminal inspection is unsupported` |
| `dsh-terminal-bash/index.js` | 自动检测 Git Bash；增加 `sandbox: false` 开关 |
| `dsh-minimal/agent.cordis.yml` | 极简模式在 Windows 使用 Git Bash 且不套 ACL 沙箱 |

## 源码改写（幂等）

| 模块 | 改写 | 目的 |
| --- | --- | --- |
| `dsh-llm-deepseek/flash-model.cjs` | 向 `DEFAULT_MODELS` 头部插入 `deepseek-flash` | 模型选择器提供当前的 Flash 模型。`api.deepseek.com/models` 当前只返回 `deepseek-flash` 和 `deepseek-v4-pro`，`deepseek-v4-flash` 已退化为服务端别名，而内置目录仍是旧版 |
| `dsh-base/llm-retry-policy.cjs` | 给 `llm-deepseek` 条目加 `config.retryPolicy`（8 次重试、1s→30s 退避） | 官方默认只有 2 次重试（约 1.5s 容错），网络抖动会直接中断任务；`TRANSPORT` 本来就在默认可重试码里，只提高预算即可 |
| `dsh-host-directory-picker-native/owner-pid.cjs` | 把 `DSH_DIALOG_OWNER_PID`（默认父进程，即 Electron 主进程）交给对话框子进程 | 让 worker 知道该用哪个窗口当 owner |
| `dsh-host-directory-picker-native/owner-window.cjs` | 用 Harness 窗口作 `IFileDialog` 的 owner（原来传 `null`） | 无 owner 的对话框 Windows 不保证给前台，会弹在 Harness 窗口**后面** → 用户看到"选择目录没反应" |

改写型 patch 的源文件导出 `(source) => source`：找不到锚点会**报错退出**（vendor 改版时不会静默失效），已应用过则返回原样（重复 `npm install` 不会重复插入）。`dsh-base/llm-retry-policy.cjs` 额外做了保护：若 vendor 将来给该条目自带 `config:`，会直接报错而不是产出重复键的非法 YAML。

`postinstall` 默认给本仓库的 `node_modules` 打补丁；也可以指向已安装的应用（重启后生效）：

```powershell
node scripts/apply-patches.cjs "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\app"
```

改写只动建议清单 / 重试预算 / 对话框 owner，`deepseek-official` 路由的 `baseURL` 与 `DEEPSEEK_API_KEY` 凭据解析完全不变。

注意：Windows 极简模式的 bash 不经过 ACL 文件沙箱。需要严格沙箱时请使用 standard 预设。
