# DeepSeek Harness For Windows

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`@deepseek-ai/dsh`）封成 Windows 桌面版的 Electron 壳：双击即用，不需要浏览器，也不需要系统装 Node。

## 特性

- 内嵌 `@deepseek-ai/dsh` **0.1.5-rc.1**
- **默认停在沙箱里**：`workspace-write` + 需要时询问；所有 shell / 文件调用强制经沙箱，拿不到沙箱实现会直接报错（fail-closed），不会退化成无隔离执行。只有显式切到 `danger-full-access` 才离开沙箱
- Windows 极简模式走内置 **pwsh** 方言，自动回退到 Windows PowerShell 5.1，**无需安装 PowerShell 7**
- 启动时后台**增量**更新模型目录（保留 vendor 的能力元数据，绝不覆盖手写条目；不阻塞启动、失败静默）
- API 请求失败重试 8 次、退避 1s→30s，网络抖动不再直接中断任务
- 跨环境适配：启动失败会把完整日志写到 `%TEMP%\deepseek-harness.log` 并弹窗给出路径；自动识别系统代理（回环永不代理）；窗口按屏幕工作区自适应
- 旧会话**读时迁移**（V2→V3），不改写原会话文件

## 环境要求

- Windows 10 1809+ / 11（x64）—— 持久终端依赖 ConPTY
- Node.js 24（**仅构建需要**；运行时用 Electron 内置 Node）
- 网络：首次安装 `npm` 依赖与 Electron 二进制需要访问 npm / GitHub（国内建议用镜像）

## 构建

```powershell
# 1) 国内建议先设镜像
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"

# 2) 重要：终端里若有 ELECTRON_RUN_AS_NODE，Electron 二进制会被静默跳过（表现为装了包但没有 dist）
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

# 3) 安装依赖（postinstall 会自动把 patches/ 打进 node_modules）
npm install

# 4) 若 node_modules\electron\dist 不存在，补一次二进制
node node_modules/electron/install.js

# 5) 打包（产出 dist/ ：NSIS 安装版 + 免安装便携版）
npx electron-builder --win
```

只想本地跑起来调试：`npm start`。

## 开发

```powershell
# 自检（无需网络，全部离线可跑）
node scripts/shell-utils.test.cjs      # 启动行解析 / 系统代理 / 失败文案
node scripts/model-sync.test.cjs       # 模型目录增量同步
node scripts/default-settings.test.cjs # 首次启动语言默认值

# 调运行中的 harness 接口（0.1.5 新协议，自动从壳日志取端口与 token）
node scripts/dsh-api.mjs session/list '{"_request":{}}'
node scripts/dsh-api.mjs settings/describe '{}'

# 升级内嵌的 dsh：重建依赖清单（会扁平化生产闭包的 peerDependencies）
node scripts/sync-dsh-deps.cjs 0.1.5-rc.1 --dry
```

日志位置：

| 日志 | 路径 |
| --- | --- |
| 壳与服务输出（GUI 看不到 stdout） | `%TEMP%\deepseek-harness.log` |
| 模型目录同步结果 | `~/.dsh/model-sync.log` |
| 用户配置与会话 | `~/.dsh`（`settings.yaml` / `sessions/`） |

## 目录结构

| 路径 | 说明 |
| --- | --- |
| `main.js` | Electron 壳主进程：拉起 `dsh web`、解析带 token 的启动地址、日志与错误弹窗、退出清理 |
| `scripts/*.cjs` | 壳的可复用工具与自检（启动行/代理解析、模型同步、语言默认值、依赖清单重建） |
| `scripts/apply-patches.cjs` | `postinstall` 打补丁；也可指向已安装的应用 |
| `patches/` | 对 `@deepseek-ai/dsh*` 的源码改写补丁（幂等、锚点缺失即报错） |
| `build/`、`build-icon.mjs` | 应用图标与生成脚本 |

## 安全

- 默认预设 `workspace-write` + `ask`，沙箱与审批是**同一个预设**绑定的；只有 `danger-full-access`（approval=never）会离开沙箱。
- Windows 沙箱由受限令牌 + ACL 实现，只限制**写**（工作区 + 私有临时目录）；**读与网络不隔离**，上游标注为"部分强制"。
- 壳不做任何绕过；`DSH_PERMISSION_MODE` 只作为部署级覆盖保留，设为 `danger-full-access` 等于把机器交给模型。

## 故障排查

| 症状 | 处理 |
| --- | --- |
| 双击没反应 | 看 `%TEMP%\deepseek-harness.log` 最后几行（失败弹窗里也会给路径） |
| 装了新版但打开还是旧版 | 旧版仍在运行：单实例锁会让新实例静默退出并聚焦旧窗口。**先完全退出旧版**再启动新版 |
| 界面是英文 | 中文系统默认中文；可在 设置 → 语言 切换，或在 `~/.dsh/settings.yaml` 写 `locale: { preference: zh-CN }` |
| 界面加载失败 / 认证错误 | 壳会自检并提示；先看日志里的 `main frame HTTP` / `auth cookie` 行 |
| 构建报找不到 Electron | 确认 `ELECTRON_RUN_AS_NODE` 已删除、镜像变量已设，并跑一次 `node node_modules/electron/install.js` |
| 模型选择器少了/多了模型 | 看 `~/.dsh/model-sync.log`；同步只增不删 vendor 条目 |

## 上游版本对应

| 本仓库版本 | 内嵌 dsh | 备注 |
| --- | --- | --- |
| 0.3.0 | 0.1.5-rc.1 | 当前：新认证协议、沙箱默认、pwsh、模型增量同步 |
| 0.2.0 | 0.1.0-rc.6 | |
| 0.1.0 | 0.1.0-rc.6 | 首个发布 |

## 许可证

本仓库以 MIT 发布（见 `LICENSE`）。内嵌的 `@deepseek-ai/dsh` 及其插件遵循它们各自的许可证。
