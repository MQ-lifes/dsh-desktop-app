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

    /**
     * 宿主的菜单项组件。用 `MenuItemButton` 渲染才能和「复制 Session ID」「归档会话」
     * 这些内置项共用同一套字号/行高/内边距/悬停样式，`danger` 还能直接拿到主题的红色。
     * 拿不到时退回裸 button，并尽量对齐字形尺寸。
     */
    const primitives = (() => {
      try {
        return require('@deepseek-ai/dsh-client-ui-primitives') ?? null
      } catch {
        return null
      }
    })()
    const MenuItemButton = primitives?.MenuItemButton ?? null
    const IconTrashOutlineRegular = primitives?.IconTrashOutlineRegular ?? null

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

      // 会话行「…」菜单里的删除项：归档只隐藏，删除把会话目录搬进回收站（可恢复）。
      'menu.delete': '删除会话…',
      'menu.deleting': '正在删除…',
      'menu.deleteConfirm': '把会话「{title}」移入回收站？\n\n它会从列表消失，对话记录搬到回收站目录，可以在「设置 → 桌面应用」里恢复或永久清除。',
      'menu.purge': '永久删除会话…',
      'menu.purgeConfirm': '永久删除会话「{title}」？\n\n文件直接从磁盘移除，不进回收站，无法恢复。只想让它从列表消失的话，用「删除会话…」。',
      'menu.purged': '已永久删除。',
      'menu.children': '这会连同 {count} 个子智能体会话一起处理。',
      'menu.deleted': '已移入回收站，可在「设置 → 桌面应用」里恢复。',
      'menu.deleteFailed': '删除失败',
      'menu.busy': '删除失败：搬不动会话目录（可能被别的程序占用）。什么都没删，稍后重试即可。',
      'menu.stale': '已删除。建议重开 dsh web，让当前进程彻底忘掉这个会话。',

      // 设置页里的回收站
      'trash.title': '回收站',
      'trash.hint': '删除的会话先落在这里，可以原样搬回；永久清除才真正删文件。',
      'trash.empty': '回收站是空的。',
      'trash.sessions': '个会话',
      'trash.more': '等 {count} 个',
      'trash.restore': '恢复',
      'trash.purge': '永久清除',
      'trash.purgeConfirm': '永久清除这个批次？文件会真的被删掉，无法恢复。',
      'trash.restored': '已恢复',
      'trash.purged': '已永久清除',
      'trash.failed': '回收站操作失败',
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

      'menu.delete': 'Delete conversation…',
      'menu.deleting': 'Deleting…',
      'menu.deleteConfirm': 'Move the conversation "{title}" to the trash?\n\nIt leaves the list, its records move to a trash folder, and you can restore or purge it from Settings → Desktop window.',
      'menu.purge': 'Delete conversation permanently…',
      'menu.purgeConfirm': 'Permanently delete the conversation "{title}"?\n\nFiles are removed from disk without going to the trash; this cannot be undone. Use "Delete conversation…" if you only want it out of the list.',
      'menu.purged': 'Permanently deleted.',
      'menu.children': 'This also handles {count} sub-agent conversation(s).',
      'menu.deleted': 'Moved to the trash. Restore it from Settings → Desktop window.',
      'menu.deleteFailed': 'Delete failed',
      'menu.busy': 'Delete failed: the conversation directory could not be moved (another program may hold it). Nothing was deleted; try again later.',
      'menu.stale': 'Deleted. Restart dsh web so this process forgets the conversation completely.',

      'trash.title': 'Trash',
      'trash.hint': 'Deleted conversations land here first and can be moved back; only a purge removes files for good.',
      'trash.empty': 'The trash is empty.',
      'trash.sessions': 'conversation(s)',
      'trash.more': '+{count} more',
      'trash.restore': 'Restore',
      'trash.purge': 'Purge',
      'trash.purgeConfirm': 'Purge this batch? The files are deleted for good and cannot be restored.',
      'trash.restored': 'Restored',
      'trash.purged': 'Purged',
      'trash.failed': 'Trash action failed',
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
      menuItem: {
        // 只在拿不到宿主 MenuItemButton 时用：字号/行高对齐宿主菜单项，红色取主题的错误色。
        appearance: 'none',
        border: 0,
        background: 'transparent',
        color: 'var(--dsw-alias-state-error-primary, #c92a2a)',
        fontFamily: 'inherit',
        fontSize: 13,
        fontWeight: 400,
        lineHeight: '20px',
        textAlign: 'left',
        width: '100%',
        padding: '6px 10px',
        borderRadius: 6,
        cursor: 'pointer',
      },
      sectionTitle: { fontSize: 13, fontWeight: 600, margin: '8px 0 0' },
      trashRow: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '7px 0',
        borderTop: '1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,0.18))',
      },
      trashLabel: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
      trashTitle: {
        fontSize: 13,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      trashWhen: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 11,
        opacity: 0.55,
      },
    }

    /** 批次名是 `YYYYMMDD-HHmmss-SSS`；列表里显示成 `MM-DD HH:mm` 更好认。 */
    function formatBatchTime(value) {
      if (typeof value !== 'string' || value === '') return ''
      const at = new Date(value)
      if (Number.isNaN(at.getTime())) return ''
      const pad = (part) => String(part).padStart(2, '0')
      return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
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
          if (!response.ok || data.ok === false) {
            const failure = new Error(data.error || `HTTP ${response.status}`)
            failure.code = data.code
            throw failure
          }
          return data
        }

        function DesktopSection() {
          const t = useSectionText(locale)
          const [status, setStatus] = useState(null)
          const [shell, setShell] = useState(null)
          const [trash, setTrash] = useState(null)
          const [error, setError] = useState('')
          const [busy, setBusy] = useState('')
          const [note, setNote] = useState('')

          const load = useCallback(async () => {
            try {
              const [nextStatus, nextShell] = await Promise.all([
                getJson('/_desktop/status'),
                getJson('/_desktop/shell-info'),
              ])
              // 回收站读不到不算错误：旧版本宿主没有这条路由时整页照常可用。
              const nextTrash = await getJson('/_desktop/trash').catch(() => null)
              setStatus(nextStatus)
              setShell(nextShell)
              setTrash(nextTrash)
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

          /** 回收站动作：恢复把批次原样搬回，清除才真删文件（先确认一次）。 */
          const trashAct = useCallback(async (action, batch) => {
            if (action === 'purge'
              && typeof window !== 'undefined'
              && typeof window.confirm === 'function'
              && !window.confirm(t('trash.purgeConfirm'))) {
              return
            }
            setBusy(`${action}:${batch}`)
            setNote('')
            try {
              if (action === 'restore') {
                const result = await postJson('/_desktop/trash-restore', { batch })
                setNote(`${t('trash.restored')}: ${Array.isArray(result.restored) ? result.restored.length : 0}`)
              } else {
                await postJson('/_desktop/trash-purge', { batch })
                setNote(t('trash.purged'))
              }
              await load()
            } catch (failure) {
              setNote(`${t('trash.failed')}: ${failure instanceof Error ? failure.message : String(failure)}`)
            } finally {
              setBusy('')
            }
          }, [load, t])

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

            h('h3', { style: styles.sectionTitle }, t('trash.title')),
            h('p', { style: styles.hint }, t('trash.hint')),
            trash && Array.isArray(trash.batches) && trash.batches.length > 0
              ? trash.batches.map((batch) => {
                const entries = Array.isArray(batch.entries) ? batch.entries : []
                const first = entries[0] ?? null
                // 标题是删除时写进 move-plan.json 的；旧批次没有这个字段就退回短 id。
                const shortId = first?.sessionId ? String(first.sessionId).replace(/^session-/, '').slice(0, 8) : ''
                const label = first?.title || shortId || batch.name
                const extra = entries.length > 1
                  ? ` ${t('trash.more').split('{count}').join(String(entries.length - 1))}`
                  : ''
                return h('div', { key: batch.name, style: styles.trashRow },
                  h('span', { style: styles.trashLabel },
                    h('span', { style: styles.trashTitle, title: label }, `${label}${extra}`),
                    h('span', { style: styles.trashWhen }, formatBatchTime(batch.createdAt) || batch.name)),
                  h('span', { style: styles.value },
                    h('button', {
                      type: 'button',
                      style: styles.smallButton,
                      disabled: busy !== '',
                      onClick: () => { void trashAct('restore', batch.name) },
                    }, busy === `restore:${batch.name}` ? `${t('trash.restore')}…` : t('trash.restore')),
                    h('button', {
                      type: 'button',
                      style: styles.smallButton,
                      disabled: busy !== '',
                      onClick: () => { void trashAct('purge', batch.name) },
                    }, busy === `purge:${batch.name}` ? `${t('trash.purge')}…` : t('trash.purge'))))
              })
              : h('p', { style: styles.hint }, t('trash.empty')),

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

        /** 菜单 hook 不可用时给一个恒定实现，保证 hook 调用顺序不随 props 变化。 */
        function useNoMenuState() {
          return [true, () => {}]
        }

        /**
         * 会话行「…」菜单里的删除项，排在 DSH 内置的「归档」动作之前。
         * 归档只把会话加进归档集合、磁盘记录还在；这两项把 id 交给 Host 的
         * /_desktop/session-delete：默认搬进回收站（可恢复），`permanent` 直接删磁盘不进回收站。
         */
        function makeSessionDeleteItem(permanent) {
          return function SessionDeleteItem(props) {
            const { sessionId, displayTitle, useMenuOpenState } = props
            const t = useSectionText(locale)
            const useMenu = typeof useMenuOpenState === 'function' ? useMenuOpenState : useNoMenuState
            const menuState = useMenu()
            const setMenuOpen = typeof menuState?.[1] === 'function' ? menuState[1] : () => {}
            const [busy, setBusy] = useState(false)

            const title = displayTitle && displayTitle !== '' ? displayTitle : sessionId

            const onDelete = useCallback(async () => {
              if (busy) return
              // 先问一句「会影响几个会话」：父对话会带着子智能体会话一起走，别让人事后才发现。
              let childCount = 0
              try {
                const info = await postJson('/_desktop/session-info', { sessionId })
                childCount = typeof info?.childCount === 'number' ? info.childCount : 0
              } catch {
                childCount = 0
              }

              const template = permanent ? 'menu.purgeConfirm' : 'menu.deleteConfirm'
              const question = t(template).split('{title}').join(title)
              const full = childCount > 0
                ? `${question}\n\n${t('menu.children').split('{count}').join(String(childCount))}`
                : question
              if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(full)) {
                return
              }

              setBusy(true)
              try {
                const result = await postJson('/_desktop/session-delete', { sessionId, cascade: true, permanent })
                setMenuOpen(false)
                // stale：文件与记账已经干净，但本进程内存里还留着这个会话对象。
                // 先切到新会话，别让视图停在一个已经不存在的会话上，再提示重启。
                if (result?.stale === true) {
                  try {
                    ctx.get('uiWorkspace')?.startSession?.()
                  } catch {
                    /* 切不过去也不影响删除结果 */
                  }
                  if (typeof window !== 'undefined' && typeof window.alert === 'function') {
                    window.alert(t('menu.stale'))
                  }
                } else if (typeof window !== 'undefined' && typeof window.alert === 'function') {
                  window.alert(permanent ? t('menu.purged') : t('menu.deleted'))
                }
              } catch (failure) {
                const message = failure?.code === 'session-busy'
                  ? t('menu.busy')
                  : `${t('menu.deleteFailed')}: ${failure instanceof Error ? failure.message : String(failure)}`
                if (typeof window !== 'undefined' && typeof window.alert === 'function') window.alert(message)
              } finally {
                setBusy(false)
              }
            }, [busy, sessionId, setMenuOpen, t, title])

            const label = busy
              ? t('menu.deleting')
              : (permanent ? t('menu.purge') : t('menu.delete'))

            // 首选宿主菜单项：字体、行高、间距、危险色都跟内置项同源。
            if (MenuItemButton !== null) {
              return h(MenuItemButton, {
                danger: true,
                disabled: busy,
                icon: IconTrashOutlineRegular !== null ? h(IconTrashOutlineRegular, { size: 16 }) : undefined,
                onSelect: () => { void onDelete() },
                children: label,
              })
            }

            return h('button', {
              type: 'button',
              role: 'menuitem',
              style: styles.menuItem,
              disabled: busy,
              title,
              onClick: () => { void onDelete() },
            }, label)
          }
        }

        const TrashSessionItem = makeSessionDeleteItem(false)
        const PurgeSessionItem = makeSessionDeleteItem(true)

        ctx.slots.inject('sidebar.workspaces.session.menu.item', () => {
          const trash = ctx.slots.register({
            name: 'sidebar.workspaces.session.menu.item',
            id: 'desktop-delete-session',
            order: 900,
          }, TrashSessionItem)
          const purge = ctx.slots.register({
            name: 'sidebar.workspaces.session.menu.item',
            id: 'desktop-purge-session',
            order: 901,
          }, PurgeSessionItem)
          return () => {
            trash()
            purge()
          }
        })
      },
    }
  },
})
