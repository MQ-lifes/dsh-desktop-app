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
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const DEFAULTS = {
  windowWidth: 1440,
  windowHeight: 900,
  // 只作为偏好文件的首次种子值：运行期真源永远是 ~/.dsh/desktop-app.json。
  closeStopsServer: true,
  closeToTray: true,
  browserProfile: '',
  /** 留空则按 shellCandidates() 的顺序自动探测。 */
  shellPath: '',
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

  note('desktop bridge ready')
}
