/**
 * 隔离验证：直接加载 dsh-desktop-app 的 Host 半区，用假的 ctx 驱动它。
 * 不接触运行中的 dsh web 进程，也不写真实 ~/.dsh/desktop-app.json（USERPROFILE 指向临时目录）。
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const sandboxHome = mkdtempSync(join(tmpdir(), 'deskapp-home-'))
process.env.USERPROFILE = sandboxHome
delete process.env.DSH_DESKTOP_SHELL

const repo = process.argv[2]
const mod = await import(pathToFileURL(join(repo, 'index.js')).href)

const routes = new Map()
let effects = 0
const fakeShell = join(sandboxHome, 'fake-shell.exe')
writeFileSync(fakeShell, '')
process.env.DSH_DESKTOP_SHELL = fakeShell

const ctx = {
  effect: (fn) => { effects += 1; return fn() },
  get: (name) => (name === 'connection'
    ? { allowsRemoteAuthorities: false, authenticatedUrl: (base) => `${base}/?token=TESTTOKEN` }
    : undefined),
  webServer: {
    getOrigin: () => 'http://127.0.0.1:3999',
    register: (route) => { routes.set(route.path, route.handler); return () => {} },
  },
  subprocess: {
    spawn: () => { throw new Error('spawn should not be called in this test') },
    resolveExecutable: async () => { throw new Error('not found') },
  },
}

mod.apply(ctx, { closeToTray: true, closeStopsServer: true })

const results = []
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ name, ok, actual, expected })
}

const call = (path, method = 'GET', body = undefined, headers = {}) => new Promise((resolve) => {
  const chunks = []
  const res = {
    statusCode: 0,
    headers: {},
    writeHead(status, nextHeaders) { this.statusCode = status; Object.assign(this.headers, nextHeaders) },
    setHeader(key, value) { this.headers[key] = value },
    end(payload) {
      const text = payload ?? ''
      resolve({ status: this.statusCode, json: text ? JSON.parse(text) : null })
    },
  }
  const req = {
    method,
    headers: { host: '127.0.0.1:3999', ...headers },
    on(event, handler) {
      if (event === 'data' && body !== undefined) handler(JSON.stringify(body))
      if (event === 'end') handler()
      return this
    },
    destroy() {},
  }
  Promise.resolve(routes.get(path)(req, res)).catch((error) => resolve({ status: -1, json: { error: String(error) } }))
})

check('注册路由数', [...routes.keys()].sort(), [
  '/_desktop/closed', '/_desktop/launch-info', '/_desktop/launch', '/_desktop/prefs',
  '/_desktop/shell', '/_desktop/shell-info', '/_desktop/status'].sort())
check('effect 数量', effects, 7)

let r = await call('/_desktop/status')
check('初值 closeToTray', r.json.closeToTray, true)
check('初值 closeStopsServer', r.json.closeStopsServer, true)

r = await call('/_desktop/closed', 'POST', {})
check('初值 stopService', r.json.stopService, true)

r = await call('/_desktop/prefs', 'POST', { stopServerOnClose: false })
check('prefs 应答 closeStopsServer', r.json.closeStopsServer, false)

r = await call('/_desktop/closed', 'POST', {})
check('单一真源：/closed 跟随 prefs', r.json.stopService, false)

r = await call('/_desktop/status')
check('单一真源：/status 跟随 prefs', r.json.closeStopsServer, false)

r = await call('/_desktop/launch-info')
check('单一真源：/launch-info 跟随 prefs', r.json.closeStopsServer, false)
check('launch-info 带 token', r.json.url, 'http://127.0.0.1:3999/?token=TESTTOKEN')

const prefsFile = join(sandboxHome, '.dsh', 'desktop-app.json')
check('偏好文件落盘', JSON.parse(readFileSync(prefsFile, 'utf8')), { closeToTray: true, stopServerOnClose: false })

r = await call('/_desktop/prefs', 'POST', { closeToTray: false, stopServerOnClose: true })
check('两个开关可同改', { tray: r.json.closeToTray, stop: r.json.closeStopsServer }, { tray: false, stop: true })
check('磁盘内容同步', JSON.parse(readFileSync(prefsFile, 'utf8')), { closeToTray: false, stopServerOnClose: true })

r = await call('/_desktop/shell-info')
check('壳路径走 DSH_DESKTOP_SHELL', r.json.shellPath, fakeShell)
check('壳存在判定', r.json.shellExists, true)

r = await call('/_desktop/status', 'GET', undefined, { host: '10.0.0.5:3999' })
check('非 loopback 被拒', r.status, 403)

r = await call('/_desktop/prefs', 'GET')
check('prefs 只收 POST', r.status, 405)

check('未知路由不注册', routes.has('/_desktop/closoid'), false)

const failed = results.filter((item) => !item.ok)
for (const item of results) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}  →  ${JSON.stringify(item.actual)}`)
}
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
