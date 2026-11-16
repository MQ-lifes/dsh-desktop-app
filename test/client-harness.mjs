/**
 * Client 半区的隔离验证：用一个最小的假 React / 假 ModuleLoader / 假 Cordis ctx
 * 执行 client.js 里的 factory，断言它注册了哪两个 slot、菜单项能不能渲染出来。
 *
 * 这里不引入 react-dom：只关心「重启后侧栏菜单里会不会出现删除项」，
 * 所以 h() 的结果按 {type, props, children} 检查即可。
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const repo = process.argv[2]

const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
  useCallback: (fn) => fn,
  useEffect: () => {},
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
}

const dictionaries = {}
const locale = {
  register: (ns, lang, dict) => { dictionaries[lang] = dict; return () => {} },
  bind: (ns) => (key) => dictionaries.zh?.[key] ?? key,
  getSnapshot: () => ({ id: 'zh' }),
  subscribe: () => () => {},
}

// 宿主菜单项组件：插件应当用它渲染，字体才会与内置项一致。
const MenuItemButton = function MenuItemButton() { return null }
const IconTrashOutlineRegular = function IconTrashOutlineRegular() { return null }

const registered = []
const injected = []
let startedSessions = 0
const ctx = {
  effect: (fn) => { fn(); return () => {} },
  get: (name) => {
    if (name === 'locale') return locale
    if (name === 'uiWorkspace') return { startSession: () => { startedSessions += 1 } }
    return undefined
  },
  slots: {
    inject: (slot, fn) => { injected.push(slot); fn() },
    register: (options, component) => { registered.push({ options, component }); return () => {} },
  },
}

// client.js 是浏览器模块：先给出 __ModuleLoader__，再加载它。
let factory
globalThis.window = {
  __ModuleLoader__: { load: ({ factory: captured }) => { factory = captured } },
  confirm: () => true,
  alert: () => {},
}

await import(pathToFileURL(join(repo, 'client.js')).href)
if (typeof factory !== 'function') {
  console.error('client.js 没有调用 window.__ModuleLoader__.load')
  process.exit(1)
}

const plugin = factory((name) => {
  if (name === 'react') return React
  if (name === '@deepseek-ai/dsh-client-ui-primitives') {
    return { MenuItemButton, IconTrashOutlineRegular }
  }
  throw new Error(`unexpected require: ${name}`)
})

plugin.apply(ctx)

const results = []
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ name, ok, actual, expected })
}

check('inject 只有 slots', plugin.inject, ['slots'])
check('注入过的 slot', injected.sort(), ['settings.section', 'sidebar.workspaces.session.menu.item'].sort())
check('注册了设置页 + 两个菜单项', registered.map((item) => item.options.name).sort(),
  ['settings.section', 'sidebar.workspaces.session.menu.item', 'sidebar.workspaces.session.menu.item'])

const menu = registered.find((item) => item.options.id === 'desktop-delete-session')
const purge = registered.find((item) => item.options.id === 'desktop-purge-session')
check('菜单项 id', menu.options.id, 'desktop-delete-session')
check('菜单项排在内置归档之前（order 正数）', menu.options.order > 0, true)
check('另有一个永久删除项', Boolean(purge) && purge.options.order > menu.options.order, true)

let closed = false
const element = menu.component({
  sessionId: 'session-abc',
  displayTitle: '重构会话删除',
  useMenuOpenState: () => [true, () => { closed = true }],
})

check('菜单项用宿主 MenuItemButton 渲染', element.type, MenuItemButton)
check('菜单项走危险色变体（保留红色）', element.props.danger, true)
check('菜单项带垃圾桶图标', element.props.icon?.type, IconTrashOutlineRegular)
check('菜单项文案', element.props.children, '删除会话…')

// 点一次：先查子会话数 → 确认对话框 → 走 POST → 成功后关菜单。
const calls = []
let fetchReply = { ok: true, status: 200, json: async () => ({ ok: true }) }
globalThis.fetch = async (path, init) => {
  calls.push({ path, body: init?.body })
  if (path === '/_desktop/session-info') {
    return { ok: true, status: 200, json: async () => ({ ok: true, childCount: 2 }) }
  }
  return fetchReply
}
let alertText = ''
globalThis.window.alert = (message) => { alertText = message }
let asked = ''
globalThis.window.confirm = (question) => { asked = question; return true }

await element.props.onSelect()
await new Promise((resolve) => setTimeout(resolve, 0))

check('确认文案含会话标题', asked.includes('重构会话删除'), true)
check('确认文案说明可恢复', asked.includes('回收站'), true)
check('确认文案报出子会话数', asked.includes('连同 2 个'), true)
check('先查子会话数再删', calls.map((call) => call.path), ['/_desktop/session-info', '/_desktop/session-delete'])
check('删除请求带级联', JSON.parse(calls[1].body), { sessionId: 'session-abc', cascade: true, permanent: false })
check('成功后关闭菜单', closed, true)

// 取消确认时不得发生删除（查询子会话数的那一次不受影响）。
const deletesBefore = calls.filter((call) => call.path === '/_desktop/session-delete').length
globalThis.window.confirm = () => false
await element.props.onSelect()
await new Promise((resolve) => setTimeout(resolve, 0))
check('取消确认不发删除请求', calls.filter((call) => call.path === '/_desktop/session-delete').length, deletesBefore)

// 删掉了但本进程内存里还留着它（stale）：切到新会话 + 提示重启。
startedSessions = 0
alertText = ''
fetchReply = { ok: true, status: 200, json: async () => ({ ok: true, stale: true }) }
globalThis.window.confirm = () => true
await element.props.onSelect()
await new Promise((resolve) => setTimeout(resolve, 0))
check('stale 时切到新会话', startedSessions, 1)
check('stale 时提示重启', alertText.includes('重开 dsh web'), true)

// 写句柄仍被占用（409 session-busy）：显示本地化指引，而不是 Host 的英文原话。
alertText = ''
fetchReply = { ok: false, status: 409, json: async () => ({ ok: false, code: 'session-busy', error: 'held by this process' }) }
await element.props.onSelect()
await new Promise((resolve) => setTimeout(resolve, 0))
check('busy 显示本地化指引', alertText.includes('占用'), true)
check('busy 时不再切会话', startedSessions, 1)

// 设置页仍然可渲染（不能被新代码带崩）。
const section = registered.find((item) => item.options.name === 'settings.section')
const sectionTree = section.component({})
check('设置页仍有标题', sectionTree.children[0].children[0], '桌面应用')

// 永久删除项：文案不同，请求体带 permanent: true。
startedSessions = 0
alertText = ''
fetchReply = { ok: true, status: 200, json: async () => ({ ok: true }) }
globalThis.window.confirm = () => true
const purgeElement = purge.component({
  sessionId: 'session-abc',
  displayTitle: '重构会话删除',
  useMenuOpenState: () => [true, () => {}],
})
check('永久删除项文案', purgeElement.props.children, '永久删除会话…')
await purgeElement.props.onSelect()
await new Promise((resolve) => setTimeout(resolve, 0))
check('永久删除请求带 permanent', JSON.parse(calls[calls.length - 1].body), {
  sessionId: 'session-abc', cascade: true, permanent: true,
})
check('永久删除后提示', alertText.includes('永久删除'), true)

const failed = results.filter((item) => !item.ok)
for (const item of results) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}  →  ${JSON.stringify(item.actual)}`)
}
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
