/**
 * 隔离验证：直接加载 dsh-desktop-app 的 Host 半区，用假的 ctx 驱动它。
 * 不接触运行中的 dsh web 进程，也不写真实 ~/.dsh/desktop-app.json（USERPROFILE 指向临时目录）。
 *
 * 会话删除那一组用临时目录里的假会话目录 + 假 registry 驱动，
 * 断言的是「记账先清、文件后删」这条顺序，以及拒绝删活会话/未知路径这两条边界。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const sandboxHome = mkdtempSync(join(tmpdir(), 'deskapp-home-'))
process.env.USERPROFILE = sandboxHome
delete process.env.DSH_DESKTOP_SHELL

const repo = process.argv[2]

// ---- 会话删除用的假持久化层 -------------------------------------------------
const sessionRoot = join(sandboxHome, 'sessions', '--proj--')
mkdirSync(sessionRoot, { recursive: true })
/** id -> { dir, sizeBytes } */
const stored = new Map()
const knownSessions = []
const archivedIds = []
const pinnedIds = []

const parentOf = new Map()

function makeStoredSession(id, parent = null, archivable = true) {
  const dir = join(sessionRoot, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), 'x'.repeat(42))
  stored.set(id, { dir, sizeBytes: 42 })
  parentOf.set(id, parent)
  knownSessions.push(id)
  // detach 会替换 workspace.sessionIds 数组，所以每次新建会话都往当前数组里补一份记账。
  if (!workspace.sessionIds.includes(id)) workspace.sessionIds.unshift(id)
  if (archivable) {
    archivedIds.push(id)
    pinnedIds.push(id)
  }
  return dir
}

const liveSessions = new Set()
const detachedIds = []
const clearedSets = []
const cacheDeletes = []

const workspace = {
  id: 'ws-1',
  sessionIds: knownSessions,
  async detachSession(sessionId) {
    detachedIds.push(sessionId)
    this.sessionIds = this.sessionIds.filter((id) => id !== sessionId)
  },
  async attachSession(sessionId) {
    if (!this.sessionIds.includes(sessionId)) this.sessionIds.unshift(sessionId)
  },
}

const registry = {
  archivedSessionIds: archivedIds,
  pinnedSessionIds: pinnedIds,
  list: () => [workspace],
  get: (id) => (id === workspace.id ? workspace : undefined),
  async archiveSession(sessionId) {
    if (!archivedIds.includes(sessionId)) archivedIds.push(sessionId)
  },
  async unarchiveSession(sessionId) {
    clearedSets.push(`archived:${sessionId}`)
    archivedIds.splice(archivedIds.indexOf(sessionId), 1)
  },
  async unpinSession(sessionId) {
    clearedSets.push(`pinned:${sessionId}`)
    pinnedIds.splice(pinnedIds.indexOf(sessionId), 1)
  },
}

const services = {
  connection: { allowsRemoteAuthorities: false, authenticatedUrl: (base) => `${base}/?token=TESTTOKEN` },
  sessions: { get: (id) => (liveSessions.has(id) ? { id } : undefined) },
  agents: { get: () => undefined },
  // 删之前内核还能报标题，删完就查不到了 —— 回收站列表靠的是删除时记下的那份。
  sessionQuery: {
    async readTitle(id) { return { title: `标题 ${id}` } },
  },
  sessionPersistence: {
    async stat(id) {
      const entry = stored.get(id)
      // 真实后端按磁盘上是否存在来回答；删掉目录后同一 id 必须变成未知会话。
      if (!entry || !existsSync(entry.dir)) return undefined
      return {
        header: { id, parentSession: parentOf.get(id) ?? undefined },
        revision: 'rev-1',
        sizeBytes: entry.sizeBytes,
        location: { kind: 'jsonl', path: join(entry.dir, 'session.v4.jsonl.zstd') },
      }
    },
    async list() {
      return knownSessions
        .filter((id) => stored.has(id) && existsSync(stored.get(id).dir))
        .map((id) => ({ header: { id, parentSession: parentOf.get(id) ?? undefined } }))
    },
  },
  workspaceRegistry: registry,
  storageDomain: {
    get: (name) => (name === 'session_projcache'
      ? { table: () => ({ delete: async (key) => { cacheDeletes.push(key); return true } }) }
      : undefined),
  },
}

const mod = await import(pathToFileURL(join(repo, 'index.js')).href)

const routes = new Map()
let effects = 0
const fakeShell = join(sandboxHome, 'fake-shell.exe')
writeFileSync(fakeShell, '')
process.env.DSH_DESKTOP_SHELL = fakeShell

const settleEvents = []
const ctx = {
  effect: (fn) => { effects += 1; return fn() },
  get: (name) => services[name],
  parallel: async (event) => { settleEvents.push(event); return [] },
  webServer: {
    getOrigin: () => 'http://127.0.0.1:3999',
    register: (route) => { routes.set(route.path, route.handler); return () => {} },
  },
  subprocess: {
    spawn: () => { throw new Error('spawn should not be called in this test') },
    resolveExecutable: async () => { throw new Error('not found') },
  },
}

// 上一次运行删掉后留下的「只剩归档记账」的条目，启动清扫要把它摘掉。
archivedIds.push('session-stale-archive')

mod.apply(ctx, { closeToTray: true, closeStopsServer: true, sweepDelayMs: 0 })

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
  '/_desktop/session-delete', '/_desktop/session-info',
  '/_desktop/shell', '/_desktop/shell-info', '/_desktop/status',
  '/_desktop/trash', '/_desktop/trash-purge', '/_desktop/trash-restore'].sort())
check('effect 数量', effects, 13)

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

// ---- 会话删除 ----------------------------------------------------------------
makeStoredSession('session-alpha')
makeStoredSession('session-live')
makeStoredSession('session-beta')
liveSessions.add('session-live')

r = await call('/_desktop/session-info', 'POST', { sessionId: 'session-alpha' })
check('info 认出磁盘会话', { ok: r.json.ok, exists: r.json.exists, live: r.json.live, sizeBytes: r.json.sizeBytes }, {
  ok: true, exists: true, live: false, sizeBytes: 42,
})
check('info 带 workspace 归属', r.json.workspaceId, 'ws-1')
check('info 标出归档与置顶', { archived: r.json.archived, pinned: r.json.pinned }, { archived: true, pinned: true })

r = await call('/_desktop/session-info', 'POST', { sessionId: 'session-live' })
check('info 标出活会话', r.json.live, true)

r = await call('/_desktop/session-info', 'POST', { sessionId: '../escape' })
check('非法 id 被拒', r.status, 400)

r = await call('/_desktop/session-info', 'GET')
check('info 只收 POST', r.status, 405)

r = await call('/_desktop/session-info', 'POST', { sessionId: 'session-alpha' }, { host: '10.0.0.5:3999' })
check('info 非 loopback 被拒', r.status, 403)

// 未归档的会话：删除会先补一条归档记账 —— 归档态是「这一行不出现在常规列表」的开关，
// 少了它，内存里还没卸载的会话对象就会以「未分组」的身份重新露出来。
makeStoredSession('session-unarchived', null, false)
r = await call('/_desktop/session-delete', 'POST', { sessionId: 'session-unarchived' })
check('删除时补归档以隐藏该行', {
  ok: r.json.ok,
  archivedKept: r.json.archivedKept,
  stillArchived: archivedIds.includes('session-unarchived'),
}, { ok: true, archivedKept: ['session-unarchived'], stillArchived: true })
check('补的归档条目没有被清掉', r.json.cleared, [])

// 子会话入口必须被拒：父还在，删半边树只会留下点不开的父行。
makeStoredSession('session-parent')
makeStoredSession('session-child-a', 'session-parent')
makeStoredSession('session-child-b', 'session-parent')

r = await call('/_desktop/session-info', 'POST', { sessionId: 'session-parent' })
check('info 报出子会话数', r.json.childCount, 2)

r = await call('/_desktop/session-delete', 'POST', { sessionId: 'session-child-a' })
check('子会话入口被拒', { status: r.status, code: r.json.code, parent: r.json.parentSession }, {
  status: 409, code: 'session-child', parent: 'session-parent',
})

// 打开过的会话也能删：搬进回收站，回 stale 让 UI 提示重启。
r = await call('/_desktop/session-delete', 'POST', { sessionId: 'session-live' })
const liveBatch = r.json.batch
check('活会话移入回收站', { status: r.status, ok: r.json.ok, mode: r.json.mode, stale: r.json.stale }, {
  status: 200, ok: true, mode: 'trash', stale: true,
})
check('活会话目录已搬走', existsSync(join(sessionRoot, 'session-live')), false)
check('活会话的归档条目保留', r.json.archivedKept, ['session-live'])
check('活会话仍在归档集合里', archivedIds.includes('session-live'), true)
check('回收站里有它', existsSync(join(sandboxHome, '_trash', liveBatch, 'session-live')), true)
check('删前走过 stop 缝', settleEvents.includes('workspace/session-stop'), true)

r = await call('/_desktop/session-delete', 'POST', { sessionId: 'session-ghost' })
check('未知会话 404', { status: r.status, code: r.json.code }, { status: 404, code: 'session-unknown' })

// 级联删除：父 + 两个子一起进同一批次，子会话由深到浅。
r = await call('/_desktop/session-delete', 'POST', { sessionId: 'session-parent', cascade: true })
const cascadeBatch = r.json.batch
check('级联删除 ok', {
  ok: r.json.ok,
  moved: r.json.moved.length,
  children: [...r.json.children].sort(),
}, {
  ok: true, moved: 3, children: ['session-child-a', 'session-child-b'],
})
check('三棵树都搬走了', ['session-parent', 'session-child-a', 'session-child-b']
  .map((id) => existsSync(join(sessionRoot, id))), [false, false, false])
check('写下了 move-plan', existsSync(join(sandboxHome, '_trash', cascadeBatch, 'move-plan.json')), true)
check('move-plan 记下了标题', JSON.parse(readFileSync(join(sandboxHome, '_trash', cascadeBatch, 'move-plan.json'), 'utf8'))
  .entries.every((entry) => typeof entry.title === 'string' && entry.title !== ''), true)
check('级联也摘了记账', workspace.sessionIds.some((id) => id.startsWith('session-child')), false)

// 回收站列表能看到两个批次，并且带得出是哪个对话。
r = await call('/_desktop/trash')
check('回收站列表批次数', r.json.batches.length, 3)
check('回收站条目带标题', r.json.batches.every((batch) => batch.entries.every((entry) => typeof entry.title === 'string')), true)

// 恢复：按 plan 原样搬回，并挂回原工作区。
r = await call('/_desktop/trash-restore', 'POST', { batch: cascadeBatch })
check('恢复批次', { status: r.status, restored: r.json.restored.length, failed: r.json.failed.length }, {
  status: 200, restored: 3, failed: 0,
})
check('恢复后批次已收干净（不留第二条记录）', existsSync(join(sandboxHome, '_trash', cascadeBatch)), false)

// 旧版本恢复时没删批次，会留下「同一个对话两条记录」。恢复对这类条目要幂等。
const staleBatchName = '20260101-000000-000'
const staleBatch = join(sandboxHome, '_trash', staleBatchName)
mkdirSync(staleBatch, { recursive: true })
const staleId = 'session-already-restored'
const staleDir = join(sessionRoot, staleId)
mkdirSync(staleDir, { recursive: true })
writeFileSync(join(staleBatch, 'move-plan.json'), JSON.stringify({
  createdAt: new Date().toISOString(),
  entries: [{ sessionId: staleId, title: '旧批次', from: staleDir, to: join(staleBatch, staleId), workspaceId: null }],
}), 'utf8')
r = await call('/_desktop/trash-restore', 'POST', { batch: staleBatchName })
check('早已恢复过的旧批次按幂等收掉', {
  status: r.status, restored: r.json.restored.length, failed: r.json.failed.length,
}, { status: 200, restored: 1, failed: 0 })
check('旧批次目录也删掉了', existsSync(staleBatch), false)

// move-plan.json 是文本文件：指向 sessions/ 之外的条目一律拒绝。
const escapeBatchName = '20260101-000000-001'
const escapeBatch = join(sandboxHome, '_trash', escapeBatchName)
mkdirSync(escapeBatch, { recursive: true })
writeFileSync(join(escapeBatch, 'move-plan.json'), JSON.stringify({
  createdAt: new Date().toISOString(),
  entries: [{ sessionId: 'session-x', from: join(sandboxHome, 'outside', 'session-x'), to: join(escapeBatch, 'session-x') }],
}), 'utf8')
r = await call('/_desktop/trash-restore', 'POST', { batch: escapeBatchName })
check('越界 plan 被拒', { status: r.status, failed: r.json.failed.length }, { status: 207, failed: 1 })
check('越界批次保留', existsSync(escapeBatch), true)
check('三棵树都回来了', ['session-parent', 'session-child-a', 'session-child-b']
  .map((id) => existsSync(join(sessionRoot, id))), [true, true, true])
check('恢复后挂回工作区', workspace.sessionIds.includes('session-parent'), true)
check('恢复后摘掉归档条目', archivedIds.includes('session-parent'), false)

// 再删一次并永久清除那个批次。
r = await call('/_desktop/session-delete', 'POST', { sessionId: 'session-parent' })
const purgeBatch = r.json.batch
r = await call('/_desktop/trash-purge', 'POST', { batch: purgeBatch })
check('永久清除批次', { status: r.status, ok: r.json.ok }, { status: 200, ok: true })
check('批次目录已消失', existsSync(join(sandboxHome, '_trash', purgeBatch)), false)

// 非法批次名必须被拒（路径穿越）。
r = await call('/_desktop/trash-purge', 'POST', { batch: '../sessions' })
check('非法批次名被拒', r.status, 400)

// location 指向不被认识的位置时必须中止，不能递归删掉别的目录，也不能先动记账。
// 这条路径同时覆盖「删除被挡住」的分支：rm 之前的校验抛错 → 409 session-busy。
const foreignDir = join(sandboxHome, 'not-a-session-dir')
mkdirSync(foreignDir, { recursive: true })
stored.set('session-foreign', { dir: foreignDir, sizeBytes: 1 })
// detach 会替换 workspace.sessionIds 数组，所以这里直接往当前数组里放。
workspace.sessionIds.unshift('session-foreign')
r = await call('/_desktop/session-delete', 'POST', { sessionId: 'session-foreign' })
check('异常 location 拒绝删除', { status: r.status, code: r.json.code }, { status: 409, code: 'session-busy' })
check('异常 location 目录仍在', existsSync(foreignDir), true)
check('异常 location 记账未动', workspace.sessionIds.includes('session-foreign'), true)

// 永久清除之后只剩一条归档记账（用来把那一行藏住），再删一次就把它也摘掉。
r = await call('/_desktop/session-delete', 'POST', { sessionId: 'session-parent' })
check('顺手清掉残留归档条目', { ok: r.json.ok, cleared: r.json.cleared }, { ok: true, cleared: ['archived'] })

// 记账没有、磁盘也没有的会话再删一次，应该是 404 而不是静默成功。
r = await call('/_desktop/session-delete', 'POST', { sessionId: 'session-parent' })
check('重复删除 404', { status: r.status, code: r.json.code }, { status: 404, code: 'session-unknown' })

// 只剩归档记账、磁盘早已没有的条目仍然可以清理 —— 这正是「归档列表里的幽灵行」。
archivedIds.push('session-ghost-archive')
r = await call('/_desktop/session-info', 'POST', { sessionId: 'session-ghost-archive' })
check('幽灵条目 info', { exists: r.json.exists, archived: r.json.archived }, { exists: false, archived: true })
r = await call('/_desktop/session-delete', 'POST', { sessionId: 'session-ghost-archive' })
check('幽灵条目可清理', { ok: r.json.ok, cleared: r.json.cleared, removed: r.json.removed }, {
  ok: true, cleared: ['archived'], removed: [],
})
check('幽灵条目已离开归档集合', archivedIds.includes('session-ghost-archive'), false)

// 启动清扫负责收尾上一次运行删掉的会话留下的归档记账。
await new Promise((resolve) => setTimeout(resolve, 30))
check('启动清扫摘掉了悬挂归档条目', archivedIds.includes('session-stale-archive'), false)

const failed = results.filter((item) => !item.ok)
for (const item of results) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}  →  ${JSON.stringify(item.actual)}`)
}
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
