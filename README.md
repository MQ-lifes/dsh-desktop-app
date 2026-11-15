# dsh-desktop-app

给 [DeepSeek Harness](https://github.com/deepseek-ai)（dsh）用的桌面壳桥接插件：让 dsh 以「自己的应用窗口」运行，而不是浏览器标签页；并提供 Windows 桌面集成（自启动、桌面快捷方式）与关窗行为设置。

插件本身**不是**桌面应用本体。它提供的是**原生壳 ⇄ DSH Web 服务之间的控制面**：壳启动时向它要「带 token 的地址 + 行为策略」，关窗时向它要「要不要停服务」，设置页里的开关也由它落地。没有原生壳时，插件会退化为用 Edge/Chrome 的 `--app=` 打开一个无地址栏窗口。

---

## 结构

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半区：7 个 loopback HTTP 路由、Windows 集成动作、偏好读写 |
| `client.js` | Web 半区：`settings.section` 槽里的「桌面应用」设置页 |
| `cordis.patch.yml` | bundle patch：插入 `dsh-desktop-app` 行并给出初始配置 |
| `locale/*.json` | 插件管理器元数据（标题/描述）+ 设置页文案字典 |
| `icon.svg` | 插件图标 |

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

鉴权：默认只接受 loopback 的 `Host`/`Origin`，其余返回 403；若部署开启 `connection.allowsRemoteAuthorities`，改走 dsh `Connection` 的 `requestRejection`（Origin/cookie 校验）。token URL 取自 `ctx.connection.authenticatedUrl`，不从日志里抓。

## 自测

Host 半区可以在隔离进程里直接用假 `ctx` 驱动，无需启动 dsh：

```sh
node test/harness.mjs .
```

覆盖：路由注册、关窗语义单一真源、偏好落盘、壳路径探测、非 loopback 拒绝、方法校验。

## 已知限制

- 仅 Windows；Linux/macOS 上自启动与快捷方式动作会失败并返回错误信息。
- 不含桌面壳本体，也不负责壳的窗口渲染；没有壳时只有浏览器兜底窗口可用。
- 壳在关窗时最多等 3 秒插件应答，插件不可达则用启动时缓存的值。

## License

MIT © 2026 MQ-lifes，全文见 [LICENSE](LICENSE)。
