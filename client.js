/**
 * Client half of @local/dsh-desktop-app.
 *
 * One page under Settings → 桌面应用: live bridge status, an "open app window" action,
 * and the two Windows-integration switches (autostart, desktop shortcut) whose state
 * comes from the Host half. All text goes through the Client locale service; the
 * dictionaries in locale/*.json serve Plugin Manager metadata.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-desktop-app',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState, useSyncExternalStore } = React

    const NS = 'desktop-app'

    const ZH = {
      'section.title': '桌面应用',
      'section.subtitle': '让 DeepSeek Harness 以自己的应用窗口运行，而不是浏览器标签页。',
      'section.status': '当前状态',
      'section.running': '应用窗口已打开',
      'section.stopped': '未打开应用窗口',
      'section.address': '服务地址',
      'section.closeWindow': '关闭窗口时',
      'section.closeTray': '收进托盘（服务继续）',
      'section.closeExit': '直接退出窗口',
      'section.onQuit': '退出时',
      'section.quitStop': '停止本地服务',
      'section.quitKeep': '保留服务在后台',
      'section.toggle': '切换',
      'section.shell': '桌面程序',
      'section.missing': '未安装',
      'section.autostart': '随 Windows 启动',
      'section.on': '已开启',
      'section.off': '已关闭',
      'section.shortcut': '桌面快捷方式',
      'section.exists': '已创建',
      'section.absent': '未创建',
      'section.createShortcut': '创建快捷方式',
      'section.open': '用浏览器窗口打开（备用）',
      'section.useShellInstead': '桌面程序已就绪：双击桌面图标或托盘图标即可，不需要在这里打开。',
      'section.opening': '正在打开…',
      'section.opened': '已请求打开应用窗口',
      'section.failed': '打开应用窗口失败',
      'section.actionFailed': '操作失败',
      'section.unavailable': '状态不可用',
    }

    const EN = {
      'section.title': 'Desktop window',
      'section.subtitle': 'Run DeepSeek Harness as its own application window instead of a browser tab.',
      'section.status': 'Status',
      'section.running': 'App window open',
      'section.stopped': 'No app window',
      'section.address': 'Service address',
      'section.closeWindow': 'When the window closes',
      'section.closeTray': 'Minimize to tray (server keeps running)',
      'section.closeExit': 'Close the window',
      'section.onQuit': 'When quitting',
      'section.quitStop': 'Stop the local server',
      'section.quitKeep': 'Keep the server running',
      'section.toggle': 'Switch',
      'section.shell': 'Desktop program',
      'section.missing': 'Not installed',
      'section.autostart': 'Start with Windows',
      'section.on': 'On',
      'section.off': 'Off',
      'section.shortcut': 'Desktop shortcut',
      'section.exists': 'Present',
      'section.absent': 'Missing',
      'section.createShortcut': 'Create shortcut',
      'section.open': 'Open in a browser window (fallback)',
      'section.useShellInstead': 'The desktop program is installed — use its desktop or tray icon instead.',
      'section.opening': 'Opening…',
      'section.opened': 'App window requested',
      'section.failed': 'Could not open the app window',
      'section.actionFailed': 'Action failed',
      'section.unavailable': 'Status unavailable',
    }

    const styles = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 16, padding: '2px 0', fontSize: 13, lineHeight: 1.6 },
      title: { fontSize: 15, fontWeight: 600, margin: 0 },
      subtitle: { margin: 0, opacity: 0.72 },
      row: {
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 24,
        padding: '11px 0',
        borderTop: '1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,0.18))',
      },
      rowLabel: { opacity: 0.85, flex: '0 0 auto' },
      mono: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        wordBreak: 'break-all',
        opacity: 0.9,
        textAlign: 'right',
      },
      value: { display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' },
      badge: { display: 'inline-flex', alignItems: 'center', gap: 7 },
      dotOn: { width: 8, height: 8, borderRadius: 4, background: 'var(--dsw-alias-accent-primary, #2b8a3e)' },
      dotOff: { width: 8, height: 8, borderRadius: 4, background: 'var(--dsw-alias-border-strong, rgba(128,128,128,0.5))' },
      actions: { display: 'flex', gap: 8, flexWrap: 'wrap', paddingTop: 4 },
      button: {
        appearance: 'none',
        border: '1px solid var(--dsw-alias-border-strong, rgba(128,128,128,0.35))',
        background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.08))',
        color: 'inherit',
        borderRadius: 6,
        padding: '6px 12px',
        fontSize: 13,
        cursor: 'pointer',
      },
      smallButton: {
        appearance: 'none',
        border: '1px solid var(--dsw-alias-border-strong, rgba(128,128,128,0.35))',
        background: 'transparent',
        color: 'inherit',
        borderRadius: 6,
        padding: '3px 10px',
        fontSize: 12,
        cursor: 'pointer',
      },
      hint: { margin: 0, opacity: 0.6, fontSize: 12 },
      error: { color: 'var(--dsw-alias-state-error, #c92a2a)', margin: 0 },
    }

    function useSectionText(locale) {
      const subscribe = useCallback((notify) => (locale ? locale.subscribe(notify) : () => {}), [locale])
      const getSnapshot = useCallback(() => (locale ? locale.getSnapshot() : null), [locale])
      useSyncExternalStore(subscribe, getSnapshot, () => null)

      return useCallback((key) => {
        if (!locale) return ZH[key] ?? key
        try {
          return locale.bind(NS)(key)
        } catch {
          return ZH[key] ?? key
        }
      }, [locale])
    }

    function Row({ label, children }) {
      return h('div', { style: styles.row },
        h('span', { style: styles.rowLabel }, label),
        h('span', { style: styles.value }, children))
    }

    function Dot({ on }) {
      return h('span', { style: styles.badge }, h('span', { style: on ? styles.dotOn : styles.dotOff }))
    }

    return {
      inject: ['slots'],

      apply(ctx) {
        const locale = ctx.get('locale')

        ctx.effect(() => {
          if (!locale || typeof locale.register !== 'function') return () => {}
          const zh = locale.register(NS, 'zh', ZH)
          const en = locale.register(NS, 'en', EN)
          return () => { zh(); en() }
        })

        async function getJson(path) {
          const response = await fetch(path, { headers: { accept: 'application/json' }, cache: 'no-store' })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          return response.json()
        }

        async function postJson(path, body) {
          const response = await fetch(path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body ?? {}),
          })
          const data = await response.json().catch(() => ({}))
          if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`)
          return data
        }

        function DesktopSection() {
          const t = useSectionText(locale)
          const [status, setStatus] = useState(null)
          const [shell, setShell] = useState(null)
          const [error, setError] = useState('')
          const [busy, setBusy] = useState('')
          const [note, setNote] = useState('')

          const load = useCallback(async () => {
            try {
              const [nextStatus, nextShell] = await Promise.all([
                getJson('/_desktop/status'),
                getJson('/_desktop/shell-info'),
              ])
              setStatus(nextStatus)
              setShell(nextShell)
              setError('')
            } catch (failure) {
              setError(failure instanceof Error ? failure.message : String(failure))
            }
          }, [])

          useEffect(() => {
            void load()
            const timer = setInterval(() => { void load() }, 5000)
            return () => clearInterval(timer)
          }, [load])

          const open = useCallback(async () => {
            // 壳已装好时这条通道没意义：提示用户用桌面/托盘图标，别开一个不受管的 Edge 窗口。
            if (shell?.shellExists) {
              setNote(t('section.useShellInstead'))
              return
            }
            setBusy('open')
            setNote(t('section.opening'))
            try {
              await postJson('/_desktop/launch')
              setNote(t('section.opened'))
              await load()
            } catch (failure) {
              setNote(`${t('section.failed')}: ${failure instanceof Error ? failure.message : String(failure)}`)
            } finally {
              setBusy('')
            }
          }, [load, shell, t])

          const act = useCallback(async (action) => {
            setBusy(action)
            setNote('')
            try {
              await postJson('/_desktop/shell', { action })
              await load()
            } catch (failure) {
              setNote(`${t('section.actionFailed')}: ${failure instanceof Error ? failure.message : String(failure)}`)
            } finally {
              setBusy('')
            }
          }, [load, t])

          const closeToTray = status?.closeToTray !== false
          const stopOnQuit = status?.closeStopsServer !== false

          const patchPrefs = useCallback(async (patch) => {
            setBusy('prefs')
            setNote('')
            try {
              await postJson('/_desktop/prefs', patch)
              await load()
            } catch (failure) {
              setNote(`${t('section.actionFailed')}: ${failure instanceof Error ? failure.message : String(failure)}`)
            } finally {
              setBusy('')
            }
          }, [load, t])

          const toggleTray = useCallback(() => patchPrefs({ closeToTray: !closeToTray }), [closeToTray, patchPrefs])
          const toggleQuit = useCallback(() => patchPrefs({ stopServerOnClose: !stopOnQuit }), [stopOnQuit, patchPrefs])

          const running = status?.windowOpen === true
          const shellPath = shell?.shellPath ?? ''
          const shellName = shellPath.split('\\').pop() || shellPath

          return h('div', { style: styles.wrap },
            h('h2', { style: styles.title }, t('section.title')),
            h('p', { style: styles.subtitle }, t('section.subtitle')),

            h(Row, { label: t('section.status') },
              h(Dot, { on: running }),
              running ? t('section.running') : t('section.stopped')),

            h(Row, { label: t('section.address') },
              h('span', { style: styles.mono },
                status?.origin ?? (error ? `${t('section.unavailable')} (${error})` : '—'))),

            h(Row, { label: t('section.closeWindow') },
              h(Dot, { on: closeToTray }),
              h('span', null, closeToTray ? t('section.closeTray') : t('section.closeExit')),
              h('button', {
                type: 'button',
                style: styles.smallButton,
                disabled: busy !== '',
                onClick: () => { void toggleTray() },
              }, t('section.toggle'))),

            // 与上一行同源：两个开关都写在同一个偏好文件里，壳每次关窗都现读。
            h(Row, { label: t('section.onQuit') },
              h(Dot, { on: stopOnQuit }),
              h('span', null, stopOnQuit ? t('section.quitStop') : t('section.quitKeep')),
              h('button', {
                type: 'button',
                style: styles.smallButton,
                disabled: busy !== '',
                onClick: () => { void toggleQuit() },
              }, t('section.toggle'))),

            h(Row, { label: t('section.shell') },
              h('span', { style: styles.mono, title: shellPath },
                shell?.shellExists ? shellName : `${shellName || '—'} (${t('section.missing')})`)),

            h(Row, { label: t('section.autostart') },
              h(Dot, { on: shell?.autostart === true }),
              h('span', null, shell?.autostart ? t('section.on') : t('section.off')),
              h('button', {
                type: 'button',
                style: styles.smallButton,
                disabled: busy !== '' || !shell?.shellExists,
                onClick: () => { void act(shell?.autostart ? 'autostart-off' : 'autostart-on') },
              }, shell?.autostart ? t('section.off') : t('section.on'))),

            h(Row, { label: t('section.shortcut') },
              h(Dot, { on: shell?.shortcutExists === true }),
              h('span', null, shell?.shortcutExists ? t('section.exists') : t('section.absent')),
              h('button', {
                type: 'button',
                style: styles.smallButton,
                disabled: busy !== '' || !shell?.shellExists,
                onClick: () => { void act('shortcut-create') },
              }, busy === 'shortcut-create' ? t('section.createShortcut') + '…' : t('section.createShortcut'))),

            h('div', { style: styles.actions },
              h('button', {
                type: 'button',
                style: styles.button,
                disabled: busy !== '',
                onClick: () => { void open() },
              }, busy === 'open' ? t('section.opening') : t('section.open'))),

            note ? h('p', { style: styles.hint }, note) : null,
            error ? h('p', { style: styles.error }, error) : null,
          )
        }

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'desktop-app',
          order: 30,
          label: () => {
            if (!locale) return '桌面应用'
            try {
              return locale.bind(NS)('section.title')
            } catch {
              return '桌面应用'
            }
          },
        }, DesktopSection))
      },
    }
  },
})
