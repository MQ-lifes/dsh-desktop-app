/**
 * Host half of @local/dsh-desktop-app.
 *
 * One small loopback-only HTTP surface shared by the settings page and the native shell:
 *
 *   GET  /_desktop/status        → port, tokenized URL, window state, recent events
 *   GET  /_desktop/launch-info   → what a shell needs before opening a window
 *   POST /_desktop/launch        → open an app window (Edge/Chrome --app fallback)
 *   POST /_desktop/closed        → shell reports teardown; answers stopService
 *   POST /_desktop/prefs         → live close-behaviour prefs (the single source of truth)
 *   GET  /_desktop/shell-info    → installed shell, desktop shortcut, autostart state
 *   POST /_desktop/shell         → {action: autostart-on|autostart-off|shortcut-create|shortcut-remove}
 *   POST /_desktop/session-info  → {sessionId} → live/exists/file/size/archived/pinned/workspace
 *   POST /_desktop/session-delete→ {sessionId} → delete one conversation for real (not archive)
 *
 * Session deletion exists because DSH has only archiving: the session persistence seam
 * exposes no deletion API, so the plugin performs what a real delete needs — remove the
 * session directory first (the one step the OS can refuse), then drop workspace
 * accounting, archive/pin entries, and the projection-cache record. A refused directory
 * removal changes nothing, so the user retries after a restart instead of being left with
 * a listed row whose log is gone.
 *
 * Close behaviour has exactly one source of truth: the prefs file. The plugin config's
 * closeToTray / closeStopsServer only seed that file on first run, so `/status`,
 * `/launch-info` and `/closed` can never disagree about what closing the window does.
 *
 * The token URL comes from `ctx.connection.authenticatedUrl`, so it never has to be
 * scraped out of a log file. Child processes go through `ctx.subprocess`.
 *
 * These are plain `WebRoute` handlers, not `WebResourceRoute`s: the resource form only
 * answers GET/HEAD, and the actions need POST.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'

const DEFAULTS = {
  windowWidth: 1440,
  windowHeight: 900,
  // 只作为偏好文件的首次种子值：运行期真源永远是 ~/.dsh/desktop-app.json。
  closeStopsServer: true,
  closeToTray: true,
  browserProfile: '',
  /** 留空则按 shellCandidates() 的顺序自动探测。 */
  shellPath: '',
  /** 启动后多久清扫「只剩归档记账」的删除残留；0 表示尽快（测试用）。 */
  sweepDelayMs: 5000,
}

/** 壳的关窗偏好：独立小文件，改完立即生效，不需要重挂插件或重启壳。 */
const PREFS_PATH = join(process.env.USERPROFILE || homedir(), '.dsh', 'desktop-app.json')

function readPrefs() {
  try {
    if (!existsSync(PREFS_PATH)) return {}
    const parsed = JSON.parse(readFileSync(PREFS_PATH, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writePrefs(next) {
  try {
    mkdirSync(dirname(PREFS_PATH), { recursive: true })
    writeFileSync(PREFS_PATH, JSON.stringify(next, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 桌面壳可执行文件的候选位置，顺序即优先级：环境变量 → 配置 → 常见的两处安装位置。
 * 这样仓库里不需要写死任何一台机器的绝对路径。
 */
const shellCandidates = (home) => [
  process.env.DSH_DESKTOP_SHELL,
  join(home, 'dsh-runtime', 'DeepSeekHarness.exe'),
  join(process.env.LOCALAPPDATA || home, 'Programs', 'DeepSeekHarness', 'DeepSeekHarness.exe'),
].filter((value) => typeof value === 'string' && value !== '')

const BROWSER_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]

const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/**
 * 会话 id 会被拼进存储路径，所以只接受存储层自己产生的安全字符集：
 * `session-<uuid>`、字母数字、点、下划线、连字符。分隔符、`..` 与百分号编码一律拒绝。
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const RUN_VALUE = 'DeepSeekHarness'

export const inject = ['webServer', 'subprocess']

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }

  /**
   * 关窗语义只有一个真源：偏好文件。
   * 配置里的 closeToTray / closeStopsServer 只作为首次运行的种子值，
   * 一旦偏好文件写了值，宿主接口与桌面壳读到的都是这一份。
   */
  const prefs = {
    closeToTray: cfg.closeToTray,
    stopServerOnClose: cfg.closeStopsServer,
    ...readPrefs(),
  }

  /** 真退出时是否停止本地服务；与 closeToTray 同源，不会再出现两套说法。 */
  const stopsServer = () => prefs.stopServerOnClose !== false
  const events = []
  let window = null
  let lastLaunch = null

  const home = process.env.USERPROFILE || homedir()
  const shortcutPath = join(home, 'Desktop', 'DeepSeek Harness.lnk')

  /** 配置里写了就用配置的；否则自动探测，实在找不到返回空串由调用方报错。 */
  const resolveShellPath = () => {
    if (cfg.shellPath && existsSync(cfg.shellPath)) return cfg.shellPath
    return shellCandidates(home).find((candidate) => existsSync(candidate)) ?? cfg.shellPath ?? ''
  }

  const note = (msg) => {
    events.push({ at: new Date().toISOString(), msg })
    if (events.length > 40) events.shift()
  }

  const sendJson = (res, value, status = 200) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(value))
  }

  const readBody = (req) => new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 1_000_000) req.destroy()
    })
    req.on('end', () => resolve(data))
    req.on('error', () => resolve(''))
  })

  const hostOf = (hostHeader) => {
    const value = String(hostHeader ?? '')
    if (value.startsWith('[')) return value.slice(0, value.indexOf(']') + 1)
    const colon = value.lastIndexOf(':')
    return colon === -1 ? value : value.slice(0, colon)
  }

  /**
   * Loopback callers need no cookie: the process token already sits in this machine's
   * log files. Once the deployment accepts non-loopback authorities, fall back to
   * Connection's own Host/Origin + browser authentication checks.
   */
  const guard = (headers) => {
    const connection = ctx.get('connection')
    const origin = String(headers.origin ?? '')

    if (connection && connection.allowsRemoteAuthorities === true) {
      const rejection = connection.requestRejection?.({ headers })
      if (rejection) return { status: rejection, body: { ok: false, error: 'rejected' } }
    } else {
      if (!LOOPBACK_NAMES.has(hostOf(headers.host).toLowerCase())) {
        return { status: 403, body: { ok: false, error: 'loopback only' } }
      }
      if (origin !== '') {
        let originHost = ''
        try {
          originHost = new URL(origin).hostname
        } catch {
          return { status: 403, body: { ok: false, error: 'bad origin' } }
        }
        if (!LOOPBACK_NAMES.has(originHost)) {
          return { status: 403, body: { ok: false, error: 'bad origin' } }
        }
      }
    }

    return null
  }

  const originUrl = () => {
    try {
      return ctx.webServer.getOrigin()
    } catch {
      return 'http://127.0.0.1:3080'
    }
  }

  /**
   * null means "the token is not available yet" — the shell must keep waiting rather than
   * navigate to a bare origin, which answers 404 and used to happen on the first launch.
   */
  const authenticatedUrl = () => {
    try {
      const connection = ctx.get('connection')
      const base = originUrl()
      if (!connection || typeof connection.authenticatedUrl !== 'function') return null
      return connection.authenticatedUrl(base)
    } catch {
      return null
    }
  }

  /** Run one command through the Harness subprocess service and collect its output. */
  const run = async (argv) => {
    try {
      const handle = ctx.subprocess.spawn({
        argv,
        cwd: home,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 65536 },
          stderr: { maxBytes: 65536 },
        },
        graceMs: 2000,
      })
      const outcome = await handle.done
      const read = (reader) => {
        try {
          return reader ? reader.readFrom(0).text : ''
        } catch {
          return ''
        }
      }
      return { code: outcome?.exitCode ?? -1, out: read(handle.collected.stdout), err: read(handle.collected.stderr) }
    } catch (error) {
      return { code: -1, out: '', err: error instanceof Error ? error.message : String(error) }
    }
  }

  const autostartEnabled = async () => {
    const result = await run(['reg', 'query', RUN_KEY, '/v', RUN_VALUE])
    return result.code === 0
  }

  const setAutostart = async (enabled) => {
    const shellPath = resolveShellPath()
    if (enabled && (!shellPath || !existsSync(shellPath))) {
      return { ok: false, error: 'Shell path is not resolvable; set shellPath in the plugin config.' }
    }
    if (enabled) {
      const result = await run(['reg', 'add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', shellPath, '/f'])
      note(result.code === 0 ? 'autostart enabled' : 'autostart enable failed')
      return { ok: result.code === 0, error: result.code === 0 ? undefined : (result.err || result.out) }
    }
    const result = await run(['reg', 'delete', RUN_KEY, '/v', RUN_VALUE, '/f'])
    const ok = result.code === 0 || /unable to find/i.test(`${result.err}${result.out}`)
    note(ok ? 'autostart disabled' : 'autostart disable failed')
    return { ok, error: ok ? undefined : (result.err || result.out) }
  }

  const quote = (value) => String(value).replace(/'/g, "''")

  const createShortcut = async () => {
    const shellPath = resolveShellPath()
    if (!shellPath || !existsSync(shellPath)) {
      return { ok: false, error: `Shell not found: ${shellPath || '(unset)'}` }
    }
    const script = [
      '$ws = New-Object -ComObject WScript.Shell',
      `$lnk = $ws.CreateShortcut('${quote(shortcutPath)}')`,
      `$lnk.TargetPath = '${quote(shellPath)}'`,
      `$lnk.WorkingDirectory = '${quote(dirname(shellPath))}'`,
      `$lnk.IconLocation = '${quote(shellPath)},0'`,
      "$lnk.Description = 'DeepSeek Harness'",
      '$lnk.Save()',
    ].join('; ')

    const result = await run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script])
    const ok = result.code === 0 && existsSync(shortcutPath)
    note(ok ? 'desktop shortcut written' : 'desktop shortcut failed')
    return { ok, error: ok ? undefined : (result.err || 'shortcut was not created') }
  }

  const removeShortcut = async () => {
    const result = await run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
      `Remove-Item -LiteralPath '${quote(shortcutPath)}' -Force -ErrorAction SilentlyContinue`])
    const ok = result.code === 0 && !existsSync(shortcutPath)
    note(ok ? 'desktop shortcut removed' : 'desktop shortcut removal failed')
    return { ok, error: ok ? undefined : (result.err || 'shortcut still present') }
  }

  const shellInfo = async () => {
    const shellPath = resolveShellPath()
    return {
      ok: true,
      shellPath,
      shellExists: shellPath !== '' && existsSync(shellPath),
      shortcutPath,
      shortcutExists: existsSync(shortcutPath),
      autostart: await autostartEnabled(),
    }
  }

  const resolveBrowser = async () => {
    for (const candidate of BROWSER_CANDIDATES) {
      try {
        return await ctx.subprocess.resolveExecutable(candidate)
      } catch {
        // try the next candidate
      }
    }
    for (const name of ['msedge.exe', 'chrome.exe']) {
      try {
        return await ctx.subprocess.resolveExecutable(name)
      } catch {
        // no PATH entry either
      }
    }
    return undefined
  }

  const launch = async () => {
    const browser = await resolveBrowser()
    if (!browser) {
      note('no Edge/Chrome found')
      return { ok: false, error: 'No Edge or Chrome executable was found on this machine.' }
    }

    const profile = cfg.browserProfile || join(process.env.LOCALAPPDATA || home, 'DshDesktop', 'EdgeProfile')
    try {
      mkdirSync(profile, { recursive: true })
    } catch {
      // an unusable profile directory is not fatal; the browser reports it
    }

    const url = authenticatedUrl()
    if (!url) {
      note('launch rejected: token not ready')
      return { ok: false, error: 'The access token is not ready yet; retry in a moment.' }
    }
    const argv = [
      browser,
      `--app=${url}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-mode',
      '--disable-features=Translate,TranslateUI',
      '--lang=zh-CN',
      `--window-size=${cfg.windowWidth},${cfg.windowHeight}`,
    ]

    try {
      window?.handle?.terminate?.()
    } catch {
      // the previous window already exited
    }

    let handle
    try {
      handle = ctx.subprocess.spawn({
        argv,
        cwd: home,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 65536 },
          stderr: { maxBytes: 65536 },
        },
        graceMs: 2000,
      })
    } catch (error) {
      note(`spawn failed: ${error instanceof Error ? error.message : String(error)}`)
      return { ok: false, error: `Could not start the browser: ${String(error)}` }
    }

    const entry = { browser, handle, startedAt: new Date().toISOString() }
    window = entry
    lastLaunch = { ok: true, browser, at: entry.startedAt }
    note(`app window started via ${browser}`)

    handle.done
      .then((outcome) => {
        note(`app window closed (exit ${outcome?.exitCode ?? 'unknown'})`)
      })
      .catch((error) => {
        note(`app window failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => {
        if (window === entry) window = null
      })

    return { ok: true, browser, url }
  }

  /**
   * 会话删除的顺序是刻意反着来的：
   *   1) 先删磁盘目录 —— 唯一会被操作系统挡住的一步（本进程打开过的会话持有写句柄）；
   *   2) 再摘 workspace 记账 —— 列表行由 `sessionIds` 驱动，摘掉就消失；
   *   3) 清归档/置顶集合与投影缓存记录。
   * 第 1 步失败就什么都不改，用户重启后重试；若先摘记账再删文件，一旦文件被占用就会
   * 留下「列表里没了、磁盘还在」的半成品，那比拒绝更难受。
   */
  const isLiveSession = (sessionId) => {
    const sessions = ctx.get('sessions')
    if (sessions && typeof sessions.get === 'function' && sessions.get(sessionId) !== undefined) return true
    const agents = ctx.get('agents')
    if (agents && typeof agents.get === 'function' && agents.get(sessionId) !== undefined) return true
    return false
  }

  const persistenceSnapshot = async (sessionId) => {
    const store = ctx.get('sessionPersistence')
    if (!store || typeof store.stat !== 'function') return undefined
    try {
      return await store.stat(sessionId)
    } catch {
      return undefined
    }
  }

  /** 会话在磁盘/内存里的可观察事实，给 UI 预检和删除结果共用。 */
  const sessionInfo = async (sessionId) => {
    const snapshotOfSession = await persistenceSnapshot(sessionId)
    const live = isLiveSession(sessionId)
    const file = snapshotOfSession?.location?.path ?? null

    let archived = false
    let pinned = false
    let workspaceId = null
    const registry = ctx.get('workspaceRegistry')
    if (registry) {
      try {
        archived = Array.isArray(registry.archivedSessionIds) && registry.archivedSessionIds.includes(sessionId)
        pinned = Array.isArray(registry.pinnedSessionIds) && registry.pinnedSessionIds.includes(sessionId)
        if (typeof registry.list === 'function') {
          for (const workspace of registry.list()) {
            let members = []
            try {
              members = workspace.sessionIds ?? []
            } catch {
              members = []
            }
            if (Array.isArray(members) && members.includes(sessionId)) {
              workspaceId = String(workspace.id)
              break
            }
          }
        }
      } catch {
        /* 观察失败不影响删除本身：下面各步各有自己的容错 */
      }
    }

    return {
      sessionId,
      live,
      exists: snapshotOfSession !== undefined || live,
      file,
      sizeBytes: snapshotOfSession?.sizeBytes ?? null,
      parentSession: snapshotOfSession?.header?.parentSession ?? null,
      archived,
      pinned,
      workspaceId,
    }
  }

  /**
   * 从每个记账中的 workspace 摘掉该会话。
   * 优先用 Workspace 实体的 `detachSession`（走 domain 写链，附带 prune 与变更事件）；
   * 版本里没有该方法时退回直接改同一张 `workspace` domain 表 —— 仍是同一次原子写。
   */
  const detachFromWorkspaces = async (sessionId) => {
    const registry = ctx.get('workspaceRegistry')
    if (!registry || typeof registry.list !== 'function') return []
    const detached = []
    for (const workspace of registry.list()) {
      let members = []
      try {
        members = workspace.sessionIds ?? []
      } catch {
        members = []
      }
      if (!Array.isArray(members) || !members.includes(sessionId)) continue

      if (typeof workspace.detachSession === 'function') {
        await workspace.detachSession(sessionId)
        detached.push(String(workspace.id))
        continue
      }

      const table = ctx.get('storageDomain')?.get?.('workspace')?.table?.('workspaces')
      if (table && typeof table.update === 'function') {
        await table.update(workspace.id, (record) => ({
          ...record,
          sessionIds: (record.sessionIds ?? []).filter((id) => id !== sessionId),
        }))
        detached.push(String(workspace.id))
      }
    }
    return detached
  }

  /**
   * 只清置顶。归档条目**故意保留**：归档态是「这一行不出现在常规列表」的开关，
   * 而本进程内存里的会话对象删不掉（DSH 没有卸载单个会话的 API），清掉归档它就会掉进
   * 「未分组」并且刷新页面也带不走。条目留到下次启动时由 sweepDanglingArchiveEntries 收尾。
   */
  const dropPinOnly = async (sessionId) => {
    const registry = ctx.get('workspaceRegistry')
    const cleared = []
    if (!registry) return cleared
    const has = (value) => {
      try {
        return Array.isArray(value) && value.includes(sessionId)
      } catch {
        return false
      }
    }
    if (has(registry.pinnedSessionIds) && typeof registry.unpinSession === 'function') {
      await registry.unpinSession(sessionId)
      cleared.push('pinned')
    }
    return cleared
  }

  /**
   * 启动清扫：归档集合里指向「既没有 Agent、磁盘也没有日志」的条目是删除留下的，
   * 把它们摘掉才是彻底干净。真正归档的会话磁盘还在，不会被动到。
   */
  const sweepDanglingArchiveEntries = async () => {
    const registry = ctx.get('workspaceRegistry')
    if (!registry || !Array.isArray(registry.archivedSessionIds)) return []
    const store = ctx.get('sessionPersistence')
    const sessions = ctx.get('sessions')
    const swept = []
    for (const sessionId of [...registry.archivedSessionIds]) {
      if (sessions?.get?.(sessionId) !== undefined) continue
      let snapshot
      try {
        snapshot = await store?.stat?.(sessionId)
      } catch {
        continue
      }
      if (snapshot !== undefined) continue
      try {
        await registry.unarchiveSession(sessionId)
        swept.push(sessionId)
      } catch {
        /* 清不掉就留到下次启动 */
      }
    }
    if (swept.length > 0) note(`swept ${swept.length} dangling archive entr${swept.length === 1 ? 'y' : 'ies'}`)
    return swept
  }

  /** 投影缓存是 storage-json 的 `session_projcache` 域，一条会话一条记录。 */
  const dropProjectionCache = async (sessionId) => {
    try {
      const domain = ctx.get('storageDomain')?.get?.('session_projcache')
      const table = domain?.table?.('sessions') ?? domain?.tables?.sessions
      if (table && typeof table.delete === 'function') return await table.delete(sessionId)
    } catch {
      /* 清不掉只是留下一个再也读不到的缓存记录，不影响删除语义 */
    }
    return false
  }

  /**
   * 删会话目录（permanent 模式）。位置来自 persistence 自己的 `location`，
   * 不复制它的路径编码规则；目录名最后一段必须就是这个会话 id。
   */
  const removeSessionFiles = async (sessionId, file) => {
    if (!file) return []
    const dir = dirname(file)
    if (basename(dir) !== sessionId) {
      throw new Error(`refusing to delete an unexpected location: ${dir}`)
    }
    await rm(dir, { recursive: true, force: true })
    return [dir]
  }

  // ── 回收站 ────────────────────────────────────────────────────────────────────
  // 默认删除是把会话目录 rename 进 `<数据根>/_trash/<批次>/<会话id>/`，而不是 rm：
  // 同卷 rename 是原子的，失败就是没动；批次里的 move-plan.json 记着原位，删错了能搬回来。
  // `_trash` 必须放在 `sessions/` 之外，否则下一次扫描会把它当成一个 project。

  const TRASH_DIRNAME = '_trash'
  const TRASH_PLAN_FILENAME = 'move-plan.json'
  const TRASH_BATCH_PATTERN = /^[0-9A-Za-z_-]{1,80}$/
  const AGENT_IDLE_TIMEOUT_MS = 5000

  /** 成功解析过的数据根；`_trash` 的读写都落在它下面。 */
  let knownDataRoot = null

  /**
   * 数据根只从证据里取：优先由持久化报的日志位置反推 `<home>/sessions/<project>/<id>/<log>`，
   * 其次 `DSH_HOME`，最后 `~/.dsh`。绝不按会话内容猜别的位置。
   */
  const dataRootOf = (file) => {
    if (file) {
      const sessionsDir = dirname(dirname(dirname(file)))
      if (basename(sessionsDir) === 'sessions') {
        knownDataRoot = dirname(sessionsDir)
        return knownDataRoot
      }
    }
    if (knownDataRoot !== null) return knownDataRoot
    const configured = process.env.DSH_HOME
    if (typeof configured === 'string' && configured.trim() !== '') return configured
    return join(process.env.USERPROFILE || homedir(), '.dsh')
  }

  const trashRootOf = (file) => join(dataRootOf(file), TRASH_DIRNAME)

  /** 批次名精确到毫秒；撞名交给文件系统的 EEXIST 加后缀重试，不赌同一毫秒不会撞。 */
  const createTrashBatch = async (file) => {
    const root = trashRootOf(file)
    await mkdir(root, { recursive: true })
    const at = new Date()
    const pad = (value, width = 2) => String(value).padStart(width, '0')
    const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-`
      + `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}-${pad(at.getMilliseconds(), 3)}`
    for (let n = 0; n < 1000; n += 1) {
      const name = n === 0 ? stamp : `${stamp}-${n}`
      const dir = join(root, name)
      try {
        await mkdir(dir)
        return { name, dir }
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
      }
    }
    throw new Error('could not allocate a unique trash batch directory')
  }

  /**
   * 会话标题：删之前问一次内核，写进回收站的 move-plan.json。
   * 目录一旦搬走就再也读不到标题，所以只能趁早。
   */
  const sessionTitle = async (sessionId) => {
    const query = ctx.get('sessionQuery')
    if (!query || typeof query.readTitle !== 'function') return null
    try {
      const snapshot = await query.readTitle(sessionId)
      const title = typeof snapshot === 'string' ? snapshot : snapshot?.title
      return typeof title === 'string' && title.trim() !== '' ? title.trim() : null
    } catch {
      return null
    }
  }

  /** 把会话目录搬进批次目录。同卷 rename，失败即未移动；目标已存在则加后缀，绝不覆盖。 */
  const moveIntoTrash = async (sessionId, file, batchDir) => {
    const source = dirname(file)
    if (basename(source) !== sessionId) {
      throw new Error(`refusing to move an unexpected location: ${source}`)
    }
    let target = join(batchDir, sessionId)
    for (let n = 1; existsSync(target); n += 1) target = join(batchDir, `${sessionId}-${n}`)
    await rename(source, target)
    return { from: source, to: target }
  }

  const readTrashPlan = async (batchDir) => {
    try {
      const parsed = JSON.parse(await readFile(join(batchDir, TRASH_PLAN_FILENAME), 'utf8'))
      if (!parsed || !Array.isArray(parsed.entries)) return null
      return parsed
    } catch {
      return null
    }
  }

  /** 回收站清单：一个子目录一个批次，只有带 move-plan.json 的才算数。 */
  const listTrash = async () => {
    const root = trashRootOf(null)
    let names = []
    try {
      names = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch {
      return { root, batches: [] }
    }
    const batches = []
    for (const name of names.sort().reverse()) {
      const dir = join(root, name)
      const plan = await readTrashPlan(dir)
      batches.push({
        name,
        createdAt: typeof plan?.createdAt === 'string' ? plan.createdAt : null,
        entries: (plan?.entries ?? []).map((entry) => ({
          sessionId: String(entry.sessionId ?? ''),
          title: typeof entry.title === 'string' && entry.title !== '' ? entry.title : null,
          from: String(entry.from ?? ''),
          workspaceId: entry.workspaceId ?? null,
        })),
      })
    }
    return { root, batches }
  }

  /** 恢复一个批次：按 move-plan.json 原样搬回原位，再挂回它原来的工作区。 */
  const restoreTrashBatch = async (name) => {
    if (!TRASH_BATCH_PATTERN.test(name)) throw new Error('invalid batch name')
    const dir = join(trashRootOf(null), name)
    const plan = await readTrashPlan(dir)
    if (plan === null) throw new Error(`no move plan in ${dir}`)
    const registry = ctx.get('workspaceRegistry')
    // move-plan.json 是可编辑的文本，只认数据根下 `sessions/` 里的位置，不拿它当任意写入许可。
    const sessionsRoot = join(dataRootOf(null), 'sessions')
    const insideStore = (path) => path.toLowerCase().startsWith(sessionsRoot.toLowerCase() + sep.toLowerCase())
    const restored = []
    const failed = []
    for (const entry of plan.entries) {
      const sessionId = String(entry.sessionId ?? '')
      const from = String(entry.from ?? '')
      const to = String(entry.to ?? '')
      try {
        if (sessionId === '' || from === '' || to === '' || basename(from) !== sessionId) {
          throw new Error('move plan entry is not a session directory')
        }
        if (!insideStore(from)) {
          throw new Error(`move plan entry points outside the session store: ${from}`)
        }
        if (existsSync(from)) {
          // 原位已经有同名目录、回收站里那份却不见了：这条早就恢复过。
          // 旧版本恢复时不删批次，所以同一对话会在列表里留下第二条记录，这里按幂等收掉。
          if (!existsSync(to)) {
            restored.push({ sessionId, from, reattached: null, alreadyRestored: true })
            continue
          }
          throw new Error('target already exists')
        }
        await mkdir(dirname(from), { recursive: true })
        await rename(to, from)
        let reattached = null
        if (entry.workspaceId && registry && typeof registry.get === 'function') {
          const workspace = registry.get(entry.workspaceId)
          if (workspace && typeof workspace.attachSession === 'function') {
            try {
              await workspace.attachSession(sessionId)
              reattached = String(entry.workspaceId)
            } catch {
              /* 挂不回工作区不算失败：会话回到磁盘，只是回到未分组 */
            }
          }
        }
        // 删除时把会话挂进了归档集合（靠归档态把这一行藏起来），恢复时要摘掉，
        // 否则它回来了却还躲在归档里。
        try {
          if (Array.isArray(registry?.archivedSessionIds)
            && registry.archivedSessionIds.includes(sessionId)
            && typeof registry.unarchiveSession === 'function') {
            await registry.unarchiveSession(sessionId)
          }
        } catch {
          /* 摘不掉只是让它留在归档区 */
        }
        restored.push({ sessionId, from, reattached })
      } catch (error) {
        failed.push({ sessionId, error: error instanceof Error ? error.message : String(error) })
      }
    }

    // 全部搬回就把批次收干净：留着一个空目录，用户会看到同一个对话的第二条记录。
    // 有失败条目时保留批次，但只留没恢复的那些。
    if (failed.length === 0) {
      await rm(dir, { recursive: true, force: true })
    } else {
      const remaining = plan.entries.filter((entry) => failed.some((item) => item.sessionId === entry.sessionId))
      await writeFile(join(dir, TRASH_PLAN_FILENAME), JSON.stringify({
        createdAt: plan.createdAt,
        entries: remaining,
      }, null, 2), 'utf8')
    }

    return { batch: name, restored, failed }
  }

  const purgeTrashBatch = async (name) => {
    if (!TRASH_BATCH_PATTERN.test(name)) throw new Error('invalid batch name')
    const dir = join(trashRootOf(null), name)
    await rm(dir, { recursive: true, force: true })
    return dir
  }

  /** 子会话树：按 header.parentSession 认亲，由深到浅返回（删父不删子会留下孤儿行）。 */
  const sessionDescendants = async (sessionId) => {
    const store = ctx.get('sessionPersistence')
    if (!store || typeof store.list !== 'function') return []
    let snapshots = []
    try {
      snapshots = await store.list()
    } catch {
      return []
    }
    const childrenOf = new Map()
    for (const snapshot of snapshots) {
      const parent = snapshot?.header?.parentSession
      if (typeof parent === 'string' && parent !== '') {
        if (!childrenOf.has(parent)) childrenOf.set(parent, [])
        childrenOf.get(parent).push(snapshot.header.id)
      }
    }
    const out = []
    const walk = (id) => {
      for (const child of childrenOf.get(id) ?? []) {
        walk(child)
        out.push(child)
      }
    }
    walk(sessionId)
    return out
  }

  /**
   * 删前结算：走 Workspace 的 stop 缝让 Agent/任务/子智能体停下，等 Agent 自己发布 idle，
   * 再做一次 flush。之后才碰文件，避免删完还有一个在飞的 step 往日志里写。
   */
  const settleSession = async (sessionId) => {
    const warnings = []
    const absorb = (label) => (error) => warnings.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)

    try {
      await ctx.parallel('workspace/session-stop', { sessionId })
    } catch (error) {
      absorb('stop activity')(error)
    }

    const agent = ctx.get('agents')?.get?.(sessionId)
    if (agent && typeof agent.whenIdle === 'function') {
      try {
        await Promise.race([
          Promise.resolve(agent.whenIdle()),
          new Promise((resolve) => setTimeout(resolve, AGENT_IDLE_TIMEOUT_MS)),
        ])
      } catch (error) {
        absorb('await idle')(error)
      }
    }

    const sessions = ctx.get('sessions')
    const live = sessions?.get?.(sessionId)
    if (live !== undefined && typeof sessions?.flush === 'function') {
      try {
        await sessions.flush(live)
      } catch (error) {
        absorb('flush')(error)
      }
    }
    return warnings
  }

  /**
   * 删前先归档：归档态就是「这一行不出现在常规列表」的开关，所以删除后会话不会掉进
   * 「未分组」。条目刻意保留 —— 本进程还持有它的会话对象，清掉归档它就会重新露出来。
   */
  const archiveBeforeDelete = async (sessionId) => {
    const registry = ctx.get('workspaceRegistry')
    if (!registry || typeof registry.archiveSession !== 'function') return []
    try {
      if (Array.isArray(registry.archivedSessionIds) && registry.archivedSessionIds.includes(sessionId)) return []
      await registry.archiveSession(sessionId, { stopActivity: true })
      return []
    } catch (error) {
      return [`archive: ${error instanceof Error ? error.message : String(error)}`]
    }
  }

  /**
   * 删除一个会话（可选级联子会话）。
   *
   * 顺序：结算活动 → 归档（先让行消失）→ 搬走/删掉文件 → 才动记账与缓存。
   * 文件这一步失败会把已搬的按逆序搬回，记账一个字都不改。
   */
  const deleteSession = async (sessionId, options = {}) => {
    const cascade = options.cascade === true
    const permanent = options.permanent === true

    const info = await sessionInfo(sessionId)
    const accounted = info.archived || info.pinned || info.workspaceId !== null
    if (!info.exists && !accounted) {
      return { status: 404, body: { ok: false, code: 'session-unknown', error: 'no such session' } }
    }
    // 子会话不能单独删：它的父对话还在，删掉半边树只会留下一个点不开的父行。
    if (typeof info.parentSession === 'string' && info.parentSession !== '') {
      return {
        status: 409,
        body: {
          ok: false,
          code: 'session-child',
          parentSession: info.parentSession,
          error: 'that is a sub-agent session; delete its parent conversation instead',
        },
      }
    }

    const targetIds = [sessionId, ...(cascade ? await sessionDescendants(sessionId) : [])]
    const infos = new Map([[sessionId, info]])
    for (const id of targetIds.slice(1)) infos.set(id, await sessionInfo(id))

    const warnings = []
    const moved = []
    const removedPaths = []
    const archived = []
    const titles = new Map()
    let batch = null

    try {
      for (const id of targetIds) {
        const target = infos.get(id)
        warnings.push(...(await settleSession(id)))

        if (!target.file) continue
        // 有日志才需要「藏起来」；没有日志的幽灵条目只剩归档记账，交给下面直接摘掉。
        warnings.push(...(await archiveBeforeDelete(id)))
        archived.push(id)
        // 标题只能趁目录还在的时候读，搬进回收站后就查不到了。
        titles.set(id, await sessionTitle(id))

        if (permanent) {
          removedPaths.push(...(await removeSessionFiles(id, target.file)))
          continue
        }
        if (batch === null) batch = await createTrashBatch(target.file)
        moved.push({ sessionId: id, ...(await moveIntoTrash(id, target.file, batch.dir)) })
      }
    } catch (error) {
      // 已搬走的按逆序搬回：宁可整体失败，也不留一半在回收站、一半在原位。
      for (const entry of [...moved].reverse()) {
        try {
          await rename(entry.to, entry.from)
        } catch {
          /* 搬不回去时保留在回收站，batch 里仍有它的去向 */
        }
      }
      return {
        status: 409,
        body: {
          ok: false,
          code: 'session-busy',
          sessionId,
          moved: [],
          error: `could not move the conversation out of the way (${error instanceof Error ? error.message : String(error)}); nothing was deleted`,
        },
      }
    }

    if (batch !== null && moved.length > 0) {
      await writeFile(join(batch.dir, TRASH_PLAN_FILENAME), JSON.stringify({
        createdAt: new Date().toISOString(),
        entries: moved.map((entry) => ({
          sessionId: entry.sessionId,
          title: titles.get(entry.sessionId) ?? null,
          from: entry.from,
          to: entry.to,
          workspaceId: infos.get(entry.sessionId)?.workspaceId ?? null,
        })),
      }, null, 2), 'utf8')
    }

    // 文件都处理完了才动名册：任何一步失败，列表与磁盘都不会各说一套。
    const detached = []
    const cleared = []
    let cacheDropped = false
    const registry = ctx.get('workspaceRegistry')
    const archivedKept = []
    for (const id of targetIds) {
      detached.push(...(await detachFromWorkspaces(id)))
      cleared.push(...(await dropPinOnly(id)))
      let isArchived = false
      try {
        isArchived = Array.isArray(registry?.archivedSessionIds) && registry.archivedSessionIds.includes(id)
      } catch {
        isArchived = false
      }
      if (archived.includes(id) && isArchived) {
        // 有日志的会话：归档条目保留，行才不会掉进「未分组」；下次启动由清扫收尾。
        archivedKept.push(id)
      } else if (isArchived && typeof registry?.unarchiveSession === 'function') {
        // 没有日志的幽灵条目：唯一的残留就是这条归档记录，直接摘掉。
        await registry.unarchiveSession(id)
        cleared.push('archived')
      }
      if (await dropProjectionCache(id)) cacheDropped = true
    }

    if (detached.length === 0 && cleared.length === 0 && moved.length === 0 && removedPaths.length === 0 && cacheDropped !== true) {
      return {
        status: 409,
        body: { ok: false, code: 'nothing-removed', error: 'the session was not accounted anywhere and had no stored directory' },
      }
    }

    return {
      status: 200,
      body: {
        ok: true,
        sessionId,
        mode: permanent ? 'permanent' : 'trash',
        batch: batch?.name ?? null,
        moved,
        removed: removedPaths,
        detached,
        cleared,
        cacheDropped,
        archivedKept,
        children: targetIds.slice(1),
        stale: info.live,
        warnings,
      },
    }
  }

  const snapshot = () => ({
    ok: true,
    origin: originUrl(),
    url: authenticatedUrl(),
    closeStopsServer: stopsServer(),
    closeToTray: prefs.closeToTray !== false,
    windowOpen: window !== null,
    browser: window?.browser ?? null,
    lastLaunch,
    events: events.slice(-10).reverse(),
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/_desktop/status',
    handler: (req, res) => {
      const rejection = guard(req.headers)
      if (rejection) return sendJson(res, rejection.body, rejection.status)
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('allow', 'GET, HEAD')
        return sendJson(res, { ok: false, error: 'method not allowed' }, 405)
      }
      sendJson(res, snapshot())
    },
  }))

  /**
   * What a native shell needs before it opens a window: the tokenized URL plus the
   * few policy values it must not hard-code. The shell stores nothing.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/_desktop/launch-info',
    handler: (req, res) => {
      const rejection = guard(req.headers)
      if (rejection) return sendJson(res, rejection.body, rejection.status)
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('allow', 'GET, HEAD')
        return sendJson(res, { ok: false, error: 'method not allowed' }, 405)
      }
      const url = authenticatedUrl()
      if (!url) {
        return sendJson(res, { ok: false, error: 'token not ready' }, 503)
      }
      sendJson(res, {
        ok: true,
        mode: 'shell',
        url,
        origin: originUrl(),
        title: 'DeepSeek Harness',
        closeStopsServer: stopsServer(),
        closeToTray: prefs.closeToTray !== false,
        window: { width: cfg.windowWidth, height: cfg.windowHeight },
      })
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/_desktop/launch',
    handler: async (req, res) => {
      const rejection = guard(req.headers)
      if (rejection) return sendJson(res, rejection.body, rejection.status)
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST')
        return sendJson(res, { ok: false, error: 'POST only' }, 405)
      }
      const result = await launch()
      sendJson(res, result, result.ok ? 200 : 500)
    },
  }))

  /**
   * The shell reports its own teardown. `stopService` answers the one question the
   * shell cannot decide alone; the shell still only kills a server it started.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/_desktop/closed',
    handler: (req, res) => {
      const rejection = guard(req.headers)
      if (rejection) return sendJson(res, rejection.body, rejection.status)
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST')
        return sendJson(res, { ok: false, error: 'POST only' }, 405)
      }
      note('desktop shell closed')
      sendJson(res, { ok: true, stopService: stopsServer() })
    },
  }))

  /**
   * 壳在每次关窗时读一次这个偏好，所以改完立刻生效，不需要重启壳或重挂插件。
   * 写入独立的小文件（不是 profile 的 cordis.patch.yml）：改配置不该触发插件重启。
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/_desktop/prefs',
    handler: async (req, res) => {
      const rejection = guard(req.headers)
      if (rejection) return sendJson(res, rejection.body, rejection.status)
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST')
        return sendJson(res, { ok: false, error: 'POST only' }, 405)
      }

      let body = {}
      try {
        body = JSON.parse(await readBody(req)) ?? {}
      } catch {
        return sendJson(res, { ok: false, error: 'invalid body' }, 400)
      }

      if (typeof body.closeToTray === 'boolean') prefs.closeToTray = body.closeToTray
      if (typeof body.stopServerOnClose === 'boolean') prefs.stopServerOnClose = body.stopServerOnClose
      if (!writePrefs(prefs)) {
        return sendJson(res, { ok: false, error: 'could not write ' + PREFS_PATH }, 500)
      }

      note(`closeToTray=${prefs.closeToTray !== false} stopServerOnClose=${stopsServer()}`)
      sendJson(res, {
        ok: true,
        closeToTray: prefs.closeToTray !== false,
        closeStopsServer: stopsServer(),
      })
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/_desktop/shell-info',
    handler: async (req, res) => {
      const rejection = guard(req.headers)
      if (rejection) return sendJson(res, rejection.body, rejection.status)
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('allow', 'GET, HEAD')
        return sendJson(res, { ok: false, error: 'method not allowed' }, 405)
      }
      sendJson(res, await shellInfo())
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/_desktop/shell',
    handler: async (req, res) => {
      const rejection = guard(req.headers)
      if (rejection) return sendJson(res, rejection.body, rejection.status)
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST')
        return sendJson(res, { ok: false, error: 'POST only' }, 405)
      }

      let action = ''
      try {
        action = String(JSON.parse(await readBody(req)).action ?? '')
      } catch {
        return sendJson(res, { ok: false, error: 'invalid body' }, 400)
      }

      let result
      switch (action) {
        case 'autostart-on': result = await setAutostart(true); break
        case 'autostart-off': result = await setAutostart(false); break
        case 'shortcut-create': result = await createShortcut(); break
        case 'shortcut-remove': result = await removeShortcut(); break
        default: return sendJson(res, { ok: false, error: `unknown action: ${action}` }, 400)
      }

      sendJson(res, { ...result, ...(await shellInfo()) }, result.ok ? 200 : 500)
    },
  }))

  /**
   * 删除前的预检：会话是否开着、在不在磁盘上、多大、是否仍在某个工作区/归档集合里。
   * UI 用它决定能不能点「删除」，也用它告诉用户将要删掉什么。
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/_desktop/session-info',
    handler: async (req, res) => {
      const rejection = guard(req.headers)
      if (rejection) return sendJson(res, rejection.body, rejection.status)
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST')
        return sendJson(res, { ok: false, error: 'POST only' }, 405)
      }

      let sessionId = ''
      try {
        sessionId = String(JSON.parse(await readBody(req)).sessionId ?? '')
      } catch {
        return sendJson(res, { ok: false, error: 'invalid body' }, 400)
      }
      if (!SESSION_ID_PATTERN.test(sessionId)) {
        return sendJson(res, { ok: false, error: 'invalid session id' }, 400)
      }

      sendJson(res, {
        ok: true,
        ...(await sessionInfo(sessionId)),
        // 子智能体会话数：删父对话时一起处理，UI 用它把「会影响几个会话」说清楚。
        childCount: (await sessionDescendants(sessionId)).length,
      })
    },
  }))

  /**
   * 删除一个会话。默认搬进回收站（可恢复），`permanent: true` 才真正 rm；
   * `cascade: true` 连同子智能体会话一起处理。DSH 只有归档，这里补的是真删除。
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/_desktop/session-delete',
    handler: async (req, res) => {
      const rejection = guard(req.headers)
      if (rejection) return sendJson(res, rejection.body, rejection.status)
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST')
        return sendJson(res, { ok: false, error: 'POST only' }, 405)
      }

      let body = {}
      try {
        body = JSON.parse(await readBody(req)) ?? {}
      } catch {
        return sendJson(res, { ok: false, error: 'invalid body' }, 400)
      }
      const sessionId = String(body.sessionId ?? '')
      if (!SESSION_ID_PATTERN.test(sessionId)) {
        return sendJson(res, { ok: false, error: 'invalid session id' }, 400)
      }

      try {
        const result = await deleteSession(sessionId, {
          cascade: body.cascade === true,
          permanent: body.permanent === true,
        })
        if (result.status === 200) {
          const extra = result.body.children.length > 0 ? ` (+${result.body.children.length} child)` : ''
          note(`deleted session ${sessionId} → ${result.body.mode}${extra}`)
        } else {
          note(`delete session ${sessionId} refused: ${result.body.code}`)
        }
        sendJson(res, result.body, result.status)
      } catch (error) {
        note(`delete session ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}`)
        sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
      }
    },
  }))

  /** 回收站清单：只读，列出批次、时间与批次里的会话。 */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/_desktop/trash',
    handler: async (req, res) => {
      const rejection = guard(req.headers)
      if (rejection) return sendJson(res, rejection.body, rejection.status)
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('allow', 'GET, HEAD')
        return sendJson(res, { ok: false, error: 'method not allowed' }, 405)
      }
      try {
        sendJson(res, { ok: true, ...(await listTrash()) })
      } catch (error) {
        sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
      }
    },
  }))

  /** 从回收站恢复一个批次：按 move-plan.json 搬回原位，并挂回它原来的工作区。 */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/_desktop/trash-restore',
    handler: async (req, res) => {
      const rejection = guard(req.headers)
      if (rejection) return sendJson(res, rejection.body, rejection.status)
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST')
        return sendJson(res, { ok: false, error: 'POST only' }, 405)
      }
      let batch = ''
      try {
        batch = String(JSON.parse(await readBody(req)).batch ?? '')
      } catch {
        return sendJson(res, { ok: false, error: 'invalid body' }, 400)
      }
      if (!TRASH_BATCH_PATTERN.test(batch)) {
        return sendJson(res, { ok: false, error: 'invalid batch name' }, 400)
      }
      try {
        const result = await restoreTrashBatch(batch)
        note(`restored trash batch ${batch}: ${result.restored.length} session(s)`)
        sendJson(res, { ok: true, ...result }, result.failed.length === 0 ? 200 : 207)
      } catch (error) {
        sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
      }
    },
  }))

  /** 永久清除一个回收站批次。 */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/_desktop/trash-purge',
    handler: async (req, res) => {
      const rejection = guard(req.headers)
      if (rejection) return sendJson(res, rejection.body, rejection.status)
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST')
        return sendJson(res, { ok: false, error: 'POST only' }, 405)
      }
      let batch = ''
      try {
        batch = String(JSON.parse(await readBody(req)).batch ?? '')
      } catch {
        return sendJson(res, { ok: false, error: 'invalid body' }, 400)
      }
      if (!TRASH_BATCH_PATTERN.test(batch)) {
        return sendJson(res, { ok: false, error: 'invalid batch name' }, 400)
      }
      try {
        const dir = await purgeTrashBatch(batch)
        note(`purged trash batch ${batch}`)
        sendJson(res, { ok: true, batch, dir })
      } catch (error) {
        sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
      }
    },
  }))

  /**
   * 启动清扫：上一次运行里删掉的会话只剩一条归档记账，这里把它摘干净。
   * 真正的归档会话磁盘还在，`stat` 有结果，不会被动到。
   */
  ctx.effect(() => {
    const delay = Number.isFinite(cfg.sweepDelayMs) ? Math.max(0, cfg.sweepDelayMs) : 5000
    const timer = setTimeout(() => { void sweepDanglingArchiveEntries().catch(() => {}) }, delay)
    if (typeof timer?.unref === 'function') timer.unref()
    return () => clearTimeout(timer)
  })

  note('desktop bridge ready')
}
