# Runtime patches

`npm install` 之后，`postinstall` 会执行 `scripts/apply-patches.cjs`，把这些修复复制进 `node_modules`。

| 文件 | 修复 |
| --- | --- |
| `dsh-subprocess-local/index.js` | 为 `spawnTerminal` 增加 Windows 进程检查器，否则 win32 报 `terminal inspection is unsupported` |
| `dsh-terminal-bash/index.js` | 自动检测 Git Bash；增加 `sandbox: false` 开关 |
| `dsh-minimal/agent.cordis.yml` | 极简模式在 Windows 使用 Git Bash 且不套 ACL 沙箱 |

注意：Windows 极简模式的 bash 不经过 ACL 文件沙箱。需要严格沙箱时请使用 standard 预设。
