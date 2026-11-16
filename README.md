# dsh-desktop-app

给 [DeepSeek Harness](https://github.com/deepseek-ai)（dsh）用的桌面壳桥接插件：让 dsh 以「自己的应用窗口」运行，而不是浏览器标签页；并提供 Windows 桌面集成（自启动、桌面快捷方式）与关窗行为设置。

另外补上了 DSH 缺的那一项：**会话（对话记录）的真删除**。DSH 只有「归档」——归档只把会话挪进归档集合，`~/.dsh/sessions` 里的日志还在；本插件在会话行的「…」菜单里加了一个删除项，会真正清掉工作区记账、投影缓存与磁盘日志目录。

插件本身**不是**桌面应用本体。它提供的是**原生壳 ⇄ DSH Web 服务之间的控制面**：壳启动时向它要「带 token 的地址 + 行为策略」，关窗时向它要「要不要停服务」，设置页里的开关也由它落地。没有原生壳时，插件会退化为用 Edge/Chrome 的 `--app=` 打开一个无地址栏窗口。

---

## 结构

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半区：9 个 loopback HTTP 路由、Windows 集成动作、偏好读写、会话删除 |
| `client.js` | Web 半区：`settings.section` 槽里的「桌面应用」设置页 + `sidebar.workspaces.session.menu.item` 里的删除项（复用宿主的 `MenuItemButton`，字体/间距与内置项一致） |
| `cordis.patch.yml` | bundle patch：插入 `dsh-desktop-app` 行并给出初始配置 |
| `locale/*.json` | 插件管理器元数据（标题/描述）+ 设置页文案字典 |
| `icon.svg` | 插件图标 |
| `test/harness.mjs` | Host 半区隔离测试（假 ctx + 临时目录） |
| `test/client-harness.mjs` | Client 半区隔离测试（假 React / 假 ModuleLoader） |

## 前置

- Windows（注册表自启动、`.lnk` 快捷方式、`WScript.Shell` 均为 Windows 专用）
- dsh `>= 0.2.1`，profile 为 `web` 或 `desktop`
- 可选：原生桌面壳可执行文件（本仓库不包含壳本体）。默认按下面顺序探测：
  1. 环境变量 `DSH_DESKTOP_SHELL`
  2. `%USERPROFILE%\dsh-runtime\DeepSeekHarness.exe`
  3. `%LOCALAPPDATA%\Programs\DeepSeekHarness\DeepSeekHarness.exe`

## 安装

把本目录放到任意位置，然后以链接方式装进 profile（开发时改代码即可生效）：

```sh
dsh plugin --profile web add link:/absolute/path/to/dsh-desktop-app
```

或直接指定目录：

```sh
dsh plugin --profile web add link:D:/deepseek-harness/default-workspace/dsh-desktop-app
```

安装后**重启 `dsh web`**。注意：`link:` 安装的插件不在 HMR 文件监控内，改完 `index.js` / `cordis.patch.yml` 后需要重启才生效。

## 配置

`cordis.patch.yml` 里的 `config` 字段：

| 键 | 默认 | 说明 |
|---|---|---|
| `windowWidth` / `windowHeight` | `1440` / `900` | 应用窗口初始尺寸 |
| `closeToTray` | `true` | 点 `X` 时收进托盘（服务继续跑）。仅为**偏好文件首次运行的种子值** |
| `closeStopsServer` | `true` | 真退出时是否停止本地服务。同样只是种子值 |
| `browserProfile` | `''` | 浏览器兜底窗口的 `--user-data-dir`，留空用 `%LOCALAPPDATA%\DshDesktop\EdgeProfile` |
| `shellPath` | `''` | 壳可执行文件路径。留空即自动探测，仓库中不含任何机器的绝对路径 |
| `sweepDelayMs` | `5000` | 启动后多久清扫「只剩归档记账」的删除残留；`0` 表示尽快（测试用） |

### 关窗语义：只有一个真源

这是本插件刻意收敛的地方。早期版本里 `closeToTray` 读运行期偏好文件、`stopService` 读 patch 里的静态 `closeStopsServer`，两个来源会给出互相矛盾的说法。现在：

- 运行期真源永远是 `%USERPROFILE%\.dsh\desktop-app.json`
- 配置里的 `closeToTray` / `closeStopsServer` 只在偏好文件尚无该键时起种子作用
- `/_desktop/status`、`/_desktop/launch-info`、`/_desktop/closed` 三处读的是同一份偏好，不可能再各说一套

| 关窗方式 | `closeToTray=true` | `closeToTray=false` |
|---|---|---|
| 点 `X` | 收进托盘，服务继续 | 关闭窗口，随后按 `stopServerOnClose` 决定是否停服务 |
| 托盘「完全退出」/ 系统关机 | 按 `stopServerOnClose` 决定是否停服务 | 同左 |

`stopServerOnClose=false` 就是「窗口关掉、服务留在后台」，可用浏览器标签页继续访问。

## 会话删除（DSH 只有归档）

DSH 的 session persistence seam **没有删除 API**（`dsh-session-persistence-jsonl` 的 README 原文：*Nothing deletes session files — logs accumulate under `root` until removed externally; the seam has no deletion API*），所以界面里只有「归档」。归档只往 `~/.dsh/storages/workspace.json` 的 `archivedSessionIds` 里加一条，`~/.dsh/sessions` 下的日志文件还在。

本插件补的是真删除，会话行「…」菜单里有两项：**删除会话…**（移进回收站，可恢复）和 **永久删除会话…**（直接删磁盘，不经过回收站）。

默认的「删除会话…」**不直接 rm**：会话目录被移进 `<数据根>/_trash/<批次>/<会话id>/`，批次里留一份 `move-plan.json` 记着每个文件的原位和标题，删错了能原样搬回来。

| 步 | 动作 | 说明 |
|---|---|---|
| 1 | 结算活动 | 走 `workspace/session-stop` 让 Agent / 后台任务 / 子智能体停下，等 Agent 发布 idle（5 秒上限），再 `sessions.flush` 一次 —— 免得删完还有在飞的 step 往日志里写 |
| 2 | 先归档 | 归档态就是「这一行不出现在常规列表」的开关。少了它，内存里还没卸载的会话对象会以「未分组」的身份重新露出来，而且 **Ctrl+R 也带不走**（刷新只重载页面，不动进程内存） |
| 3 | 移进回收站 | 同卷 `rename`，原子；中途失败按逆序搬回，一个文件都不留在半路 |
| 4 | 摘记账 + 清缓存 | 从各工作区 `sessionIds` 摘掉、清置顶、删 `session_projcache` 记录 |

顺序是「先处理文件、后动名册」：文件这步失败就先返回，列表与磁盘不会各说一套。

**归档条目为什么留着**：删掉的那一行靠归档态藏起来，所以条目要留到下次启动；启动 5 秒后插件跑一次清扫（`sweepDanglingArchiveEntries`），把「没有 Agent、磁盘也没有日志」的归档条目摘干净——那时才是真正的彻底消失。真正归档的会话磁盘还在，`stat` 有结果，不会被误清。

### 子会话

父对话派过子智能体时，子会话也各自占一份 `sessions/` 下的目录。删除会按 `header.parentSession` 找出整棵树一起处理，确认框里写明「连同 N 个子智能体会话」。反过来，**子会话不能单独作为删除入口**：传子会话 id 会返回 `session-child` 并告诉调用方它的父是谁，否则只会删掉半边树、留下一个点不开的父行。

### 回收站

设置页「桌面应用」底部按批次列出，每行显示**是哪个对话**（删除时从内核读一次标题写进 `move-plan.json`，读不到就退回短 id）和删除时间。每批可以：

- **恢复** —— 按 `move-plan.json` 搬回原位，挂回它原来的工作区，并把这个批次收干净（恢复完批次就消失，不会在列表里留下第二条记录）；
- **永久清除** —— 真正删掉批次目录（会再确认一次）。

几条规矩：

- 恢复是**幂等**的：旧版本恢复过、只留下批次的条目（原位已有目录、回收站里那份已不在）按「已恢复」收掉，不再报错，也不重复搬运。
- `move-plan.json` 是可编辑文本，所以条目只认数据根下 `sessions/` 里的位置；指到别处的一律拒绝——不拿它当任意路径的写入许可。
- 部分条目失败时批次保留，但只留没恢复的那些。
- `_trash` 故意放在 `sessions/` 之外（放进里面会被当成一个 project 扫出来）。它不自动清理、不设过期时间，要清就自己点。

### 边界

- **打开过的会话也能删**（不需要先切换）。Windows 上 Node 打开的文件仍允许删除，所以写句柄一般挡不住移动；返回 `stale: true` 表示本进程内存里还留着它的会话对象，界面会切到新会话并提示「重开 dsh web 让进程彻底忘掉它」。
- **删除后那一行立刻消失，且不会掉进「未分组」**：靠的是第 2 步刚补的归档态。归档条目会在下次启动时被清扫摘掉；在此之前它只是把行藏起来的记账，界面上看不到。如果只做「摘记账」不做归档，会话就会以「未分组」的样子在列表里常驻，刷新页面也带不走。
- 搬不动时（别的进程独占锁定）返回 409 `session-busy`，**什么都没动**：名册、归档集合、磁盘目录全部保持原样。
- 目录名最后一段必须正好等于会话 id；批次名只接受 `[0-9A-Za-z_-]`。不认识的路径或名字直接拒绝，不猜。
- 只剩归档/置顶/工作区记账、磁盘上早已没有的「幽灵条目」也能清掉——正是归档列表里点不开的那些行。
- 附件（`~/.dsh/attachments`）按内容寻址、跨会话共享，没有会话归属，不随会话删除。
- 想「只是从列表里消失」请用内置的归档；删除是搬到回收站，永久清除才真的没了。

## HTTP 接口（仅 loopback）

| 路由 | 方法 | 说明 |
|---|---|---|
| `/_desktop/status` | GET | 端口、tokenized URL、窗口是否打开、关窗偏好、最近 10 条事件 |
| `/_desktop/launch-info` | GET | 壳开窗前需要的一切：token URL、标题、`closeStopsServer`、`closeToTray`、窗口尺寸。token 未就绪时返回 503，让壳继续等待 |
| `/_desktop/launch` | POST | 打开应用窗口（Edge/Chrome `--app=` 兜底通道） |
| `/_desktop/closed` | POST | 壳上报关窗，回报 `stopService` |
| `/_desktop/prefs` | POST | `{closeToTray?, stopServerOnClose?}`，写入偏好文件即时生效 |
| `/_desktop/shell-info` | GET | 壳是否安装、桌面快捷方式是否存在、是否自启动 |
| `/_desktop/shell` | POST | `{action: autostart-on \| autostart-off \| shortcut-create \| shortcut-remove}` |
| `/_desktop/session-info` | POST | `{sessionId}` → 是否活会话、磁盘文件位置与大小、归档/置顶状态、所属工作区、`childCount`（子会话数） |
| `/_desktop/session-delete` | POST | `{sessionId, cascade?, permanent?}` → 默认移进回收站（`cascade` 连子会话一起）；搬不动 409 `session-busy` |
| `/_desktop/trash` | GET | 回收站批次清单：批次名、时间、批次里的会话 |
| `/_desktop/trash-restore` | POST | `{batch}` → 按 `move-plan.json` 搬回原位，并挂回原工作区 |
| `/_desktop/trash-purge` | POST | `{batch}` → 永久删除该批次目录 |

鉴权：默认只接受 loopback 的 `Host`/`Origin`，其余返回 403；若部署开启 `connection.allowsRemoteAuthorities`，改走 dsh `Connection` 的 `requestRejection`（Origin/cookie 校验）。token URL 取自 `ctx.connection.authenticatedUrl`，不从日志里抓。

## 自测

两个半区都能在隔离进程里驱动，不需要启动 dsh：

```sh
npm test
# 等价于
node test/harness.mjs . && node test/client-harness.mjs .
```

`test/harness.mjs`（64 项）用假 `ctx` + 临时目录覆盖：路由注册、关窗语义单一真源、偏好落盘、壳路径探测、非 loopback 拒绝、方法校验；会话删除部分覆盖删除时补归档以隐藏该行、归档条目保留、搬进回收站与 `move-plan.json`（含标题）、删除前走 stop 缝、打开过的会话回 `stale`、子会话入口被拒、级联父子一起搬、恢复后挂回工作区并收掉批次、幂等恢复旧批次、越界 plan 被拒、永久清除、非法批次名、异常 `location` 中止且不记账、幽灵条目清理、启动清扫摘掉悬挂归档条目。

`test/client-harness.mjs`（25 项）用假 React / 假 `__ModuleLoader__` / 假 ctx 覆盖：注入了哪个 slot、设置页 + 两个菜单项的注册与顺序、菜单项用宿主 `MenuItemButton` 与 `danger`、先查子会话数再删、确认文案含标题/回收站/子会话数、临时删除请求体 `permanent: false`、永久删除请求体 `permanent: true`、取消确认不发请求、`stale` 时切会话并提示重启、`session-busy` 时显示本地化指引、设置页不受影响。

## 参考的同类实现

删除这件事 DSH 生态里已经有一批插件在做。本插件的几个关键决定，是照它们踩过的坑定的：

| 项目 | 借鉴的做法 |
|---|---|
| [HuaLQIn/dsh-session-tree](https://github.com/HuaLQIn/dsh-session-tree) | 删除先移进 `_trash` 而不是 `rm`；批次里留 `move-plan.json` 记原位；移动失败按逆序整批回滚；级联子会话；**「内存里存在」不等于「在跑」**——早期实现把两者混为一谈，结果打开过一次的会话永远删不掉 |
| [Cnily03/dsh-delete-archived-session](https://github.com/Cnily03/dsh-delete-archived-session) | 删前 `workspace/session-stop` → 等 Agent `whenIdle`（有时限）→ `sessions.flush` 的结算链；启动时清扫指向空会话的归档条目；两步确认控件 |
| [climbh/dsh-plugin-delete-session](https://github.com/climbh/dsh-plugin-delete-session) | 删的正好是当前会话时，自动回到新会话窗口 |

大家一致的地方：**不手写 `workspace.json`**（内核内存里持有权威副本，手写会被覆盖回去），一律走 `archiveSession` / `unarchiveSession` / `entity.detachSession` 这些内核缝；也不在 `sessions/` 里放自己的数据。

## 已知限制

- 仅 Windows；Linux/macOS 上自启动与快捷方式动作会失败并返回错误信息。
- 不含桌面壳本体，也不负责壳的窗口渲染；没有壳时只有浏览器兜底窗口可用。
- 壳在关窗时最多等 3 秒插件应答，插件不可达则用启动时缓存的值。
- 会话删除依赖三个内部时机：`workspaceRegistry` 的 Workspace 实体方法、`storageDomain` 的 `session_projcache` 表、`sessionPersistence.stat().location`。任一在升级后改名，插件会报错而不是猜着删。
- 删除后侧栏靠 Host 的 workspace 推送刷新；如果这一帧丢了，刷新页面即可（数据已经删干净，列表数据源也已更新）。
- 删掉「打开过的会话」后，本进程内存里仍留着它的会话对象（DSH 没有卸载单个会话的 API）。文件与记账已经干净，重启一次 dsh web 才能让进程彻底忘掉它；界面在此时会提示并切到新会话。
- 回收站不会自动清理，也不设过期时间：占多少磁盘由你自己决定什么时候点「永久清除」。

## License

MIT © 2026 MQ-lifes，全文见 [LICENSE](LICENSE)。
