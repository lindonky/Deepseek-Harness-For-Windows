# Runtime patches

`npm install` 之后，`postinstall` 会执行 `scripts/apply-patches.cjs`。补丁源文件都在本仓库，默认打到本仓库的 `node_modules`；也可以指向已安装的应用（改完**重启**才生效）：

```powershell
node scripts/apply-patches.cjs "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\app"
```

## 源码改写（幂等）

| 模块 | 改写 | 目的 |
| --- | --- | --- |
| `dsh-base/llm-retry-policy.cjs` | 给 `dsh-base/cordis.patch.yml` 的 `llm-deepseek` 条目补 `config.retryPolicy`（8 次重试、1s→30s 退避、jitter 0.2） | 上游默认仍只有 5 次重试；`TRANSPORT` 本来就在默认可重试码里，只提高预算即可，网络抖动不再直接中断任务 |

改写型 patch 的源文件导出 `(source) => source`：找不到锚点会**报错退出**（vendor 改版时不会静默失效），已应用过则返回原样（重复 `npm install` 不会重复插入）。`llm-retry-policy.cjs` 额外保护：若 vendor 将来给该条目自带 `config:`，会直接报错，而不是产出重复键的非法 YAML。

## 整文件替换

**当前为空**（机制保留，便于将来使用）。2026-09 升级到 dsh 0.1.5 时删除了三条，原因都是**上游已经修了同一个问题**，继续保留等于重新引入旧实现：

| 已删除 | 删除原因 |
| --- | --- |
| `dsh-subprocess-local/index.js` | 上游已内置 win32 进程检查器（`@deepseek-ai/dsh-win32-process`） |
| `dsh-terminal-bash/index.js` | 上游 terminal-bash 新增 `shellDialect: bash\|pwsh`，并且 **shell 进程强制经 `ctx.sandbox.confine()`**；旧补丁里的 `sandbox: false` 开关是按"必须停在沙箱里"的安全要求**必须删除**的逃逸口 |
| `dsh-minimal/agent.cordis.yml` | 预设已迁到 `@deepseek-ai/dsh-agent-presets/presets/minimal/`，win32 原生走 pwsh；旧补丁写死 `C:/Program Files/Git/bin/bash.exe`（换台机器没装 Git 就废）并把裸 `fs-local` 影子化，属沙箱逃逸路径 |

## 维护提示

- 升级 `@deepseek-ai/dsh` 后先跑 `node scripts/sync-dsh-deps.cjs <版本> --no-scripts`（见交接文档「升级 0.1.5」），再评估上表锚点是否仍成立。
- 变更补丁后请跑：`node scripts/model-sync.test.cjs`、`node scripts/shell-utils.test.cjs`，以及一次 `node scripts/apply-patches.cjs`（应报告 `already applied`）。
