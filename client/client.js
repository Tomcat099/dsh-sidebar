window.__ModuleLoader__.load({
  id: 'dsh-sidebar',
  factory: (require) => {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const h = React.createElement

    const RECENT_SEGMENTS = ['dsh-sidebar/recent', 'just-chat/sessions']
    const RECENT_LIMIT = 5

    function isJustChatPath(path) {
      const normalized = String(path).replaceAll('\\', '/')
      return RECENT_SEGMENTS.some(segment => normalized.includes(segment))
    }

    function currentProjectId(items, currentSessionId) {
      if (!currentSessionId) return undefined
      return items.find(item => !isJustChatPath(item.path) && item.sessionIds.includes(currentSessionId))?.workspaceId
    }

    function recentSessions(workspaces, sessions, archived) {
      const rows = []
      const seen = new Set()
      for (const workspace of workspaces) {
        if (!isJustChatPath(workspace.path)) continue
        for (const id of workspace.sessionIds) {
          if (seen.has(id) || archived.has(id)) continue
          const session = sessions[id]
          if (session === undefined) continue
          seen.add(id)
          rows.push(session)
        }
      }
      rows.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      return rows
    }

    function relativeTime(updatedAt, now) {
      const minutes = Math.floor(Math.max(0, now - updatedAt) / 60000)
      if (minutes < 1) return '刚刚'
      if (minutes < 60) return `${String(minutes)}分钟`
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return `${String(hours)}小时`
      return `${String(Math.floor(hours / 24))}天`
    }

    const PAGES = [
      {
        id: 'dsh-sidebar.toolbox',
        label: '工具箱',
        icon: 'box',
      },
      {
        id: 'dsh-sidebar.knowledge',
        label: '知识库',
        icon: 'book',
        lead: '查看、上传或删除知识库。',
        empty: '还没有知识库。',
        fields: ['名称', '来源'],
      },
    ]

    function Icon({ name }) {
      const common = {
        width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }
      if (name === 'pen') {
        return h('svg', common,
          h('path', { d: 'M9.2 2.8 13.2 6.8 5.4 14.6H1.4V10.6L9.2 2.8Z' }),
          h('path', { d: 'M8 4 12 8' }))
      }
      if (name === 'chat') {
        return h('svg', common,
          h('path', { d: 'M3 3.5h10a1 1 0 0 1 1 1V10a1 1 0 0 1-1 1H6.2L3 13.2V4.5a1 1 0 0 1 0-1Z' }))
      }
      if (name === 'layers') {
        return h('svg', common,
          h('path', { d: 'M8 2.2 14 5.2 8 8.2 2 5.2 8 2.2Z' }),
          h('path', { d: 'M2 8 8 11 14 8' }),
          h('path', { d: 'M2 10.8 8 13.8 14 10.8' }))
      }
      if (name === 'book') {
        return h('svg', common,
          h('path', { d: 'M3 2.8h4.2A1.8 1.8 0 0 1 9 4.6V13a1.4 1.4 0 0 0-1.4-1.4H3V2.8Z' }),
          h('path', { d: 'M13 2.8H8.8A1.8 1.8 0 0 0 7 4.6V13a1.4 1.4 0 0 1 1.4-1.4H13V2.8Z' }))
      }
      if (name === 'link') {
        return h('svg', common,
          h('path', { d: 'M6.4 9.6 9.6 6.4' }),
          h('path', { d: 'M7.2 4.2 8.4 3a2.2 2.2 0 0 1 3.1 3.1L10.3 7.3' }),
          h('path', { d: 'M8.8 11.8 7.6 13a2.2 2.2 0 0 1-3.1-3.1l1.2-1.2' }))
      }
      if (name === 'sliders') {
        return h('svg', common,
          h('path', { d: 'M2.5 4.5h11' }),
          h('path', { d: 'M2.5 11.5h11' }),
          h('circle', { cx: 6, cy: 4.5, r: 1.4, fill: 'var(--dsw-alias-bg-primary, #fff)' }),
          h('circle', { cx: 10.5, cy: 11.5, r: 1.4, fill: 'var(--dsw-alias-bg-primary, #fff)' }))
      }
      if (name === 'box') {
        return h('svg', common,
          h('path', { d: 'M2.5 5.2 8 2.6l5.5 2.6v5.6L8 13.4 2.5 10.8V5.2Z' }),
          h('path', { d: 'M2.5 5.2 8 8 13.5 5.2' }),
          h('path', { d: 'M8 8v5.4' }))
      }
      return h('svg', common, h('path', { d: 'M3 8h10M10 5l3 3-3 3' }))
    }

    const CSS = `
.dsb-shell{box-sizing:border-box;height:100%;min-height:0;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.4}
.dsb-brand{display:flex;align-items:center;gap:8px;min-height:44px;padding:8px 12px 4px}
.dsb-brand-slots{display:flex;align-items:center;gap:8px;min-width:0;flex:1}
.dsb-brand-fallback{font-weight:650;letter-spacing:-.02em;font-size:15px}
.dsb-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dsb-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsb-menu{display:flex;flex-direction:column;gap:2px;min-width:0;max-width:100%;padding:4px 8px 8px}
.dsb-row{display:flex;align-items:center;gap:8px;width:100%;min-width:0;min-height:36px;padding:0 8px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;white-space:nowrap;cursor:pointer}
.dsb-row:hover,.dsb-row[data-active=true]{background:var(--dsw-alias-interactive-bg-hover)}
.dsb-row svg{flex:none;color:var(--dsw-alias-label-secondary)}
.dsb-scroll{flex:1;min-height:0;overflow:auto;padding:0 4px 8px}
.dsb-section{margin:8px 8px 4px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.4}
.dsb-recent{margin-top:8px;padding-top:4px;min-width:0;max-width:100%}
.dsb-recent-row{box-sizing:border-box;display:flex;align-items:center;gap:4px;width:100%;max-width:100%;min-height:32px;padding:0 8px;border-radius:8px}
.dsb-recent-row:hover,.dsb-recent-row[data-active=true]{background:var(--dsw-alias-interactive-bg-hover)}
.dsb-recent-open{box-sizing:border-box;display:flex;align-items:center;gap:8px;flex:1;min-width:0;max-width:100%;min-height:32px;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dsb-recent-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsb-recent-time{flex:none;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.4}
.dsb-recent-more{display:none;flex:none;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dsb-recent-more:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsb-recent-row[data-actions=true]:hover .dsb-recent-more,.dsb-recent-row[data-menu=true] .dsb-recent-more{display:inline-flex}
.dsb-recent-row[data-actions=true]:hover .dsb-recent-time,.dsb-recent-row[data-menu=true] .dsb-recent-time{display:none}
.dsb-recent-menu{position:fixed;z-index:30;box-sizing:border-box;min-width:148px;padding:4px;border-radius:10px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);box-shadow:0 8px 24px rgba(0,0,0,.16);display:flex;flex-direction:column}
.dsb-recent-menu button{min-height:32px;padding:0 10px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:13px;text-align:left;cursor:pointer}
.dsb-recent-menu button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsb-recent-menu button[data-danger=true]{color:var(--dsw-alias-state-error-primary)}
.dsb-more{margin:2px 8px 0;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:13px;cursor:pointer}
.dsb-empty{margin:4px 8px 8px;color:var(--dsw-alias-label-tertiary);font-size:13px}
.dsb-error{margin:0 12px 8px;color:var(--dsw-alias-label-error);font-size:12px;line-height:1.5}
.dsb-foot{flex:none;padding-top:4px}
[data-dsb-hide],[data-dsb-host-hide]{display:none !important}
#dsb-menu-mount,#dsb-recent-mount{min-width:0;width:100%;max-width:100%;overflow:hidden}
.dsb-modal-back{position:fixed;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.28);padding:24px}
.dsb-modal{box-sizing:border-box;width:min(360px,100%);max-height:min(480px,100%);overflow:auto;padding:16px;border-radius:16px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);box-shadow:0 12px 40px rgba(0,0,0,.16)}
.dsb-modal h2{margin:0 0 12px;font-size:15px}
.dsb-modal input,.dsb-modal select{box-sizing:border-box;width:100%;height:36px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:inherit;padding:0 10px;font:inherit}
.dsb-picker{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.dsb-picker button,.dsb-modal-actions button{font:inherit}
.dsb-picker button{display:block;width:100%;min-height:36px;padding:0 8px;border:0;border-radius:8px;background:transparent;color:inherit;text-align:left;cursor:pointer}
.dsb-picker button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsb-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}
.dsb-modal-actions button{height:32px;padding:0 12px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:inherit;cursor:pointer}
.dsb-modal-actions button:first-child{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border-color:transparent}
.dsb-page{box-sizing:border-box;flex:1;min-height:0;max-width:720px;margin:0 auto;padding:32px 24px;overflow:auto;color:var(--dsw-alias-label-primary)}
.dsb-page h1{margin:0 0 8px;font-size:22px;line-height:1.3}
.dsb-page h2{margin:0 0 8px;font-size:13px;font-weight:500;color:var(--dsw-alias-label-tertiary)}
.dsb-lead{margin:0 0 20px;color:var(--dsw-alias-label-secondary);font-size:14px}
.dsb-card{margin:0 0 16px;padding:16px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:12px;background:var(--dsw-alias-bg-layer-2)}
.dsb-card p{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px}
.dsb-field{display:flex;flex-direction:column;gap:6px;margin-top:12px;font-size:13px}
.dsb-field input,.dsb-field select{height:34px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:inherit;padding:0 10px;font:inherit}
.dsb-back{margin-top:4px;border:0;background:transparent;padding:0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer}
.dsb-mcp{box-sizing:border-box;width:100%;max-width:none;margin:0;padding:20px 32px 40px;overflow:auto}
.dsb-back-top{display:inline-flex;align-items:center;margin:0 0 20px;padding:2px 0}
.dsb-back-top:hover{color:var(--dsw-alias-label-primary)}
.tbBar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:0 0 16px}
.tbTabs{display:flex;align-items:center;gap:4px;min-width:0}
.tbTab{height:32px;padding:0 14px;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:32px;cursor:pointer;white-space:nowrap}
.tbTab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.tbTab[data-active=true]{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.tbTab[data-active=true]:hover{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.tbPane[hidden]{display:none}
.tbGrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
.tbCard{display:flex;align-items:flex-start;gap:12px;min-width:0;padding:14px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.tbMark{flex:none;display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600}
.tbMarkRound{border-radius:50%}
.tbCardMain{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}
.tbCardName{font-size:14px;font-weight:600;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tbCardDesc{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.tbList{display:flex;flex-direction:column;gap:8px}
.tbRow{display:flex;align-items:center;gap:12px;min-width:0;padding:12px 14px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.tbRowMain{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.tbRowName{font-size:14px;font-weight:600;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tbRowMeta{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.tbRowMeta[data-on=true]{color:var(--dsw-alias-state-success-primary)}
.tbEmpty{margin:8px 0 0;color:var(--dsw-alias-label-tertiary);font-size:13px}
.tbScope{display:inline-flex;align-self:flex-start;width:fit-content;padding:0 6px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px}
.tbShadow{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.tbToast{position:fixed;z-index:60;left:50%;bottom:24px;transform:translateX(-50%);max-width:min(480px,calc(100% - 32px));padding:10px 14px;border-radius:10px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-state-error-primary);box-shadow:0 8px 24px rgba(0,0,0,.16);font-size:13px;line-height:20px}
.tbChoice{display:flex;flex-direction:column;gap:6px;margin-top:12px}
.tbChoice button{min-height:32px;padding:0 8px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:13px;text-align:left;cursor:pointer}
.tbChoice button:hover,.tbChoice button[data-active=true]{background:var(--dsw-alias-interactive-bg-hover)}
.tbRadio{display:flex;gap:12px;margin-top:12px;font-size:13px}
.tbGroup{margin-top:18px}
.tbGroup:first-child{margin-top:0}
.tbGroupTitle{font-size:12px;font-weight:600;color:var(--dsw-alias-label-tertiary);letter-spacing:.02em;margin:0 0 8px}
.tbGroupEmpty{margin:4px 0 0;color:var(--dsw-alias-label-tertiary);font-size:13px}
.tbUpload{width:min(420px,100%);padding:20px 20px 16px;border-radius:18px;box-shadow:0 24px 64px rgba(0,0,0,.18)}
.tbUploadHead{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin:0 0 16px}
.tbUploadHead h2{margin:0;font-size:16px;line-height:22px;font-weight:600;letter-spacing:-.01em}
.tbUploadClose{flex:none;width:28px;height:28px;margin:-4px -4px 0 0;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:18px;line-height:1;cursor:pointer}
.tbUploadClose:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.tbUpload .tbScopeSeg{display:flex;gap:2px;margin:0 0 14px;padding:3px;border-radius:12px;background:var(--dsw-alias-interactive-bg-hover)}
.tbUpload .tbScopeSeg button{flex:1;min-height:32px;padding:0 10px;border:0;border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;font-weight:500;cursor:pointer;transition:background .15s ease,color .15s ease,box-shadow .15s ease}
.tbUpload .tbScopeSeg button:hover{color:var(--dsw-alias-label-primary)}
.tbUpload .tbScopeSeg button[data-active=true]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,.06)}
.tbDrop{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;min-height:196px;padding:28px 20px 22px;border:1px dashed color-mix(in srgb,var(--dsw-alias-label-tertiary) 45%,var(--dsw-alias-border-l2));border-radius:16px;background:var(--dsw-alias-bg-layer-1);cursor:pointer;text-align:center;transition:border-color .15s ease,background .15s ease}
.tbDrop:hover,.tbDrop[data-drag=true]{border-color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.tbDrop[data-busy=true]{cursor:progress;opacity:.72}
.tbDropIcon{width:44px;height:44px;margin-bottom:4px;border-radius:14px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);display:grid;place-items:center;box-shadow:0 1px 2px rgba(0,0,0,.04)}
.tbDropTitle{margin:0;font-size:14px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary)}
.tbDropSub{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.tbDropActions{display:flex;gap:8px;margin-top:10px}
.tbDropActions button{height:30px;padding:0 12px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;transition:background .15s ease,transform .15s ease}
.tbDropActions button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.tbDropActions button:active{transform:scale(.98)}
.tbHint{margin:12px 2px 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.tbScopeBar{display:inline-flex;gap:2px;margin:0 0 14px;padding:3px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover)}
.tbScopeBtn{height:28px;padding:0 16px;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:28px;cursor:pointer}
.tbScopeBtn[data-active=true]{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.tbProjTabs{display:flex;gap:6px;margin:0 0 14px;flex-wrap:wrap}
.tbProjTab{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);padding:4px 12px;border-radius:999px;font-size:12.5px;cursor:pointer;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tbProjTab[data-active=true]{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border-color:var(--dsw-alias-button-primary-fill)}
.mcpPageTitle{margin:0;font-size:22px;line-height:1.3;font-weight:600}
.dsb-rail{display:flex;flex-direction:column;align-items:center;gap:4px;padding:8px 0}
.dsb-rail .dsb-row{width:36px;height:36px;padding:0;justify-content:center}

.mcpSection{display:flex;flex-direction:column;gap:16px;width:100%}
.mcpPageDesc{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.mcpCard{display:flex;flex-direction:column;gap:14px;font-size:13px;line-height:20px}
.mcpHead{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-bottom:2px}
.mcpHeadText{display:flex;flex-direction:column;gap:2px;min-width:0}
.mcpTitle{margin:0;font-size:16px;font-weight:600;line-height:24px;color:var(--dsw-alias-label-primary)}
.mcpHint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.mcpList{display:flex;flex-direction:column;gap:8px}
.mcpListMeta{font-size:12px;font-weight:500;color:var(--dsw-alias-label-tertiary);padding:0 2px}
.mcpRow{border:0.5px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;transition:border-color .15s ease,box-shadow .15s ease}

.mcpRowFailed{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,var(--dsw-alias-border-l2))}
.mcpBody{display:flex;flex-direction:column;gap:8px;padding:10px 12px 12px;border-top:0.5px solid var(--dsw-alias-border-l2)}
.mcpToolName{font-family:var(--ds-font-family-code);font-size:12.5px;color:var(--dsw-alias-label-primary)}
.mcpToolRow{display:flex;flex-direction:column;gap:2px;width:100%;padding:8px 10px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;text-align:left;cursor:pointer}
.mcpToolRow:hover{border-color:var(--dsw-alias-border-l3)}
.mcpToolDesc{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.mcpRowHead{display:flex;align-items:center;gap:12px;padding:12px 14px;background:transparent}
.mcpRowOpen{border-color:var(--dsw-alias-border-l3)}
.mcpRowToggle{flex:1;display:flex;align-items:center;gap:10px;min-width:0;padding:2px 4px;margin:-2px -4px;border:0;border-radius:8px;background:transparent;color:inherit;cursor:pointer;text-align:left;font:inherit;transition:background .12s ease}
.mcpRowToggle:hover{background:var(--dsw-alias-interactive-bg-hover)}
.mcpChevron{width:7px;height:7px;border-right:1.5px solid var(--dsw-alias-label-tertiary);border-bottom:1.5px solid var(--dsw-alias-label-tertiary);transform:rotate(45deg);transition:transform .15s ease;flex:none;margin:-3px 2px 0 4px}
.mcpChevronOpen{transform:rotate(-135deg);margin-top:3px}
.mcpRowActions{display:flex;align-items:center;gap:2px;flex:none}
.mcpBodyNote{display:flex;flex-direction:column;gap:3px;padding:8px 10px;border-radius:9px;background:var(--dsw-alias-interactive-bg-hover)}
.mcpBodyNote p{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:17px}
.mcpToolList{display:flex;flex-direction:column;gap:6px;max-height:280px;overflow-y:auto}
.mcpMarkWrap{position:relative;flex:none;display:flex}
.mcpMarkWrap .mcpDot{position:absolute;right:-1px;bottom:-1px;width:8px;height:8px;box-shadow:0 0 0 2px var(--dsw-alias-bg-layer-1)}
.mcpIconBtn{flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.mcpIconBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}

.mcpRowMeta{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}
.mcpName{font-weight:600;font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mcpEndpoint{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mcpConn{flex:none;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.mcpConn[data-state=healthy]{color:var(--dsw-alias-state-success-primary)}
.mcpConn[data-state=reauth],.mcpConn[data-state=unavailable]{color:var(--dsw-alias-state-error-primary)}
.mcpConn[data-state=degraded],.mcpConn[data-state=recovering],.mcpConn[data-state=disabled]{color:var(--dsw-alias-state-warn-primary)}
.mcpDot{width:7px;height:7px;border-radius:50%;flex-shrink:0;background:var(--dsw-alias-label-caption)}
.mcpDotOk{background:var(--dsw-alias-state-success-primary)}
.mcpDotBad{background:var(--dsw-alias-state-error-primary)}
.mcpDotOff{background:var(--dsw-alias-state-warn-primary)}

.mcpDel{flex-shrink:0;width:28px;height:28px;padding:0;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:18px;line-height:1;cursor:pointer;transition:background .12s ease,color .12s ease}
.mcpDel:hover{background:var(--dsw-alias-state-error-secondary);color:var(--dsw-alias-state-error-primary)}
.mcpError{margin:0 12px 4px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-state-error-secondary);color:var(--dsw-alias-label-primary-foreground);font:11px/16px var(--ds-font-family-code);white-space:pre-wrap;overflow-wrap:anywhere;max-height:160px;overflow:auto}
.mcpPanel{border:0.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-base);overflow:hidden}
.mcpPanelHead{padding:8px 12px;border-bottom:0.5px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-interactive-bg-hover) 50%,transparent)}
.mcpPanelTitle{flex:1;font-size:12px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-secondary)}
.mcpPanelBody{display:flex;flex-direction:column;gap:10px;padding:10px 12px 12px}
.mcpGrid2{display:grid;grid-template-columns:1.2fr 1fr;gap:10px;align-items:end}
@media (max-width:560px){.mcpGrid2{grid-template-columns:1fr;align-items:stretch}}
.mcpField{display:grid;grid-template-rows:auto minmax(16px,auto) auto;gap:4px;min-width:0;align-content:end}
.mcpFieldPlain{grid-template-rows:auto auto;gap:6px}
.mcpLabel{font-size:12px;font-weight:500;line-height:16px;color:var(--dsw-alias-label-secondary)}
.mcpFieldHint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);min-height:16px}
.mcpFieldHintReserve{visibility:hidden}
.mcpInput{box-sizing:border-box;width:100%;height:34px;padding:0 10px;border:0.5px solid transparent;border-radius:7px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;transition:border-color .12s ease,background .12s ease,box-shadow .12s ease;outline:none}
.mcpInput::placeholder{color:var(--dsw-alias-label-caption)}
.mcpInput:hover{background:color-mix(in srgb,var(--dsw-alias-interactive-bg-hover) 70%,var(--dsw-alias-bg-layer-1))}
.mcpInput:focus{border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-label-caption) 25%,transparent)}
.mcpMono{font-family:var(--ds-font-family-code);font-size:12px;letter-spacing:-.01em}
.mcpSelectWrap{position:relative;display:flex}
.mcpSelectWrap::after{content:'';position:absolute;top:50%;right:11px;width:6px;height:6px;border-right:1.5px solid var(--dsw-alias-label-tertiary);border-bottom:1.5px solid var(--dsw-alias-label-tertiary);transform:translateY(-70%) rotate(45deg);pointer-events:none}
.mcpSelect{padding-right:28px;appearance:none;cursor:pointer}
.mcpSwitchList{display:flex;flex-direction:column;border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.mcpSwitchRow{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 10px}
.mcpSwitchRow+.mcpSwitchRow{border-top:0.5px solid var(--dsw-alias-border-l2)}
.mcpSwitchInfo{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}
.mcpSwitchLabel{font-size:12px;font-weight:500;line-height:16px;color:var(--dsw-alias-label-primary)}
.mcpSwitchHint{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary)}
.mcpSwitch{position:relative;display:inline-flex;flex-shrink:0;cursor:pointer}
.mcpSwitchInput{position:absolute;opacity:0;width:0;height:0;pointer-events:none}
.mcpSwitchTrack{position:relative;display:block;width:32px;height:18px;border-radius:999px;background:var(--dsw-alias-border-l3);transition:background .15s ease}
.mcpSwitchThumb{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.18);transition:transform .15s ease}
.mcpSwitchInput:checked+.mcpSwitchTrack{background:var(--dsw-alias-button-primary-fill)}
.mcpSwitchInput:checked+.mcpSwitchTrack .mcpSwitchThumb{transform:translateX(14px)}
.mcpEmpty{display:flex;flex-direction:column;align-items:center;gap:10px;padding:32px 16px;border:0.5px dashed var(--dsw-alias-border-l3);border-radius:12px;text-align:center}
.mcpEmptyTitle{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.mcpFoot{display:flex;flex-direction:column;align-items:stretch;gap:8px;padding-top:12px;margin-top:2px;border-top:0.5px solid var(--dsw-alias-border-l2)}
.mcpFoot .mcpStatus{align-self:flex-end}
.mcpActions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.mcpActionsSub{gap:4px}
.mcpActionsSub .mcpBtn{height:28px;padding:0 10px;font-size:12px;border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary)}
.mcpActionsSub .mcpBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.mcpEndpointWhy{color:var(--dsw-alias-label-secondary)}
.mcpIssuesBlock{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:0.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,var(--dsw-alias-border-l2));border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.mcpIssuesHead{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.mcpIssuesTitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.mcpIssuesBlock .mcpIssues{background:transparent;padding:0}
.mcpIssuesBlockSoft{border-color:var(--dsw-alias-border-l2)}
.mcpIssuesBlockSoft .mcpIssues{background:transparent}
.mcpBtn{display:inline-flex;align-items:center;justify-content:center;height:32px;padding:0 12px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:13px;font-weight:500;line-height:20px;transition:background .12s ease,border-color .12s ease,opacity .12s ease}
.mcpBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.mcpBtn:disabled{opacity:.5;cursor:not-allowed}
.mcpBtnGhost{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary)}
.mcpBtnGhost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.mcpPrimary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border-color:transparent}
.mcpPrimary:hover:not(:disabled){filter:brightness(.95)}
.mcpStatus{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.mcpStatusBusy{font-style:italic}
.mcpStatusOk{color:var(--dsw-alias-state-success-primary)}
.mcpStatusBad{color:var(--dsw-alias-state-error-primary)}
.mcpDotIdle{background:var(--dsw-alias-label-tertiary)}
.mcpDiagnosis,.mcpDiag{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
.mcpDiag[data-state=healthy]{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 35%,var(--dsw-alias-border-l2))}
.mcpDiag[data-state=unavailable],.mcpDiag[data-state=reauth]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,var(--dsw-alias-border-l2))}
.mcpDiag[data-state=unknown],.mcpDiag[data-state=recovering]{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 35%,var(--dsw-alias-border-l2))}
.mcpDiagStack{display:flex;flex-direction:column;gap:8px}
.mcpDiagHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mcpDiagState{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.mcpDiagStage{font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.mcpDiagBadge{padding:0 6px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px;white-space:nowrap}
.mcpDiagBadgeDraft{background:var(--dsw-alias-state-warn-secondary);color:var(--dsw-alias-label-primary)}
.mcpDiagBadgeBad{background:var(--dsw-alias-state-error-secondary);color:var(--dsw-alias-label-primary)}
.mcpRowName{display:flex;align-items:center;gap:6px;min-width:0}
.mcpRowName .mcpName{min-width:0}
.mcpRowDraft{border-left:2px solid var(--dsw-alias-state-warn-primary)}
.mcpDiagText{margin:0;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:18px}
.mcpDiagAction{margin:0;color:var(--dsw-alias-label-primary);font-size:12.5px;line-height:18px}
.mcpDiagMeta{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:16px}
.mcpIssues{list-style:none;margin:0;padding:8px 10px;display:flex;flex-direction:column;gap:4px;border-radius:10px;background:var(--dsw-alias-state-error-secondary)}
.mcpIssues li{color:var(--dsw-alias-label-primary);font-size:12px;line-height:17px;padding-left:10px;position:relative}
.mcpIssues li::before{content:'';position:absolute;left:0;top:7px;width:4px;height:4px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}
.mcpIssues li[data-blocking=true]::before{background:var(--dsw-alias-state-error-primary)}
.mcpScopeBar{display:flex;flex-direction:column;gap:10px;width:100%}
.mcpScopeSeg{align-self:flex-start;display:inline-flex;gap:2px;padding:3px;border-radius:12px;background:var(--dsw-alias-interactive-bg-hover)}
.mcpScopeSeg button{min-height:28px;padding:0 14px;border:0;border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;font-weight:500;cursor:pointer;transition:background .15s ease,color .15s ease,box-shadow .15s ease}
.mcpScopeSeg button:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.mcpScopeSeg button:disabled{opacity:.45;cursor:not-allowed}
.mcpScopeSeg button[data-active=true]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,.06)}
.mcpScopeBar .tbProjTabs{margin:0}
.mcpToolBar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0}
.mcpToolBar .mcpScopeBar{flex:1;min-width:260px}
.mcpToolBar .mcpInput{flex:1;width:auto;min-width:160px}
.mcpToolBar .mcpSelect{flex:none;width:auto;min-width:150px}
.mcpToolRow{display:flex;align-items:center;gap:10px;width:100%;padding:9px 12px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;text-align:left;cursor:pointer}
.mcpToolRow:hover{border-color:var(--dsw-alias-border-l3)}
.mcpToolName{flex:none;font-family:var(--ds-font-family-code);font-size:12.5px;color:var(--dsw-alias-label-primary)}

.mcpSnapRow{display:flex;align-items:center;gap:10px;padding:9px 12px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.mcpSnapMain{display:flex;flex-direction:column;gap:1px;flex:1;min-width:0}
.mcpConnector textarea.mcpInput{height:auto;min-height:120px;padding:8px 10px;resize:vertical;line-height:18px}
.mcpConnector .mcpHint{margin:0}
.mcpConnector{width:min(560px,100%);height:min(760px,100%);max-height:min(760px,100%);padding:20px 20px 16px;display:flex;flex-direction:column;gap:12px;overflow:hidden}
.mcpDlgBody{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:12px;padding-right:4px;margin-right:-4px;overscroll-behavior:contain}
.mcpDlgBody::-webkit-scrollbar{width:8px}
.mcpDlgBody::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l3);border-radius:4px}
.mcpConnector h2{margin:0;font-size:16px;font-weight:600;line-height:24px}
.mcpDlgHead{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.mcpDlgSub{margin:4px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.mcpDlgClose{flex:none;width:28px;height:28px;margin:-4px -4px 0 0;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:18px;line-height:1;cursor:pointer}
.mcpDlgClose:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.mcpReq{margin-left:2px;color:var(--dsw-alias-state-error-primary)}
.mcpConnector .mcpGrid2{align-items:start}
.mcpDlgSwap{display:flex;flex-direction:column;gap:14px;animation:mcpDlgIn .18s ease}
@keyframes mcpDlgIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.mcpLines{display:flex;flex-direction:column;gap:8px}
.mcpPair{display:flex;align-items:center;gap:8px}
.mcpPair .mcpInput{flex:1;width:auto;min-width:0}
.mcpTrash{flex:none;display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.mcpTrash:hover{background:var(--dsw-alias-state-error-secondary);color:var(--dsw-alias-state-error-primary)}
.mcpAddLine{align-self:flex-start;height:28px;padding:0 2px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:28px;cursor:pointer}
.mcpAddLine:hover{color:var(--dsw-alias-label-primary)}
.mcpDlgActions{display:flex;justify-content:flex-end;gap:8px;padding-top:12px;border-top:0.5px solid var(--dsw-alias-border-l2)}
.mcpDlgActions .mcpBtn{min-width:72px}
.mcpConnector .mcpInput,.mcpConnector .mcpSelect{height:34px;border:0.5px solid transparent;border-radius:7px;background:var(--dsw-alias-interactive-bg-hover);padding:0 10px}
.mcpConnector .mcpSelect{padding-right:28px;appearance:none;cursor:pointer}
.mcpConnector .mcpInput:focus,.mcpConnector .mcpSelect:focus{border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-label-caption) 25%,transparent)}
.memPane{display:flex;flex-direction:column;gap:12px}
.memBar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.memSearch{flex:1;min-width:180px;height:34px;padding:0 10px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;font-size:13px}
.memMeta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.memDot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
.memDot[data-ok=false]{background:var(--dsw-alias-state-error-primary)}
.memList{display:flex;flex-direction:column;gap:8px}
.memRow{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.memRowMain{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}
.memRowHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.memKind{font-size:11px;line-height:16px;padding:1px 6px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.memContent{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word}
.memSub{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.memActions{display:flex;align-items:center;gap:4px;flex:none}
.memModal{width:min(540px,100%);display:flex;flex-direction:column;gap:12px}
.memModal textarea{min-height:92px;padding:8px 10px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;font-size:13px;line-height:20px;resize:vertical}
.memCard{display:flex;flex-direction:column;gap:14px;width:100%;box-sizing:border-box;padding:16px 20px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.memCardHead{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.memCardToggle{flex:1;display:flex;align-items:center;gap:8px;min-width:0;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.memCardTitleWrap{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}
.memChevron{flex:none;width:9px;height:9px;margin-left:auto;border-right:1.5px solid var(--dsw-alias-label-tertiary);border-bottom:1.5px solid var(--dsw-alias-label-tertiary);transform:rotate(45deg);transition:transform .15s ease}
.memChevronUp{transform:rotate(-135deg)}
.memCardBody{display:flex;flex-direction:column;gap:14px;padding-top:14px;border-top:0.5px solid var(--dsw-alias-border-l2)}
.memCardTitle{margin:0;font-size:16px;line-height:24px;font-weight:600}
.memCardDesc{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.memFoot{display:flex;justify-content:flex-end;align-items:center;gap:8px;padding-top:12px;border-top:0.5px solid var(--dsw-alias-border-l2)}
.memFoot .mcpBtn{min-width:76px}
.memRow2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.memPath{display:flex;align-items:center;height:38px;padding:0 12px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font:12px/18px var(--ds-font-family-code, ui-monospace, monospace);overflow:hidden}
.memCard .mcpField{display:flex;flex-direction:column;gap:6px}
.memCard .mcpLabel{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}
.memCard .mcpFieldHint{order:3;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.memCard .mcpInput,.memCard .mcpSelect{order:2;width:100%;height:38px;padding:0 12px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;font-size:13px}
.memCard .memSeg{order:2;align-self:flex-start}
.memCard .mcpSwitchRow{padding:2px 0}
.memGrid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
.memSeg{display:inline-flex;gap:2px;padding:2px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover)}
.memSeg button{height:26px;padding:0 10px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.memSeg button[data-active=true]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-weight:600}
.memHint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.memError{margin:0;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-state-error-secondary);color:var(--dsw-alias-label-primary-foreground);font-size:12px;line-height:18px}
`

    function hasSectionLabel(element, except) {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      let text = walker.nextNode()
      while (text) {
        if ((except && except.contains(text)) || text.parentElement?.closest('#dsb-menu-mount, #dsb-recent-mount')) {
          text = walker.nextNode()
          continue
        }
        const value = text.textContent.trim()
        if (value === '工作区' || value === '项目') return true
        text = walker.nextNode()
      }
      return false
    }

    function groupShell(row, root) {
      let node = row
      while (node.parentElement && node.parentElement !== root) {
        const parent = node.parentElement
        const otherHeader = [...parent.querySelectorAll('[role="treeitem"][aria-expanded]')]
          .some(header => !node.contains(header))
        if (otherHeader || hasSectionLabel(parent, node)) return node
        const grand = parent.parentElement
        if (grand && hasSectionLabel(grand, parent)) return node
        node = parent
      }
      return node === root ? row : node
    }

    function hideRecentGroups(root, recentTitles) {
      const hide = new Set(recentTitles.filter(Boolean))
      const next = new Set()
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let node = walker.nextNode()
      while (node) {
        if (node.parentElement?.closest('#dsb-menu-mount, #dsb-recent-mount')) {
          node = walker.nextNode()
          continue
        }
        const text = node.textContent.trim()
        if (hide.has(text)) {
          const row = node.parentElement?.closest('[role="treeitem"][aria-expanded]')
          if (row && root.contains(row) && row.contains(node)) {
            const group = groupShell(row, root)
            if (group && group !== root && !group.querySelector('#dsb-menu-mount, #dsb-recent-mount, [data-dsb-section]')) {
              next.add(group)
            }
          }
        }
        node = walker.nextNode()
      }
      for (const element of root.querySelectorAll('[data-dsb-hide]')) {
        if (!next.has(element)) element.removeAttribute('data-dsb-hide')
      }
      for (const element of next) {
        if (element.getAttribute('data-dsb-hide') !== 'true') element.setAttribute('data-dsb-hide', 'true')
      }
    }

    function workspaceRefs(items) {
      return (items ?? []).map(item => ({
        workspaceId: String(item.workspaceId),
        path: String(item.path ?? ''),
        title: String(item.title ?? ''),
        sessionIds: [...(item.sessionIds ?? [])].map(String),
      }))
    }

    function sessionMap(state) {
      const byId = state?.byId ?? {}
      const map = {}
      for (const [id, session] of Object.entries(byId)) {
        map[id] = {
          id: String(id),
          title: session.blank === true ? '新会话' : String(session.displayTitle || session.title || '新会话'),
          updatedAt: Number(session.updatedAt) || 0,
          blank: session.blank === true,
        }
      }
      return map
    }

    function archivedIds(value) {
      if (value instanceof Set) return new Set([...value].map(String))
      if (Array.isArray(value)) return new Set(value.map(String))
      return new Set()
    }

    /** MCP 页的接口前缀；Host 侧的路由全部挂在它下面。 */
    const API = '/mcp-settings'

    /** 合法的环境变量名（用于 headerEnv / envEnv）。 */
    const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

    /** 输入是否应作为环境变量名（而非直接 token）。 */
    function isAuthEnvVarName(value) {
      const t = value.trim()
      if (t === '') return false
      if (!ENV_VAR_NAME.test(t)) return false
      if (t.length >= 32 && /^[0-9a-f]+$/iu.test(t)) return false
      return true
    }

    /** 规范为 Authorization header 值（补 Bearer 前缀）。 */
    function formatBearerToken(raw) {
      const t = raw.trim()
      if (/^Bearer\s+/iu.test(t)) return t
      return `Bearer ${t}`
    }

    const LOCALES = {
      zh: {
        nav: 'MCP 设置',
        pageDesc: '配置 Model Context Protocol 服务器。保存后立即挂载，新建会话即可使用对应工具。',
        servers: 'MCP 服务器',
        hintSave: '保存后会立即挂载，无需重启；工具在新建会话中出现。',
        hintEmpty: '尚未配置任何 MCP 服务器。',
        add: '+ 添加',
        save: '保存',
        check: '检测连接',
        reload: '重新读取',
        delete: '删除',
        enabled: '启用',
        readonly: '只读模式',
        loading: '读取中…',
        saving: '保存并挂载中…',
        checking: '探测中…',
        loadFail: '读取失败：',
        saveFail: '保存失败：',
        checkFail: '探测失败：',
        connected: '● 已连接',
        failed: '● 连接失败',
        disabled: '● 已停用',
        unnamed: '(未命名)',
        transportRemote: '远程',
        transportStdio: '本地',
        healthAllOk: '{n} 个已连接',
        healthMixed: '{ok} 个已连接，{bad} 个失败',
        groupBasic: '基本',
        groupConnection: '连接',
        groupAuth: '认证',
        groupAdvanced: '高级',
        fieldId: '服务器 ID',
        fieldIdHint: '工具前缀为 mcp__<ID>__*',
        fieldTransport: '传输方式',
        fieldUrl: '服务 URL',
        fieldCommand: '启动命令',
        fieldArgs: '命令参数',
        fieldToken: 'Authorization',
        fieldTokenHint: '可直接填 token，或填环境变量名（如 MCP_AUTH_TOKEN，值写在 ~/.dsh/.env）',
        fieldProjectPath: 'IDE 项目路径',
        fieldProjectPathHint: '对应 header IJ_MCP_SERVER_PROJECT_PATH',
        fieldToolsets: 'Toolsets',
        fieldToolsetsHint: '逗号分隔，如 repos,issues,pull_requests',
        fieldName: '显示名',
        fieldNameHint: '只影响界面显示，不改工具前缀',
        fieldInsecure: '允许明文访问内网',
        fieldInsecureHint: '仅对 10/172.16-31/192.168 与 IPv6 ULA 字面量生效；域名与公网地址始终要求 https',
        readonlyHint: '只读模式，禁止写操作',
        enabledHint: '关闭后不会挂载此服务器',
        serverCount: '{n} 个服务器',
        expandAdvanced: '展开高级选项',
        collapseAdvanced: '收起高级选项',
      },
      en: {
        nav: 'MCP settings',
        pageDesc: 'Configure Model Context Protocol servers. Saves mount immediately; open a new chat to use the tools.',
        servers: 'MCP servers',
        hintSave: 'Saves mount immediately without a restart. Tools appear in new chats.',
        hintEmpty: 'No MCP servers configured yet.',
        add: '+ Add',
        save: 'Save',
        check: 'Check connection',
        reload: 'Reload',
        delete: 'Delete',
        enabled: 'Enabled',
        readonly: 'Read-only',
        loading: 'Loading…',
        saving: 'Saving and mounting…',
        checking: 'Checking…',
        loadFail: 'Load failed: ',
        saveFail: 'Save failed: ',
        checkFail: 'Check failed: ',
        connected: '● Connected',
        failed: '● Failed',
        disabled: '● Disabled',
        unnamed: '(unnamed)',
        transportRemote: 'streamable-http (remote)',
        transportStdio: 'stdio (local process)',
        healthAllOk: '{n} connected. Open a new chat to use the tools.',
        healthMixed: '{ok} connected, {bad} failed. Expand failed rows for details.',
        groupBasic: 'Basic',
        groupConnection: 'Connection',
        groupAuth: 'Authentication',
        groupAdvanced: 'Advanced',
        fieldId: 'Server ID',
        fieldIdHint: 'Tools are prefixed mcp__<ID>__*',
        fieldTransport: 'Transport',
        fieldUrl: 'Service URL',
        fieldCommand: 'Command',
        fieldArgs: 'Arguments',
        fieldToken: 'Authorization',
        fieldTokenHint: 'Paste token directly, or an env var name (e.g. MCP_AUTH_TOKEN; value in ~/.dsh/.env)',
        fieldProjectPath: 'IDE project path',
        fieldProjectPathHint: 'Maps to header IJ_MCP_SERVER_PROJECT_PATH',
        fieldToolsets: 'Toolsets',
        fieldToolsetsHint: 'Comma-separated, e.g. repos,issues,pull_requests',
        readonlyHint: 'Read-only; blocks write operations',
        enabledHint: 'When off, this server is not mounted',
        serverCount: '{n} server(s)',
        expandAdvanced: 'Show advanced options',
        collapseAdvanced: 'Hide advanced options',
      },
    }

    /** 把存储条目转成表单状态。 */
    function toForm(entry) {
      const headerEnv = entry.headerEnv || {}
      const authHeader = (entry.headers && entry.headers.Authorization) || ''
      let tokenEnv = headerEnv.Authorization || ''
      if (tokenEnv === '' && authHeader !== '') {
        tokenEnv = authHeader.replace(/^Bearer\s+/iu, '')
      }
      const githubRef = (entry.envEnv && entry.envEnv.GITHUB_PERSONAL_ACCESS_TOKEN) || ''
      const tokenFromGithub = tokenEnv === '' && githubRef !== ''
      if (tokenFromGithub) tokenEnv = githubRef
      const argRows = Array.isArray(entry.args) ? entry.args.map((item) => String(item)) : []
      const envRows = Object.entries(entry.envEnv || {})
        .filter(([name]) => !(tokenFromGithub && name === 'GITHUB_PERSONAL_ACCESS_TOKEN'))
        .map(([name, value]) => ({ name, value: String(value) }))
      return {
        id: entry.id,
        name: entry.name || '',
        enabled: entry.enabled !== false,
        transport: entry.transport,
        url: entry.url || '',
        command: entry.command || '',
        argsText: argRows.join(' '),
        argRows,
        cwd: entry.cwd || '',
        tokenEnv,
        toolsets: entry.toolsets || (entry.headers && entry.headers['X-MCP-Toolsets']) || '',
        readonly: entry.readonly === true,
        insecurePrivateNetwork: entry.insecurePrivateNetwork === true,
        projectPath: (entry.headers && entry.headers.IJ_MCP_SERVER_PROJECT_PATH) || '',
        // Authorization 和 IJ_ 各有自己的输入框，其余 header 交给可增删的行；
        // 这样删掉一行就是真的删掉，不用再去比对旧值。
        extraHeaders: Object.fromEntries(
          Object.entries(entry.headers || {})
            .filter(([key]) => key === 'Authorization' || key === 'IJ_MCP_SERVER_PROJECT_PATH'),
        ),
        headerRows: headerRowsOf({ extraHeaders: entry.headers || {} }),
        envRows,
      }
    }

    /**
     * 一条记录的「连接方式」指纹。
     *
     * 只覆盖决定怎么连的字段，所以改显示名不会让一条记录看起来像草稿；
     * 探针只读磁盘，靠这个指纹才能把「表单里的值」和「正在被检测的值」分开。
     * @param {object} form - 表单状态或由 {@link toForm} 转出来的已保存状态。
     */
    function connectionKey(form) {
      return JSON.stringify([
        form.transport, form.url, form.command, form.argsText, form.cwd,
        form.tokenEnv, form.projectPath, form.extraHeaders, form.headerRows, form.envRows, form.readonly,
      ])
    }

    /** 参数行优先；和详情里的 argsText 不一致时退回按空白拆分。 */
    function resolveArgs(form) {
      const text = (form.argsText || '').trim()
      if (Array.isArray(form.argRows)) {
        const fromRows = form.argRows.map((item) => String(item).trim()).filter((item) => item !== '')
        if (text === fromRows.join(' ')) return fromRows
      }
      return text === '' ? [] : text.split(/\s+/)
    }

    /**
     * 环境变量行：变量名称 → 环境变量名引用。
     * 写入 envEnv，值本身不进配置文件。
     */
    function envEnvFromRows(rows) {
      const envEnv = {}
      if (!Array.isArray(rows)) return envEnv
      for (const row of rows) {
        const name = String(row.name || '').trim()
        const ref = String(row.value || '').trim()
        if (name === '' || ref === '') continue
        envEnv[name] = ref
      }
      return envEnv
    }

    /** 把表单状态转回存储条目。 */
    function toEntry(form) {
      const entry = {
        id: form.id.trim(),
        enabled: form.enabled,
        transport: form.transport,
      }
      if (form.name.trim() !== '') entry.name = form.name.trim()
      if (form.transport === 'stdio') {
        entry.command = form.command.trim()
        const args = resolveArgs(form)
        if (args.length > 0) entry.args = args
        if (form.cwd.trim() !== '') entry.cwd = form.cwd.trim()
        const envEnv = envEnvFromRows(form.envRows)
        const authRaw = form.tokenEnv.trim()
        if (authRaw !== '' && isAuthEnvVarName(authRaw)) {
          envEnv.GITHUB_PERSONAL_ACCESS_TOKEN = authRaw
        }
        if (Object.keys(envEnv).length > 0) entry.envEnv = envEnv
      } else {
        entry.url = form.url.trim()
        const headers = { ...(form.extraHeaders || {}) }
        for (const [header, value] of Object.entries(headerMapOf(form.headerRows || []))) headers[header] = value
        const authRaw = form.tokenEnv.trim()
        if (authRaw !== '') {
          if (isAuthEnvVarName(authRaw)) {
            entry.headerEnv = { Authorization: authRaw }
            delete headers.Authorization
          } else {
            headers.Authorization = formatBearerToken(authRaw)
          }
        } else {
          delete headers.Authorization
        }
        if (form.projectPath.trim() !== '') headers.IJ_MCP_SERVER_PROJECT_PATH = form.projectPath.trim()
        else delete headers.IJ_MCP_SERVER_PROJECT_PATH
        if (Object.keys(headers).length > 0) entry.headers = headers
      }
      if (form.insecurePrivateNetwork) entry.insecurePrivateNetwork = true
      if (form.toolsets.trim() !== '') entry.toolsets = form.toolsets.trim()
      if (form.readonly) entry.readonly = true
      return entry
    }

    const field = (label, value, onChange, opts) => {
      const mono = opts && opts.mono
      const hint = opts && opts.hint
      const reserveHint = !(opts && opts.noHintReserve)
      const plain = !hint && !reserveHint
      return h('label', { className: 'mcpField' + (plain ? ' mcpFieldPlain' : '') },
        h('span', { className: 'mcpLabel' }, label),
        (hint || reserveHint)
          ? h('span', { className: 'mcpFieldHint' + (hint ? '' : ' mcpFieldHintReserve') }, hint || '\u00a0')
          : null,
        h('input', {
          className: 'mcpInput' + (mono ? ' mcpMono' : ''),
          type: (opts && opts.type) || 'text',
          value,
          placeholder: (opts && opts.placeholder) || '',
          autoFocus: !!(opts && opts.autoFocus),
          autoComplete: (opts && opts.autoComplete) || 'off',
          spellCheck: opts && opts.spellCheck === false ? false : undefined,
          onChange: (e) => onChange(e.target.value),
        }),
      )
    }

    const selectField = (label, value, onChange, options, opts) => {
      const hint = typeof opts === 'string' ? opts : (opts && opts.hint)
      const reserveHint = !(opts && opts.noHintReserve)
      const plain = !hint && !reserveHint
      return h('label', { className: 'mcpField' + (plain ? ' mcpFieldPlain' : '') },
        h('span', { className: 'mcpLabel' }, label),
        (hint || reserveHint)
          ? h('span', { className: 'mcpFieldHint' + (hint ? '' : ' mcpFieldHintReserve') }, hint || '\u00a0')
          : null,
        h('div', { className: 'mcpSelectWrap' },
          h('select', {
            className: 'mcpInput mcpSelect',
            value,
            onChange: (e) => onChange(e.target.value),
          }, ...options),
        ),
      )
    }

    const switchRow = (label, checked, onChange, hint) => h('div', { className: 'mcpSwitchRow' },
      h('div', { className: 'mcpSwitchInfo' },
        h('span', { className: 'mcpSwitchLabel' }, label),
        hint ? h('span', { className: 'mcpSwitchHint' }, hint) : null,
      ),
      h('label', { className: 'mcpSwitch' },
        h('input', {
          type: 'checkbox',
          className: 'mcpSwitchInput',
          checked,
          onChange: (e) => onChange(e.target.checked),
        }),
        h('span', { className: 'mcpSwitchTrack' },
          h('span', { className: 'mcpSwitchThumb' }),
        ),
      ),
    )

    const fieldGroup = (title, children) => h('section', { className: 'mcpPanel' },
      h('header', { className: 'mcpPanelHead' }, h('span', { className: 'mcpPanelTitle' }, title)),
      h('div', { className: 'mcpPanelBody' }, ...children.filter(Boolean)),
    )

    function starLabel(text) {
      return h('span', null, text, h('span', { className: 'mcpReq', 'aria-hidden': 'true' }, '*'))
    }

    function trashGlyph() {
      return h('svg', {
        width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('path', { d: 'M3.2 4.5h9.6' }),
        h('path', { d: 'M6.4 4.5V3.4h3.2v1.1' }),
        h('path', { d: 'M4.4 4.5l.5 8.1h6.2l.5-8.1' }),
        h('path', { d: 'M6.7 6.6v3.8' }),
        h('path', { d: 'M9.3 6.6v3.8' }))
    }

    /** 编辑图标，和删除图标同一套线性风格。 */
    function pencilGlyph() {
      return h('svg', {
        width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('path', { d: 'M10.4 2.6 13.4 5.6 6.2 12.8H3.2V9.8L10.4 2.6Z' }),
        h('path', { d: 'M9.2 3.8 12.2 6.8' }))
    }

    /**
     * 空白表单：新建连接器的起点。
     *
     * 字段和 {@link toForm} 完全一致，所以新增和编辑共用同一个弹窗、同一套读写路径，
     * 不需要在两种形状之间来回换算。
     */
    function blankForm() {
      return {
        id: '',
        name: '',
        enabled: true,
        transport: 'streamable-http',
        url: '',
        command: '',
        argsText: '',
        argRows: [''],
        cwd: '',
        tokenEnv: '',
        toolsets: '',
        readonly: false,
        insecurePrivateNetwork: false,
        projectPath: '',
        extraHeaders: {},
        headerRows: [{ name: '', value: '' }],
        envRows: [{ name: '', value: '' }],
      }
    }

    /**
     * 表单里的额外 header 摊成可编辑的行。
     *
     * `Authorization` 和 `IJ_MCP_SERVER_PROJECT_PATH` 有各自的输入框，这里不重复列出，
     * 写回时也会原样保留。
     * @param {object} form - 表单状态。
     */
    function headerRowsOf(form) {
      const rows = Object.entries(form.extraHeaders || {})
        .filter(([name]) => name !== 'Authorization' && name !== 'IJ_MCP_SERVER_PROJECT_PATH')
        .map(([name, value]) => ({ name, value: String(value) }))
      return rows.length === 0 ? [{ name: '', value: '' }] : rows
    }

    /**
     * 把 header 行写回一个 map，空行丢掉。
     * @param {Array} rows - 行的数组。
     */
    function headerMapOf(rows) {
      const map = {}
      for (const row of rows) {
        const name = String(row.name || '').trim()
        if (name === '') continue
        map[name] = String(row.value || '').trim()
      }
      return map
    }

    /** 弹窗是否可以提交：ID 必填，HTTP 要 URL，STDIO 要命令。 */
    function formReady(form) {
      if (form.id.trim() === '') return false
      if (form.transport === 'stdio') return form.command.trim() !== ''
      return form.url.trim() !== ''
    }

    function lineSection(label, rowNodes, onAdd) {
      return h('div', { className: 'mcpLines' },
        h('span', { className: 'mcpLabel' }, label),
        ...rowNodes,
        h('button', { className: 'mcpAddLine', type: 'button', onClick: onAdd }, '+ 添加'))
    }

    function pairRows(rows, onName, onValue, onRemove, placeholders) {
      return rows.map((row, index) => h('div', { className: 'mcpPair', key: index },
        h('input', {
          className: 'mcpInput',
          value: row.name,
          placeholder: placeholders[0],
          onChange: (event) => onName(index, event.target.value),
        }),
        h('input', {
          className: 'mcpInput',
          value: row.value,
          placeholder: placeholders[1],
          onChange: (event) => onValue(index, event.target.value),
        }),
        h('button', {
          className: 'mcpTrash',
          type: 'button',
          'aria-label': '删除',
          onClick: () => onRemove(index),
        }, trashGlyph())))
    }

    /** 可选认证。HTTP 走 Authorization；STDIO 只接受环境变量名。 */
    function authKeyField(form, onChange, http) {
      return field('认证 Key', form.tokenEnv, (value) => onChange({ ...form, tokenEnv: value }), {
        placeholder: http ? 'token 或 MCP_AUTH_TOKEN' : 'MCP_AUTH_TOKEN',
        hint: http
          ? '可直接填 token，或填环境变量名（如 MCP_AUTH_TOKEN，值写在 ~/.dsh/.env）'
          : '填环境变量名（如 MCP_AUTH_TOKEN）。实际 token 写在 ~/.dsh/.env，不会进配置文件',
        mono: true,
        autoComplete: 'off',
        spellCheck: false,
      })
    }

    /**
     * 新增 / 编辑连接器的弹窗。
     *
     * 两种用途共用同一个组件和同一份表单形状：新增传 {@link blankForm}，编辑传这一行
     * 当前的值。所以「添加 MCP」和行上的「编辑」是同一套字段，不存在只在一边能改的东西。
     * @param {{ form: object, mode: string, busy: boolean, onChange: Function, onClose: Function, onSave: Function }} props
     */
    function ConnectorDialog({ form, mode, busy, onChange, onClose, onSave }) {
      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          onClose()
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [onClose])

      const http = form.transport !== 'stdio'
      const ready = formReady(form)
      const patch = (key) => (value) => onChange({ ...form, [key]: value })
      const patchRow = (key, index, fieldName) => (value) => onChange({
        ...form,
        [key]: form[key].map((row, i) => (i === index ? { ...row, [fieldName]: value } : row)),
      })
      const append = (key, blank) => () => onChange({ ...form, [key]: [...form[key], blank] })
      const drop = (key, index) => () => onChange({ ...form, [key]: form[key].filter((_, i) => i !== index) })
      const headerRows = form.headerRows.length > 0 ? form.headerRows : [{ name: '', value: '' }]
      const argRows = form.argRows.length > 0 ? form.argRows : ['']
      const envRows = form.envRows.length > 0 ? form.envRows : [{ name: '', value: '' }]

      return createPortal(h('div', {
        className: 'dsb-modal-back',
        onMouseDown: (event) => { if (event.target === event.currentTarget && !busy) onClose() },
      },
        h('form', {
          className: 'dsb-modal mcpConnector',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': 'mcp-connector-title',
          onSubmit: (event) => {
            event.preventDefault()
            if (ready && !busy) onSave()
          },
        },
          h('div', { className: 'mcpDlgHead' },
            h('div', null,
              h('h2', { id: 'mcp-connector-title' }, mode === 'edit' ? '编辑连接器' : '新建连接器'),
              h('p', { className: 'mcpDlgSub' }, http
                ? '通过 Streamable HTTP 连接远程 MCP 服务。'
                : '本地进程，由 DSH 启动并托管；只导入可信命令。')),
            h('button', { className: 'mcpDlgClose', type: 'button', 'aria-label': '关闭', onClick: onClose }, '×')),
          // 表单放在可滚动的中间区：字段变多之后不能再让底部被裁掉。
          h('div', { className: 'mcpDlgBody' },
            fieldGroup('基本', [
            h('div', { className: 'mcpGrid2', key: 'ids' },
              field(starLabel('服务器 ID'), form.id, patch('id'), {
                placeholder: '例如：company-kb',
                mono: true,
                hint: '工具前缀为 mcp__<ID>__*；改了它，旧前缀立即失效',
              }),
              field('显示名', form.name, patch('name'), {
                placeholder: '例如：公司知识库',
                hint: '只影响界面显示，不改工具前缀',
              }),
            ),
            h('div', { className: 'mcpGrid2', key: 'transport' },
              selectField('传输类型', form.transport, patch('transport'), [
                h('option', { value: 'streamable-http', key: 'http' }, 'HTTP（远程）'),
                h('option', { value: 'stdio', key: 'stdio' }, 'STDIO（本地进程）'),
              ]),
              switchRow('只读模式', form.readonly, patch('readonly'), '向服务端请求只读模式，禁止写操作'),
            ),
          ]),
          h('div', { className: 'mcpDlgSwap', key: form.transport },
            http
              ? fieldGroup('连接', [
                  field(starLabel('服务 URL'), form.url, patch('url'), {
                    placeholder: 'https://mcp.example.com/mcp',
                  }),
                  switchRow('允许明文访问内网', form.insecurePrivateNetwork, patch('insecurePrivateNetwork'),
                    '仅对 10/172.16-31/192.168 与 IPv6 ULA 字面量生效；域名与公网地址始终要求 https'),
                  lineSection('自定义 Headers', pairRows(
                    headerRows,
                    (index, value) => patchRow('headerRows', index, 'name')(value),
                    (index, value) => patchRow('headerRows', index, 'value')(value),
                    (index) => drop('headerRows', index)(),
                    ['Header 名称', 'Header 值'],
                  ), append('headerRows', { name: '', value: '' })),
                ])
              : fieldGroup('连接', [
                  h('div', { className: 'mcpGrid2', key: 'cmd' },
                    field(starLabel('命令'), form.command, patch('command'), { placeholder: 'npx', mono: true }),
                    field('工作目录', form.cwd, patch('cwd'), { placeholder: '留空则继承默认', mono: true }),
                  ),
                  lineSection('参数', argRows.map((item, index) => h('div', { className: 'mcpPair', key: index },
                    h('input', {
                      className: 'mcpInput',
                      value: item,
                      placeholder: '-y @modelcontextprotocol/server-filesystem /tmp',
                      onChange: (event) => onChange({
                        ...form,
                        argRows: argRows.map((row, i) => (i === index ? event.target.value : row)),
                      }),
                    }),
                    h('button', {
                      className: 'mcpTrash',
                      type: 'button',
                      'aria-label': '删除',
                      onClick: drop('argRows', index),
                    }, trashGlyph()))), append('argRows', '')),
                  lineSection('环境变量', pairRows(
                    envRows,
                    (index, value) => patchRow('envRows', index, 'name')(value),
                    (index, value) => patchRow('envRows', index, 'value')(value),
                    (index) => drop('envRows', index)(),
                    ['变量名称', '环境变量名'],
                  ), append('envRows', { name: '', value: '' })),
                ])),
          fieldGroup('认证', [
            authKeyField(form, onChange, http),
            field('Toolsets', form.toolsets, patch('toolsets'), {
              placeholder: 'repos,issues,pull_requests',
              hint: '逗号分隔；留空表示不限制',
            }),
            http
              ? field('IDE 项目路径', form.projectPath, patch('projectPath'), {
                placeholder: '/path/to/your/project',
                mono: true,
                hint: '对应 header IJ_MCP_SERVER_PROJECT_PATH',
              })
              : null,
            ]),
          ),
          h('div', { className: 'mcpDlgActions' },
            h('button', { className: 'mcpBtn', type: 'button', disabled: busy, onClick: onClose }, '取消'),
            h('button', { className: 'mcpBtn mcpPrimary', type: 'submit', disabled: !ready || busy }, busy ? '保存中…' : '保存')))), document.body)
    }

    /** 服务器作用域的中文标签，与技能页保持一致。 */
    const MCP_SCOPE_LABELS = { global: '全局', project: '工作区' }

    /** 连接状态到状态点的样式。 */
    const MCP_DOT_CLASS = {
      healthy: 'mcpDotOk',
      degraded: 'mcpDotOff',
      recovering: 'mcpDotOff',
      reauth: 'mcpDotBad',
      unavailable: 'mcpDotBad',
      disabled: 'mcpDotOff',
      unknown: 'mcpDotIdle',
    }

    /**
     * MCP 面板：服务器 / 工具 / 备份 三个子页共用一份状态。
     *
     * 面板只负责收集输入和展示结论：校验、握手、脱敏、快照都在 Host 侧完成，
     * 所以页面不会和磁盘上的配置说两套话。
     * @param {{ t: Function, onBack?: Function, embedded?: boolean, addAction?: object, projectCwd?: Function }} props
     */
    function SettingsPanel({ t, onBack, embedded, addAction, projectCwd, workspaces, activeWorkspaceId, onSelectWorkspace }) {
      const [scope, setScope] = React.useState('global')
      const [snapshot, setSnapshot] = React.useState(null)
      const [forms, setForms] = React.useState([])
      const [revision, setRevision] = React.useState(0)
      const [dirty, setDirty] = React.useState(false)
      const [health, setHealth] = React.useState(null)
      const [status, setStatus] = React.useState('')
      const [tone, setTone] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      // 展开的行号。展开看到的是这一条的工具清单，不是配置。
      const [openIndex, setOpenIndex] = React.useState(-1)
      // 服务器键 -> { loading, tools, message }，只保留展开过的那些。
      const [rowTools, setRowTools] = React.useState({})
      // null 表示弹窗关闭；index 为 -1 是新增，否则是正在编辑的行号。
      const [connector, setConnector] = React.useState(null)
      const [issues, setIssues] = React.useState([])
      const [probeRows, setProbeRows] = React.useState(null)
      const [importDraft, setImportDraft] = React.useState(null)
      const [exportDraft, setExportDraft] = React.useState(null)
      const [toolDetail, setToolDetail] = React.useState(null)
      const [migration, setMigration] = React.useState(null)
      const scopeRef = React.useRef('global')

      // 工作区选择由工具箱统一持有，MCP 只是跟着走——和技能页共用同一个选择。
      const workspaceList = workspaces || []
      const activeWorkspace = workspaceList.find((item) => item.workspaceId === activeWorkspaceId) || null
      const activeProjectPath = activeWorkspace !== null
        ? activeWorkspace.path
        : (typeof projectCwd === 'function' ? projectCwd() : '')
      const projectPathRef = React.useRef(activeProjectPath)
      projectPathRef.current = activeProjectPath

      /** 统一的 JSON 请求，失败时抛出可读错误。 */
      const api = React.useCallback(async (path, init) => {
        const withBody = init && init.body !== undefined
        const res = await fetch(API + path, {
          ...init,
          headers: withBody
            ? { accept: 'application/json', 'content-type': 'application/json' }
            : { accept: 'application/json' },
        })
        const body = await res.json().catch(() => null)
        if (body === null) throw new Error('Host 返回了无法解析的响应')
        return body
      }, [])

      /** 把某一作用域的条目灌进表单。 */
      const applyScope = React.useCallback((next, payload) => {
        const group = next === 'project' ? payload.project : payload.global
        setForms(((group && group.servers) || []).map(toForm))
        setRevision(group ? group.revision : 0)
        setDirty(false)
        setIssues([])
        setProbeRows(null)
      }, [])

      const load = React.useCallback(async (options) => {
        const opts = options || {}
        if (!opts.quiet) { setBusy(true); setStatus(t('loading')); setTone('') }
        try {
          const cwd = projectPathRef.current
          const query = cwd === '' ? '' : '?cwd=' + encodeURIComponent(cwd)
          const payload = await api('/state' + query)
          if (payload.ok !== true) throw new Error(payload.error || '读取失败')
          const next = scopeRef.current === 'project' && payload.project === null ? 'global' : scopeRef.current
          scopeRef.current = next
          setSnapshot(payload)
          setScope(next)
          applyScope(next, payload)
          setHealth(payload.health)
          if (!opts.quiet) { setStatus(''); setTone('') }
        } catch (error) {
          setStatus(t('loadFail') + String(error))
          setTone('bad')
        } finally {
          if (!opts.quiet) setBusy(false)
        }
        // 不依赖 projectCwd：它的身份由外层 slot 决定，跟着它会让 load 反复重建。
      }, [api, applyScope, t])

      /** 后台真实握手一次，拿到新鲜的健康结论。 */
      const refreshHealth = React.useCallback(async (quiet) => {
        if (!quiet) { setBusy(true); setStatus(t('checking')); setTone('') }
        try {
          const out = await api('/health?force=1')
          if (out.ok !== true) throw new Error(out.error || '检测失败')
          setHealth(out.health)
          if (!quiet) { setStatus(out.health.label); setTone(out.health.failed > 0 ? 'bad' : 'ok') }
        } catch (error) {
          if (!quiet) { setStatus(t('checkFail') + String(error)); setTone('bad') }
        } finally {
          if (!quiet) setBusy(false)
        }
      }, [api, t])

      /**
       * 只读当前健康结论，不触发新的握手。
       *
       * 后台每 30 秒会重探到期项，页面只需要跟上；这样轮询便宜，
       * 也不会有第二个地方按自己的节奏去打远端。
       */
      const pollHealth = React.useCallback(async () => {
        try {
          const out = await api('/health')
          if (out.ok === true) setHealth(out.health)
        } catch (error) {
          // 轮询失败不该打断操作，下一次会自己好。
        }
      }, [api])

      // 换工作区就重新读那一个的配置：Host 会把活跃项目切过去并重新挂载。
      // 只依赖路径：load 是通过 ref 读路径的，把它列进依赖只会带来无谓的重读。
      React.useEffect(() => { void load({}) }, [activeProjectPath])
      React.useEffect(() => {
        // 首屏先渲染已有结论，再在后台补一次真实握手，避免页面卡在超时上。
        const timer = setTimeout(() => { void refreshHealth(true) }, 60)
        return () => clearTimeout(timer)
      }, [refreshHealth])
      React.useEffect(() => {
        const timer = setInterval(() => { void pollHealth() }, 15000)
        return () => clearInterval(timer)
      }, [pollHealth])

      /** 丢改动前先问一句，避免切个作用域就把编辑吞掉。 */
      const confirmDiscard = () => !dirty || window.confirm('当前有未保存的改动，切换后会丢失。继续吗？')

      /** 切换作用域。 */
      const switchScope = (next) => {
        if (next === scope || snapshot === null) return
        if (!confirmDiscard()) return
        scopeRef.current = next
        setScope(next)
        applyScope(next, snapshot)
        setOpenIndex(-1)
      }

      /** 切换工作区：交给工具箱统一改，再靠上面的 effect 重新读取。 */
      const selectWorkspace = (id) => {
        if (id === activeWorkspaceId) return
        if (!confirmDiscard()) return
        if (typeof onSelectWorkspace === 'function') onSelectWorkspace(id)
      }

      const patch = (index, key, value) => {
        setForms((prev) => prev.map((f, i) => (i === index ? { ...f, [key]: value } : f)))
        setDirty(true)
        setIssues([])
      }

      /** 只校验不保存，用来在保存前看清单条问题。 */
      const validateOnly = async () => {
        setBusy(true)
        setTone('')
        try {
          const out = await api('/validate', {
            method: 'POST',
            body: JSON.stringify({ scope, servers: forms.map(toEntry) }),
          })
          setIssues(out.issues || [])
          const groups = issueGroups(out.issues || [])
          setStatus(groups.length === 0
            ? '没有问题，可以保存'
            : `${String(groups.length)} 类问题会挡下保存，见下方`)
          setTone(groups.length === 0 ? 'ok' : 'bad')
        } catch (error) {
          setStatus(String(error))
          setTone('bad')
        } finally {
          setBusy(false)
        }
      }

      /** 只做握手，不写配置。 */
      const probeOnly = async () => {
        setBusy(true)
        setTone('')
        try {
          const out = await api('/probe', {
            method: 'POST',
            body: JSON.stringify({ scope, servers: forms.map(toEntry), all: true }),
          })
          setProbeRows(out.results || [])
          if (out.ok === true) setStatus(`握手成功（检查了 ${out.checked || 0} 个）`)
          else if (out.reason === 'invalid') { setIssues(out.issues || []); setStatus(out.error); setTone('bad') }
          else setStatus(out.error || '握手失败')
          setTone(out.ok === true ? 'ok' : 'bad')
        } catch (error) {
          setStatus(String(error))
          setTone('bad')
        } finally {
          setBusy(false)
        }
      }

      /**
       * 保存当前作用域。
       *
       * 新增或改过连接方式的条目必须先通过真实握手；被拒绝时把逐条结果留下，
       * 由用户决定改配置还是强制保存。
       */
      const save = async (force) => {
        setBusy(true)
        setStatus(t('saving'))
        setTone('')
        try {
          const out = await api('/save', {
            method: 'POST',
            body: JSON.stringify({
              scope,
              servers: forms.map(toEntry),
              expectedRevision: revision,
              probe: force !== true,
            }),
          })
          setIssues(out.issues || [])
          setProbeRows(out.results || null)
          if (out.ok === true) {
            setStatus(out.message || '已保存')
            setTone('ok')
            setHealth(out.health || null)
            await load({ quiet: true })
            return
          }
          if (out.stage === 'conflict') {
            setStatus('这份配置在别处被改过，已重新读取')
            setTone('bad')
            await load({ quiet: true })
            return
          }
          const groups = issueGroups(out.issues || [])
          if (out.stage === 'validate' && groups.length > 0) {
            setStatus(`${String(groups.length)} 类配置问题挡下了保存，见下方`)
          } else if (out.stage === 'probe') {
            // 原因写在编辑弹窗里，所以直接把失败的那一条打开，
            // 别让提示指向一个看不到的地方。
            const failedIds = (out.results || [])
              .filter((row) => row.ok !== true && row.kind !== 'managed')
              .map((row) => row.id)
            const index = forms.findIndex((form) => failedIds.includes(form.id))
            if (index >= 0) setConnector({ form: { ...forms[index] }, index })
            setStatus(out.error || '保存失败')
          } else {
            setStatus(out.error || '保存失败')
          }
          setTone('bad')
          if (out.stage === 'commit') await load({ quiet: true })
        } catch (error) {
          setStatus(String(error))
          setTone('bad')
        } finally {
          setBusy(false)
        }
      }

      /** 新建：先塞进表单，保存时才落盘。 */
      const addServer = () => setConnector({ form: blankForm(), index: -1 })
      if (addAction) addAction.current = addServer

      /** 编辑：把这一行当前的值带进同一个弹窗。 */
      const editServer = (index) => setConnector({ form: { ...forms[index] }, index })

      const saveConnector = () => {
        if (connector === null || !formReady(connector.form)) return
        const next = connector.form
        setForms((prev) => (connector.index < 0
          ? [...prev, next]
          : prev.map((form, i) => (i === connector.index ? next : form))))
        setDirty(true)
        setConnector(null)
      }

      /** 查某条记录的健康行。 */
      const healthOf = (id) => {
        const rows = (health && health.results) || []
        return rows.find((row) => row.id === id && row.scope === scope) || null
      }

      /** 状态点：颜色来自 8 态状态机，未观测时不冒充健康。 */
      const healthDot = (id) => {
        const row = healthOf(id)
        if (row === null) return null
        return h('span', {
          className: 'mcpDot ' + (MCP_DOT_CLASS[row.state] || 'mcpDotIdle'),
          title: row.label + ' · ' + row.message,
        })
      }

      /** 列表副标题只展示能区分服务器的地址，不重复传输类型。 */
      const endpointLabel = (form) => {
        if (form.transport === 'stdio') {
          return [form.command, form.argsText].filter(Boolean).join(' ').trim()
        }
        const url = (form.url || '').trim()
        if (url === '') return ''
        try {
          const parsed = new URL(url)
          const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '')
          return parsed.host + path
        } catch {
          return url
        }
      }

      /** 某条记录当前要展示的问题（校验问题 + 握手结果）。 */
      const issuesFor = (id) => issues.filter((issue) => issue.id === id)
      const probeFor = (id) => (probeRows || []).find((row) => row.id === id) || null

      /** 打开导入对话框并先做一次预校验。 */
      const openImport = async (json, mode) => {
        setBusy(true)
        setTone('')
        try {
          const out = await api('/import', {
            method: 'POST',
            body: JSON.stringify({ scope, json, mode: mode || 'merge', apply: false }),
          })
          if (out.ok === true) {
            setImportDraft({ json, mode: mode || 'merge', parsed: out, error: '' })
            setIssues(out.issues || [])
            setStatus(out.message)
            setTone('ok')
          } else {
            setImportDraft({ json, mode: mode || 'merge', parsed: null, error: out.error || '无法解析' })
            setIssues(out.issues || [])
            setStatus(out.error || '无法解析')
            setTone('bad')
          }
        } catch (error) {
          setStatus(String(error))
          setTone('bad')
        } finally {
          setBusy(false)
        }
      }

      const applyImport = async () => {
        if (importDraft === null || importDraft.parsed === null) return
        setBusy(true)
        try {
          const out = await api('/import', {
            method: 'POST',
            body: JSON.stringify({
              scope,
              json: importDraft.json,
              mode: importDraft.mode,
              apply: true,
              expectedRevision: revision,
            }),
          })
          setIssues(out.issues || [])
          if (out.ok === true) {
            setStatus(out.message || '已导入')
            setTone('ok')
            setImportDraft(null)
            await load({ quiet: true })
          } else {
            setStatus(out.error || '导入失败')
            setTone('bad')
          }
        } catch (error) {
          setStatus(String(error))
          setTone('bad')
        } finally {
          setBusy(false)
        }
      }

      /** 导出为脱敏 JSON。 */
      const openExport = async () => {
        setBusy(true)
        try {
          const out = await api('/export?scope=' + scope)
          if (out.ok !== true) throw new Error(out.error || '导出失败')
          setExportDraft(out)
        } catch (error) {
          setStatus(String(error))
          setTone('bad')
        } finally {
          setBusy(false)
        }
      }

      /**
       * 读某一条服务器缓存的工具清单。
       * @param {object} form - 表单状态，用来拼服务器键。
       * @param {boolean} quiet - 为 true 时不显示「加载中」占位。
       */
      const loadRowTools = React.useCallback(async (form, quiet) => {
        const key = scopeRef.current + ':' + form.id
        if (quiet !== true) {
          setRowTools((prev) => ({ ...prev, [key]: { loading: true, tools: [], message: '' } }))
        }
        try {
          const out = await api('/tools?scope=' + scopeRef.current + '&server=' + encodeURIComponent(form.id))
          const rows = out.tools || []
          setRowTools((prev) => ({
            ...prev,
            [key]: { loading: false, tools: rows, message: out.ok === true ? '' : (out.error || '读不到工具清单') },
          }))
        } catch (error) {
          setRowTools((prev) => ({ ...prev, [key]: { loading: false, tools: [], message: String(error) } }))
        }
      }, [api])

      /** 展开 / 收起某一行。展开时按需拉一次它自己的工具清单。 */
      const toggleRow = (form, index) => {
        const next = openIndex === index ? -1 : index
        setOpenIndex(next)
        if (next === index && rowTools[scopeRef.current + ':' + form.id] === undefined) {
          void loadRowTools(form)
        }
      }

      /** 重新发现某一条的工具，然后刷新它的展开内容。 */
      const refreshRowTools = async (form) => {
        setBusy(true)
        setTone('')
        try {
          const out = await api('/tools/refresh', {
            method: 'POST',
            body: JSON.stringify({ id: form.id, scope }),
          })
          setStatus(out.message || '已刷新')
          setTone(out.ok === true ? 'ok' : 'bad')
          await loadRowTools(form, true)
        } catch (error) {
          setStatus(String(error))
          setTone('bad')
        } finally {
          setBusy(false)
        }
      }

      const openToolDetail = async (tool) => {
        try {
          const params = new URLSearchParams({ name: tool.name, server: tool.server, scope: tool.scope })
          const out = await api('/tools/detail?' + params.toString())
          if (out.ok !== true) throw new Error(out.error || '读不到这个工具的详情')
          setToolDetail(out.tool)
        } catch (error) {
          setStatus(String(error))
          setTone('bad')
        }
      }

      /** 预演把明文凭据搬进 ~/.dsh/.env，不写任何东西。 */
      const openMigration = async () => {
        setBusy(true)
        setTone('')
        try {
          const out = await api('/credentials/migrate', {
            method: 'POST',
            body: JSON.stringify({ scope, servers: forms.map(toEntry) }),
          })
          if (out.ok !== true && out.plan === undefined) throw new Error(out.error || '无法生成方案')
          setMigration(out.plan)
          if (out.plan.ok !== true) {
            setStatus(out.plan.message)
            setTone('bad')
          }
        } catch (error) {
          setStatus(String(error))
          setTone('bad')
        } finally {
          setBusy(false)
        }
      }

      const applyMigration = async () => {
        if (migration === null) return
        setBusy(true)
        try {
          const out = await api('/credentials/migrate', {
            method: 'POST',
            body: JSON.stringify({ apply: true, scope, servers: forms.map(toEntry) }),
          })
          setStatus(out.message || out.error || '已处理')
          setTone(out.ok === true ? 'ok' : 'bad')
          if (out.ok === true) {
            setMigration(null)
            setIssues([])
            await load({ quiet: true })
          }
        } catch (error) {
          setStatus(String(error))
          setTone('bad')
        } finally {
          setBusy(false)
        }
      }



      /**
       * 行副标题：出问题时直接把「阶段 · 原因」写在这里，不必展开才知道为什么红。
       * @param {object|null} row - 健康行。
       * @param {object|null} probe - 最近一次手动握手结果。
       * @param {string} endpoint - 正常状态下显示的地址。
       */
      const rowReason = (row, probe, endpoint) => {
        // 手动探测的结果比后台结论新，而且它是针对表单里那些值的——
        // 保存被它挡下时就该显示它，否则用户看到的是一句对不上的旧原因。
        if (probe !== null && probe.ok !== true && probe.kind !== 'managed') {
          return '当前表单值：' + probe.message
        }
        if (probe !== null && probe.ok === true) return '当前表单值：' + probe.message
        if (row !== null && row.state !== 'healthy' && row.state !== 'disabled' && row.state !== 'unknown') {
          return row.stageLabel + ' · ' + row.message
        }
        return endpoint
      }

      /** 已保存条目的连接方式指纹，键是服务器 ID。 */
      const savedKeys = new Map()
      if (snapshot !== null) {
        const group = scope === 'project' ? snapshot.project : snapshot.global
        for (const entry of (group && group.servers) || []) savedKeys.set(entry.id, connectionKey(toForm(entry)))
      }

      /**
       * 这一行是不是还没落盘的草稿。
       *
       * 探针读的是磁盘，所以草稿行必须显式标出来，否则改了 URL 却还在展示旧地址的
       * 失败原因，看起来像改动没生效。
       * @param {object} form - 表单状态。
       */
      const isDraft = (form) => savedKeys.get(form.id) !== connectionKey(form)

      /** 只用这一条当前的表单值做一次握手，不写配置。 */
      const probeOne = async (form) => {
        setBusy(true)
        setTone('')
        try {
          const out = await api('/probe', {
            method: 'POST',
            body: JSON.stringify({ scope, servers: [toEntry(form)], all: true }),
          })
          const row = (out.results || [])[0]
          if (row !== undefined) {
            setProbeRows((prev) => [...(prev || []).filter((item) => item.id !== row.id), row])
          }
          setStatus(row === undefined ? '没有拿到探测结果' : `${form.id || '这一条'}：${row.message}`)
          setTone(row !== undefined && row.ok === true ? 'ok' : 'bad')
        } catch (error) {
          setStatus(String(error))
          setTone('bad')
        } finally {
          setBusy(false)
        }
      }

      /**
       * 把重复的问题合并成「一句话 × N」，避免底部刷一屏同样的红字。
       * @param {Array} list - Host 返回的问题清单。
       */
      const issueGroups = (list) => {
        const counts = new Map()
        for (const issue of list) counts.set(issue.message, (counts.get(issue.message) || 0) + 1)
        return [...counts.entries()].map(([message, count]) => ({ message, count }))
      }

      /**
       * 诊断区：把「当前表单值检测」和「已保存配置」分成两块并列显示。
       *
       * 两者会不一致——探针只读磁盘，而手动检测打的是表单里的值——所以不能只显示其一，
       * 否则用户会看到一句和他刚做的事对不上的话。
       * @param {object|null} row - 已保存配置的健康行。
       * @param {object|null} probe - 最近一次针对表单值的握手结果。
       * @param {Array} rowIssues - 这一条的问题清单。
       * @param {object} form - 表单状态。
       * @param {boolean} draft - 表单是否偏离了已保存的配置。
       */
      /**
       * 展开区顶部的状态说明。
       *
       * 只在「出过问题」或「刚手动检测过」时才出现：一切正常时不该再堆一段话解释它有多正常。
       * @param {object|null} row - 已保存配置的健康行。
       * @param {object|null} probe - 最近一次针对表单值的握手结果。
       */
      const statusLine = (row, probe) => {
        const notes = []
        if (probe !== null && (probe.ok !== true || probe.kind !== 'connected')) {
          notes.push('当前表单值检测：' + probe.message)
        }
        if (row !== null && row.state !== 'healthy') {
          notes.push(`${row.stageLabel}：${row.message}` + (row.action === '' ? '' : `。建议：${row.action}`))
        }
        if (notes.length === 0) return null
        return h('div', { className: 'mcpBodyNote' }, notes.map((text, index) => h('p', { key: index }, text)))
      }

      /**
       * 展开区里的工具清单。
       * @param {object} form - 这一条当前的表单值。
       */
      const toolListFor = (form) => {
        const state = rowTools[scope + ':' + form.id]
        if (state === undefined || state.loading === true) {
          return h('p', { className: 'mcpHint' }, '正在读取工具清单…')
        }
        if (state.message !== '') return h('p', { className: 'mcpHint' }, state.message)
        if (state.tools.length === 0) {
          return h('p', { className: 'mcpHint' }, '还没有工具缓存。点「重新发现工具」拉一次；本地进程由 DSH 启动，这里看不到它的工具。')
        }
        return h('div', { className: 'mcpToolList' }, state.tools.map((tool, index) => h('button', {
          key: index,
          type: 'button',
          className: 'mcpToolRow',
          onClick: () => { void openToolDetail(tool) },
        },
          h('span', { className: 'mcpToolName' }, tool.name),
          tool.description ? h('span', { className: 'mcpToolDesc' }, tool.description) : null,
        )))
      }

      const rows = forms.map((form, index) => {
        const open = openIndex === index
        const row = healthOf(form.id)
        const endpoint = endpointLabel(form)
        const name = form.name || form.id || t('unnamed')
        // 未观测和已停用不是失败，不该套红框。
        const failed = row !== null && row.enabled
          && row.state !== 'healthy' && row.state !== 'unknown' && row.state !== 'disabled'
        const probe = probeFor(form.id)
        const draft = isDraft(form)
        const issueCount = issuesFor(form.id).length
        const reason = rowReason(row, probe, endpoint)
        return h('article', {
          className: 'mcpRow' + (failed ? ' mcpRowFailed' : '') + (draft ? ' mcpRowDraft' : '') + (open ? ' mcpRowOpen' : ''),
          key: index,
        },
          h('header', { className: 'mcpRowHead' },
            // 点开是看这一条的工具，改配置走右边的铅笔——两件事分开放。
            h('button', {
              className: 'mcpRowToggle',
              type: 'button',
              'aria-expanded': open,
              title: open ? '收起工具清单' : '展开工具清单',
              onClick: () => toggleRow(form, index),
            },
              h('span', { className: 'mcpMarkWrap' },
                toolMark(name, true),
                healthDot(form.id),
              ),
              h('span', { className: 'mcpRowMeta' },
                h('span', { className: 'mcpRowName' },
                  h('span', { className: 'mcpName' }, name),
                  draft ? h('span', { className: 'mcpDiagBadge mcpDiagBadgeDraft', title: '改动还没保存' }, '未保存') : null,
                  issueCount > 0 ? h('span', { className: 'mcpDiagBadge mcpDiagBadgeBad', title: '这一条有配置问题' }, `${String(issueCount)} 处问题`) : null,
                ),
                reason === '' ? null : h('span', {
                  className: 'mcpEndpoint' + (reason === endpoint ? '' : ' mcpEndpointWhy'),
                  title: reason,
                }, reason),
              ),
              h('span', { className: 'mcpChevron' + (open ? ' mcpChevronOpen' : '') }),
            ),
            h('div', { className: 'mcpRowActions' },
              row === null ? null : h('span', { className: 'mcpConn', 'data-state': row.state }, row.label),
              h('button', {
                className: 'mcpIconBtn',
                type: 'button',
                title: '编辑',
                'aria-label': `编辑 ${name}`,
                onClick: () => editServer(index),
              }, pencilGlyph()),
              h('button', {
                className: 'mcpDel',
                type: 'button',
                title: t('delete'),
                'aria-label': `${t('delete')} ${name}`,
                onClick: () => {
                  setForms((prev) => prev.filter((_, i) => i !== index))
                  setDirty(true)
                  setOpenIndex(-1)
                },
              }, '×'),
            ),
            toolSwitch(form.enabled, (enabled) => patch(index, 'enabled', enabled), form.enabled ? `停用${name}` : `启用${name}`),
          ),
          open ? h('div', { className: 'mcpBody' },
            statusLine(row, probe),
            toolListFor(form),
            toolDetail === null ? null : h('section', { className: 'mcpPanel' },
              h('header', { className: 'mcpPanelHead' },
                h('span', { className: 'mcpPanelTitle' }, toolDetail.name),
                h('button', { className: 'mcpBtn', type: 'button', onClick: () => setToolDetail(null) }, '收起')),
              h('div', { className: 'mcpPanelBody' },
                toolDetail.publicName === null
                  ? null
                  : h('p', { className: 'mcpHint' }, '模型侧名称：' + toolDetail.publicName),
                toolDetail.description === null ? null : h('p', { className: 'mcpDiagText' }, toolDetail.description),
                h('pre', { className: 'mcpError' }, JSON.stringify(toolDetail.inputSchema, null, 2)))),
            h('div', { className: 'mcpActions mcpActionsSub' },
              h('button', {
                className: 'mcpBtn', type: 'button', disabled: busy,
                title: '重新拉一次这一条的工具清单',
                onClick: () => { void refreshRowTools(form) },
              }, '重新发现工具'),
              h('button', {
                className: 'mcpBtn', type: 'button', disabled: busy,
                title: '用当前表单里的值做一次握手，不写配置',
                onClick: () => { void probeOne(form) },
              }, '用当前表单值检测'),
            ),
          ) : null,
        )
      })

      /**
       * 作用域切换：全局 / 工作区。
       *
       * 和技能页同一个形状——先选作用域，选工作区时再列出具体是哪一个，
       * 而不是默默对「当前打开的项目」下手。
       */
      const scopeBar = h('div', { className: 'mcpScopeBar' },
        h('div', { className: 'mcpScopeSeg', role: 'tablist', 'aria-label': '配置作用域' },
          h('button', {
            type: 'button', role: 'tab',
            'data-active': scope === 'global',
            'aria-selected': scope === 'global',
            onClick: () => switchScope('global'),
          }, '全局'),
          h('button', {
            type: 'button', role: 'tab',
            disabled: workspaceList.length === 0,
            title: workspaceList.length === 0 ? '还没有工作区' : '配置只在这个工作区里生效',
            'data-active': scope === 'project',
            'aria-selected': scope === 'project',
            onClick: () => switchScope('project'),
          }, '工作区'),
        ),
        scope !== 'project' || workspaceList.length === 0 ? null : h('div', {
          className: 'tbProjTabs', role: 'tablist', 'aria-label': '工作区',
        }, workspaceList.map((item) => h('button', {
          key: item.workspaceId,
          type: 'button',
          className: 'tbProjTab',
          role: 'tab',
          title: item.path,
          'data-active': item.workspaceId === activeWorkspaceId,
          'aria-selected': item.workspaceId === activeWorkspaceId,
          onClick: () => selectWorkspace(item.workspaceId),
        }, item.title || item.path.split(/[/\\]/).filter(Boolean).pop() || item.path))),
      )

      // 工具箱那边已经有「+ 添加 MCP」，所以嵌进去时不再重复放一个；
      // 只有单独用这个面板时才需要自带入口。
      const connectorButton = embedded
        ? null
        : h('button', { className: 'mcpBtn mcpBtnGhost', type: 'button', disabled: busy, onClick: addServer }, t('add'))

      // 同一句话出现多次时只列一次并标数量，别把底部刷成一屏重复的红字。
      const listedGroups = issueGroups(issues)
      const issuePanel = listedGroups.length === 0 ? null : h('section', { className: 'mcpIssuesBlock' },
        h('header', { className: 'mcpIssuesHead' },
          h('span', { className: 'mcpIssuesTitle' }, `${String(listedGroups.length)} 类问题挡下了保存`),
        ),
        h('ul', { className: 'mcpIssues' }, listedGroups.slice(0, 4).map((group, index) => h('li', {
          key: index,
          'data-blocking': true,
        }, group.count > 1 ? `${group.message}（${String(group.count)} 处）` : group.message))),
        listedGroups.length <= 4 ? null : h('p', { className: 'mcpHint' }, `还有 ${String(listedGroups.length - 4)} 类；展开对应服务器可以看到各自的明细。`),
      )

      return h(React.Fragment, null,
        h('div', { className: 'mcpCard' },
        !embedded && onBack ? h('button', { className: 'dsb-back dsb-back-top', type: 'button', onClick: onBack }, '← 返回对话') : null,
        embedded ? null : h('div', { className: 'mcpHead' },
          h('h1', { className: 'mcpPageTitle' }, 'MCP 配置'),
          connectorButton === null ? null : h('div', { className: 'mcpActions' }, connectorButton),
        ),
        h('div', { className: 'mcpToolBar' }, scopeBar),
        rows.length === 0
          ? h('p', { className: 'mcpEmpty' }, t('hintEmpty'))
          : h('div', { className: 'mcpList' }, rows),
        h('div', { className: 'mcpFoot' },
          h('div', { className: 'mcpActions' },
            h('button', { className: 'mcpBtn mcpPrimary', type: 'button', disabled: busy, onClick: () => { void save(false) } }, t('save')),
            h('button', {
              className: 'mcpBtn',
              type: 'button',
              disabled: busy,
              title: '跳过保存前的握手检查，直接把配置写进去',
              onClick: () => { void save(true) },
            }, '跳过握手保存'),
            dirty ? h('span', { className: 'mcpStatus' }, '有未保存的改动') : null,
          ),
          h('div', { className: 'mcpActions mcpActionsSub' },
            h('button', { className: 'mcpBtn', type: 'button', disabled: busy, onClick: () => { void validateOnly() } }, '校验'),
            h('button', { className: 'mcpBtn', type: 'button', disabled: busy, onClick: () => { void probeOnly() } }, t('check')),
            h('button', { className: 'mcpBtn', type: 'button', disabled: busy, onClick: () => { void refreshHealth(false) } }, '刷新状态'),
            h('button', { className: 'mcpBtn', type: 'button', disabled: busy, onClick: () => { void load({}) } }, t('reload')),
            h('button', { className: 'mcpBtn', type: 'button', disabled: busy, onClick: () => { void openImport('', 'merge') } }, '导入 JSON'),
            h('button', { className: 'mcpBtn', type: 'button', disabled: busy, onClick: () => { void openExport() } }, '导出'),
            h('button', { className: 'mcpBtn', type: 'button', disabled: busy, onClick: () => { void openMigration() } }, '迁移明文凭据'),
          ),
          issuePanel,
          status ? h('span', {
            className: 'mcpStatus' + (busy ? ' mcpStatusBusy' : '') + (tone === 'bad' ? ' mcpStatusBad' : tone === 'ok' ? ' mcpStatusOk' : ''),
          }, status) : null,
        ),
        ),
        connector === null ? null : h(ConnectorDialog, {
          form: connector.form,
          mode: connector.index < 0 ? 'add' : 'edit',
          busy,
          onChange: (form) => setConnector((prev) => (prev === null ? prev : { ...prev, form })),
          onClose: () => setConnector(null),
          onSave: saveConnector,
        }),
        importDraft === null ? null : h(ImportDialog, {
          draft: importDraft,
          busy,
          onParse: (json, mode) => { void openImport(json, mode) },
          onClose: () => setImportDraft(null),
          onApply: applyImport,
        }),
        exportDraft === null ? null : h(ExportDialog, {
          draft: exportDraft,
          scope,
          onClose: () => setExportDraft(null),
        }),
        migration === null ? null : h(MigrationDialog, {
          plan: migration,
          busy,
          onClose: () => setMigration(null),
          onApply: applyMigration,
        }),
      )
    }


    /**
     * 导入对话框：粘贴 JSON，先预校验，再决定是否写入。
     * @param {{ draft: object, busy: boolean, onParse: Function, onClose: Function, onApply: Function }} props
     */
    function ImportDialog({ draft, busy, onParse, onClose, onApply }) {
      const [text, setText] = React.useState(draft.json)
      const [mode, setMode] = React.useState(draft.mode || 'merge')
      const parsed = draft.parsed

      React.useEffect(() => {
        const onKey = (event) => { if (event.key === 'Escape') onClose() }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [onClose])

      const summary = parsed && parsed.summary
      return createPortal(h('div', {
        className: 'dsb-modal-back',
        onMouseDown: (event) => { if (event.target === event.currentTarget && !busy) onClose() },
      },
        h('div', { className: 'dsb-modal mcpConnector', role: 'dialog', 'aria-modal': 'true' },
          h('div', { className: 'mcpDlgHead' },
            h('div', null,
              h('h2', null, '导入 mcpServers JSON'),
              h('p', { className: 'mcpDlgSub' }, '支持 { "mcpServers": { ... } } 结构，也支持 servers / connections 数组。整份内容会先整体校验，有一条不合法就不会写入。')),
            h('button', { className: 'mcpDlgClose', type: 'button', 'aria-label': '关闭', onClick: onClose }, '×')),
          h('label', { className: 'mcpField mcpFieldPlain' },
            h('span', { className: 'mcpLabel' }, 'JSON'),
            h('textarea', {
              className: 'mcpInput mcpMono',
              rows: 12,
              value: text,
              autoFocus: true,
              placeholder: '{ "mcpServers": { "github": { "url": "https://api.githubcopilot.com/mcp/", "headers": { "Authorization": "${GITHUB_TOKEN}" } } } }',
              onChange: (event) => setText(event.target.value),
            })),
          h('div', { className: 'mcpPair' },
            selectField('冲突处理', mode, (next) => { setMode(next); if (text.trim() !== '') onParse(text, next) }, [
              h('option', { value: 'merge', key: 'merge' }, '同名覆盖'),
              h('option', { value: 'skip', key: 'skip' }, '跳过同名'),
              h('option', { value: 'rename', key: 'rename' }, '同名自动加后缀'),
            ], { noHintReserve: true }),
            h('button', {
              className: 'mcpBtn', type: 'button', disabled: busy || text.trim() === '',
              onClick: () => onParse(text, mode),
            }, '解析')),
          draft.error === '' ? null : h('p', { className: 'mcpError' }, draft.error),
          summary === undefined || summary === null ? null : h('p', { className: 'mcpDiagText' },
            `将新增 ${summary.added} · 覆盖 ${summary.replaced} · 跳过 ${summary.skipped} · 改名 ${summary.renamed}`),
          !Array.isArray(draft.parsed && draft.parsed.issues) || draft.parsed.issues.length === 0
            ? null
            : h('ul', { className: 'mcpIssues' }, draft.parsed.issues.map((issue, i) => h('li', {
                key: i,
                'data-blocking': true,
              }, issue.message))),
          h('p', { className: 'mcpHint' }, '${VAR} 形式的值会被识别成环境变量引用，token 本身不会写进配置文件。'),
          h('div', { className: 'mcpDlgActions' },
            h('button', { className: 'mcpBtn', type: 'button', disabled: busy, onClick: onClose }, '取消'),
            h('button', {
              className: 'mcpBtn mcpPrimary',
              type: 'button',
              disabled: busy || parsed === null || parsed === undefined,
              onClick: onApply,
            }, busy ? '写入中…' : '写入'))),
        document.body))
    }

    /**
     * 导出对话框：展示脱敏后的 JSON，供复制。
     * @param {{ draft: object, scope: string, onClose: Function }} props
     */
    function ExportDialog({ draft, scope, onClose }) {
      const [copied, setCopied] = React.useState(false)
      const copy = async () => {
        try {
          await navigator.clipboard.writeText(draft.json)
          setCopied(true)
        } catch (error) {
          setCopied(false)
        }
      }
      return createPortal(h('div', {
        className: 'dsb-modal-back',
        onMouseDown: (event) => { if (event.target === event.currentTarget) onClose() },
      },
        h('div', { className: 'dsb-modal mcpConnector', role: 'dialog', 'aria-modal': 'true' },
          h('div', { className: 'mcpDlgHead' },
            h('div', null,
              h('h2', null, `导出${MCP_SCOPE_LABELS[scope]}配置`),
              h('p', { className: 'mcpDlgSub' }, `共 ${draft.count} 条，已脱敏 ${draft.redacted} 处。凭据、本地路径与 URL 查询参数都不会出现在这里。`)),
            h('button', { className: 'mcpDlgClose', type: 'button', 'aria-label': '关闭', onClick: onClose }, '×')),
          h('textarea', { className: 'mcpInput mcpMono', rows: 16, readOnly: true, value: draft.json }),
          h('div', { className: 'mcpDlgActions' },
            h('button', { className: 'mcpBtn', type: 'button', onClick: () => { void copy() } }, copied ? '已复制' : '复制'),
            h('button', { className: 'mcpBtn mcpPrimary', type: 'button', onClick: onClose }, '关闭'))),
        document.body))
    }

    /**
     * 明文凭据搬家对话框：先看清单（不含凭据本身），再决定是否写入 ~/.dsh/.env。
     * @param {{ plan: object, busy: boolean, onClose: Function, onApply: Function }} props
     */
    function MigrationDialog({ plan, busy, onClose, onApply }) {
      const moves = plan.moves || []
      const refusals = plan.refusals || []
      return createPortal(h('div', {
        className: 'dsb-modal-back',
        onMouseDown: (event) => { if (event.target === event.currentTarget && !busy) onClose() },
      },
        h('div', { className: 'dsb-modal mcpConnector', role: 'dialog', 'aria-modal': 'true' },
          h('div', { className: 'mcpDlgHead' },
            h('div', null,
              h('h2', null, '把明文凭据搬进环境变量'),
              h('p', { className: 'mcpDlgSub' }, '凭据会写入下面这个文件，配置里只留下变量名引用。凭据本身不会显示在这个页面上，也不会进快照和导出。')),
            h('button', { className: 'mcpDlgClose', type: 'button', 'aria-label': '关闭', onClick: onClose }, '×')),
          h('p', { className: 'mcpHint' }, '目标文件：' + plan.file),
          moves.length === 0
            ? h('p', { className: 'mcpEmpty' }, '没有可以自动搬移的凭据。')
            : h('div', { className: 'mcpList' }, moves.map((move, index) => h('article', { className: 'mcpSnapRow', key: index },
                h('div', { className: 'mcpSnapMain' },
                  h('span', { className: 'mcpName' }, move.name + ' · ' + move.key),
                  h('span', { className: 'mcpEndpoint' },
                    `${move.variable} · ${move.effect === 'add' ? '新增' : '覆盖已有值'} · 值 ${String(move.length)} 字符`)),
                h('span', { className: 'mcpDiagBadge' }, MCP_SCOPE_LABELS[move.scope])))),
          refusals.length === 0 ? null : h(React.Fragment, null,
            h('p', { className: 'mcpHint' }, '下面这些需要你手动改：'),
            h('ul', { className: 'mcpIssues' }, refusals.map((item, index) => h('li', { key: index, 'data-blocking': true },
              `${item.name} · ${item.key}：${item.reason}`)))),
          h('p', { className: 'mcpHint' }, 'DSH 只在启动时读这个文件，所以写完之后要重启 dsh web，凭据才会生效。'),
          h('div', { className: 'mcpDlgActions' },
            h('button', { className: 'mcpBtn', type: 'button', disabled: busy, onClick: onClose }, '取消'),
            h('button', {
              className: 'mcpBtn mcpPrimary',
              type: 'button',
              disabled: busy || moves.length === 0,
              onClick: onApply,
            }, busy ? '写入中…' : '写入并改写配置'))),
        document.body))
    }

    function mcpT(key) {
      return LOCALES.zh[key] || key
    }

    const TOOL_TABS = [
      { id: 'skills', label: '技能', add: '+ 添加技能', empty: '还没有技能。' },
      { id: 'experts', label: '专家团', add: '+ 添加专家', empty: '还没有专家。' },
      { id: 'mcp', label: 'MCP', add: '+ 添加 MCP', empty: '' },
      { id: 'memory', label: '记忆', add: '+ 添加记忆', empty: '还没有记忆。' },
      { id: 'links', label: '链接器', add: '+ 添加链接器', empty: '还没有链接器。' },
    ]

    function toolMark(name, round) {
      const letter = (name || '').trim().slice(0, 1) || '·'
      return h('span', { className: 'tbMark' + (round ? ' tbMarkRound' : ''), 'aria-hidden': 'true' }, letter)
    }

    function toolSwitch(checked, onChange, label) {
      return h('label', { className: 'mcpSwitch' },
        h('input', {
          type: 'checkbox',
          className: 'mcpSwitchInput',
          checked,
          'aria-label': label,
          onChange: (event) => onChange(event.target.checked),
        }),
        h('span', { className: 'mcpSwitchTrack' },
          h('span', { className: 'mcpSwitchThumb' }),
        ))
    }

    const SKILL_SCOPE = { project: '项目级', global: '全局级', custom: '自定义', bundled: '随包' }

    function flattenSkills(body) {
      if (Array.isArray(body)) return body
      const grouped = groupSkillResponse(body)
      return [
        ...grouped.projects.flatMap((project) => project.skills),
        ...grouped.global,
      ]
    }

    async function requestSkills(cwd) {
      const query = cwd === '' ? '' : `?cwd=${encodeURIComponent(cwd)}`
      const res = await fetch(`/api/dsh-sidebar/skills${query}`, { headers: { accept: 'application/json' } })
      const body = await res.json()
      if (!res.ok) throw new Error(typeof body?.error === 'string' ? body.error : '读取技能失败')
      return flattenSkills(body)
    }

    function groupSkillResponse(body) {
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        return {
          projects: Array.isArray(body.projects) ? body.projects : [],
          global: Array.isArray(body.global) ? body.global : [],
        }
      }
      const projects = new Map()
      const global = []
      for (const skill of Array.isArray(body) ? body : []) {
        if (skill?.scope === 'project') {
          const dir = String(skill.sourceDir || '').replaceAll('\\', '/')
          const marker = dir.includes('/.dsh/skills') ? '/.dsh/skills' : dir.includes('/.agents/skills') ? '/.agents/skills' : ''
          const root = marker === '' ? '' : dir.slice(0, dir.indexOf(marker))
          const name = root.split('/').filter(Boolean).pop() || '当前项目'
          const key = root || name
          const group = projects.get(key) || { root: key, name, skills: [] }
          group.skills.push(skill)
          projects.set(key, group)
        } else {
          global.push(skill)
        }
      }
      return { projects: [...projects.values()], global }
    }

    const MEMORY_NS = 'dsh-sidebar-memory'
    const MEMORY_KIND_LABELS = { preference: '偏好', fact: '事实', decision: '决策', entity: '实体', convention: '约定' }
    const MEMORY_KINDS = ['preference', 'fact', 'decision', 'entity', 'convention']

    function memoryKindLabel(kind) {
      return MEMORY_KIND_LABELS[kind] || kind
    }

    async function memoryRequest(path, init) {
      const headers = init && init.body !== undefined
        ? { accept: 'application/json', 'content-type': 'application/json' }
        : { accept: 'application/json' }
      const res = await fetch('/api/dsh-sidebar/memory' + path, { ...init, headers })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(typeof body?.error === 'string' ? body.error : '记忆接口调用失败')
      return body
    }

    function memoryModeText(config) {
      if (config === undefined || config === null) return '读取中…'
      if (config.enabled !== true) return '记忆功能已关闭'
      if (config.mode === 'external') return config.externalKind === 'mcp' ? '外部存储 · MCP' : '外部存储 · HTTP'
      return '本地存储 · SQLite'
    }

    function memoryEmbeddingText(state) {
      const config = state?.config
      if (config === undefined || config === null || config.embeddingEnabled !== true) return ''
      const observed = state?.embedding?.observed
      const configured = Number(state?.embedding?.configured) || 0
      if (typeof observed !== 'number' || observed <= 0) return configured > 0 ? `维度 ${String(configured)}` : ''
      return configured === observed || configured === 0
        ? `维度 ${String(observed)}`
        : `维度 ${String(configured)} → ${String(observed)}`
    }

    function memoryDiagnosticsText(diagnostics) {
      if (diagnostics === undefined || diagnostics === null) return ''
      const parts = [`会话事件 ${diagnostics.events ?? 0}`, `轮询 ${diagnostics.sweeps ?? 0}`]
      const last = diagnostics.lastExtract
      if (last === undefined || last === null) parts.push('尚未提炼')
      else if (last.ok === true) parts.push(`最近提炼 ${String(last.count ?? 0)} 条`)
      else parts.push(`提炼失败：${last.error ?? '未知错误'}`)
      const wiring = diagnostics.wiring
      if (wiring !== undefined && wiring !== null) {
        const missing = ['tools', 'systemPrompt', 'agents', 'llm', 'settings'].filter((name) => wiring[name] !== true)
        if (missing.length > 0) parts.push(`未接入：${missing.join('/')}`)
      }
      const recall = diagnostics.recall
      if (recall !== undefined && recall !== null) {
        parts.push(recall.standingChars > 0
          ? `注入：长期偏好 ${String(recall.standingChars)} 字 · 会话块 ${String(recall.sessions ?? 0)}`
          : '注入：暂无稳定偏好')
      }
      return parts.join(' · ')
    }

    function memoryField(label, hint, control) {
      return h('label', { className: 'mcpField' },
        h('span', { className: 'mcpLabel' }, label),
        hint ? h('span', { className: 'mcpFieldHint' }, hint) : null,
        control)
    }

    function memoryTextInput(value, onChange, placeholder, type) {
      return h('input', {
        className: 'mcpInput',
        type: type || 'text',
        value: value === undefined || value === null ? '' : String(value),
        placeholder: placeholder || '',
        onChange: (event) => onChange(event.target.value),
      })
    }

    function memorySeg(options, value, onChange) {
      return h('div', { className: 'memSeg', role: 'tablist' },
        options.map((option) => h('button', {
          key: option.value,
          type: 'button',
          role: 'tab',
          'data-active': value === option.value,
          'aria-selected': value === option.value,
          onClick: () => onChange(option.value),
        }, option.label)))
    }

    function MemoryDraftDialog({ draft, busy, onChange, onClose, onSave }) {
      return createPortal(h('div', {
        className: 'dsb-modal-back',
        onMouseDown: (event) => { if (event.target === event.currentTarget && !busy) onClose() },
      },
        h('form', { className: 'dsb-modal memModal', role: 'dialog', 'aria-modal': 'true', onSubmit: onSave },
          h('h2', null, draft.id === '' ? '添加记忆' : '编辑记忆'),
          memoryField('内容', '一条事实，一句话', h('textarea', {
            value: draft.content,
            autoFocus: true,
            placeholder: '例如：这个项目统一使用 pnpm，不用 npm',
            onChange: (event) => onChange({ ...draft, content: event.target.value }),
          })),
          memoryField('类型', '', memorySeg(
            MEMORY_KINDS.map((kind) => ({ value: kind, label: memoryKindLabel(kind) })),
            draft.kind,
            (kind) => onChange({ ...draft, kind }),
          )),
          memoryField('标签', '用逗号分隔，可留空', memoryTextInput(draft.tags, (tags) => onChange({ ...draft, tags }), '例如：工具链, 构建')),
          h('div', { className: 'dsb-modal-actions' },
            h('button', { type: 'submit', disabled: busy || draft.content.trim() === '' }, busy ? '保存中…' : '保存'),
            h('button', { type: 'button', disabled: busy, onClick: onClose }, '取消')))),
      document.body)
    }

    function MemoryPanel({ openAddRef, onToast }) {
      const [state, setState] = React.useState(null)
      const [items, setItems] = React.useState([])
      const [query, setQuery] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [draft, setDraft] = React.useState(null)
      const [ready, setReady] = React.useState(false)

      const load = React.useCallback(async (text) => {
        setBusy(true)
        setError('')
        try {
          const next = await memoryRequest('/state')
          setState(next)
          const suffix = text === '' ? '?limit=100' : `?limit=100&q=${encodeURIComponent(text)}`
          const list = await memoryRequest('/list' + suffix)
          setItems(Array.isArray(list?.items) ? list.items : [])
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason))
        } finally {
          setBusy(false)
          setReady(true)
        }
      }, [])

      React.useEffect(() => { void load('') }, [load])

      React.useEffect(() => {
        if (openAddRef === undefined || openAddRef === null) return undefined
        openAddRef.current = () => setDraft({ id: '', kind: 'fact', content: '', tags: '' })
        return () => { openAddRef.current = () => {} }
      }, [openAddRef])

      const tagsOf = (value) => value.split(/[，,]/).map((tag) => tag.trim()).filter((tag) => tag !== '')

      const saveDraft = async (event) => {
        event.preventDefault()
        if (draft === null || draft.content.trim() === '') return
        setBusy(true)
        setError('')
        try {
          const tags = tagsOf(draft.tags)
          if (draft.id === '') {
            await memoryRequest('/write', {
              method: 'POST',
              body: JSON.stringify({ content: draft.content.trim(), kind: draft.kind, tags }),
            })
          } else {
            await memoryRequest('/update', {
              method: 'POST',
              body: JSON.stringify({ id: draft.id, content: draft.content.trim(), kind: draft.kind, tags }),
            })
          }
          setDraft(null)
          await load(query)
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason))
        } finally {
          setBusy(false)
        }
      }

      const removeItem = async (item) => {
        setBusy(true)
        setError('')
        try {
          await memoryRequest('/remove', { method: 'POST', body: JSON.stringify({ id: item.id }) })
          await load(query)
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason))
        } finally {
          setBusy(false)
        }
      }

      const copyItem = async (item) => {
        try {
          await navigator.clipboard.writeText(item.content)
          if (typeof onToast === 'function') onToast('已复制这条记忆')
        } catch {
          setError('复制失败，请手动选择文本。')
        }
      }

      const dedupe = async () => {
        setBusy(true)
        setError('')
        try {
          const result = await memoryRequest('/dedupe', { method: 'POST', body: '{}' })
          await load(query)
          const removed = Number(result?.removed) || 0
          if (typeof onToast === 'function') onToast(removed > 0 ? `已合并 ${String(removed)} 条重复记忆` : '没有发现重复记忆')
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason))
        } finally {
          setBusy(false)
        }
      }

      const health = state?.health
      const rows = items.length === 0
        ? h('p', { className: 'tbEmpty' }, ready ? (query === '' ? '还没有记忆。' : '没有匹配的记忆。') : '读取中…')
        : h('div', { className: 'memList' }, items.map((item) => h('article', { className: 'memRow', key: item.id },
          h('div', { className: 'memRowMain' },
            h('div', { className: 'memRowHead' },
              h('span', { className: 'memKind' }, memoryKindLabel(item.kind)),
              item.tags.length === 0 ? null : h('span', { className: 'memSub' }, item.tags.join(' · ')),
              h('span', { className: 'memSub' }, relativeTime(Number(item.updatedAt) || Date.now(), Date.now()) + '前')),
            h('p', { className: 'memContent' }, item.content)),
          h('div', { className: 'memActions' },
            h('button', {
              className: 'mcpIconBtn', type: 'button', 'aria-label': '编辑',
              onClick: () => setDraft({ id: item.id, kind: item.kind, content: item.content, tags: item.tags.join(', ') }),
            }, '✎'),
            h('button', {
              className: 'mcpIconBtn', type: 'button', 'aria-label': '复制',
              onClick: () => { void copyItem(item) },
            }, '⧉'),
            h('button', {
              className: 'mcpIconBtn', type: 'button', 'aria-label': '删除',
              onClick: () => { void removeItem(item) },
            }, '×')))))

      const diagnostics = memoryDiagnosticsText(state?.diagnostics)
      const extractFailed = state?.diagnostics?.lastExtract?.ok === false

      return h('div', { className: 'memPane' },
        h('div', { className: 'memMeta' },
          h('span', { className: 'memDot', 'data-ok': health?.ok === true }),
          h('span', null, memoryModeText(state?.config)),
          h('span', null, typeof state?.count === 'number' && state.count >= 0 ? `${String(state.count)} 条` : ''),
          memoryEmbeddingText(state) === '' ? null : h('span', null, memoryEmbeddingText(state)),
          state?.database ? h('span', null, `数据库：${state.database}`) : null,
          health?.detail ? h('span', null, health.detail) : null),
        diagnostics === '' ? null : h('p', {
          className: extractFailed ? 'memError' : 'memHint',
          role: extractFailed ? 'alert' : undefined,
        }, diagnostics),
        h('form', { className: 'memBar', onSubmit: (event) => { event.preventDefault(); void load(query) } },
          h('input', {
            className: 'memSearch',
            value: query,
            placeholder: '搜索记忆，回车确认',
            onChange: (event) => setQuery(event.target.value),
          }),
          h('button', { className: 'mcpBtn', type: 'submit', disabled: busy }, '搜索'),
          query === '' ? null : h('button', {
            className: 'mcpBtn mcpBtnGhost', type: 'button',
            onClick: () => { setQuery(''); void load('') },
          }, '清除'),
          h('button', {
            className: 'mcpBtn mcpBtnGhost', type: 'button', disabled: busy,
            title: '把同一件事的不同表述合并成一条',
            onClick: () => { void dedupe() },
          }, '合并重复')),
        error === '' ? null : h('p', { className: 'memError', role: 'alert' }, error),
        rows,
        h('p', { className: 'memHint' }, '存储位置、向量嵌入与自动提炼开关在「设置 → 插件 → 插件配置 → 记忆」里管理。'),
        draft === null ? null : h(MemoryDraftDialog, {
          draft,
          busy,
          onChange: setDraft,
          onClose: () => { if (!busy) setDraft(null) },
          onSave: saveDraft,
        }))
    }

    function MemorySettingsCard() {
      const [state, setState] = React.useState(null)
      const [form, setForm] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [open, setOpen] = React.useState(false)
      const [mountedServers, setMountedServers] = React.useState([])
      const fetchedServers = React.useRef(false)

      React.useEffect(() => {
        if (fetchedServers.current || form?.mode !== 'external' || form?.externalKind !== 'mcp') return
        fetchedServers.current = true
        fetch('/mcp-settings/servers', { headers: { accept: 'application/json' } })
          .then((res) => res.json())
          .then((body) => {
            const list = Array.isArray(body?.servers) ? body.servers : []
            setMountedServers(list.filter((item) => (
              item?.enabled === true && item?.transport === 'streamable-http' && typeof item.url === 'string' && item.url !== ''
            )))
          })
          .catch(() => {})
      }, [form?.mode, form?.externalKind])

      const load = React.useCallback(async () => {
        setBusy(true)
        setError('')
        try {
          const next = await memoryRequest('/state')
          setState(next)
          setForm({ ...next.config, embeddingApiKey: '', externalApiKey: '' })
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason))
        } finally {
          setBusy(false)
        }
      }, [])

      React.useEffect(() => { void load() }, [load])

      const set = (key, value) => setForm((current) => (current === null ? current : { ...current, [key]: value }))

      const save = async () => {
        if (form === null) return
        setBusy(true)
        setError('')
        setNotice('')
        try {
          const body = { ...form }
          if (body.embeddingApiKey === '') delete body.embeddingApiKey
          if (body.externalApiKey === '') delete body.externalApiKey
          const next = await memoryRequest('/config', { method: 'POST', body: JSON.stringify(body) })
          setState(next)
          setForm({ ...next.config, embeddingApiKey: '', externalApiKey: '' })
          setNotice('已保存')
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason))
        } finally {
          setBusy(false)
        }
      }

      const reembed = async () => {
        setBusy(true)
        setError('')
        setNotice('')
        try {
          const result = await memoryRequest('/reembed', { method: 'POST', body: '{}' })
          setNotice(`向量重建完成：成功 ${String(result?.updated ?? 0)}，失败 ${String(result?.failed ?? 0)}`)
          await load()
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason))
        } finally {
          setBusy(false)
        }
      }

      if (form === null) {
        return h('li', { className: 'memCard' },
          h('div', { className: 'memCardHead' }, h('h3', { className: 'memCardTitle' }, '记忆')),
          error === '' ? h('p', { className: 'memHint' }, '读取中…') : h('p', { className: 'memError' }, error))
      }

      const external = form.mode === 'external'
      const health = state?.health
      const cardExtractFailed = state?.diagnostics?.lastExtract?.ok === false

      return h('li', { className: 'memCard' },
        h('div', { className: 'memCardHead' },
          h('button', {
            className: 'memCardToggle',
            type: 'button',
            'aria-expanded': open,
            onClick: () => setOpen((current) => !current),
          },
            h('span', { className: 'memCardTitleWrap' },
              h('span', { className: 'memCardTitle' }, '记忆'),
              h('span', { className: 'memCardDesc' }, '跨会话记住偏好、约定与决策。')),
            h('span', { className: 'memChevron' + (open ? ' memChevronUp' : ''), 'aria-hidden': 'true' }))),
        !open ? null : h('div', { className: 'memCardBody' },
        h('label', { className: 'mcpSwitchRow' },
          h('div', { className: 'mcpSwitchInfo' },
            h('span', { className: 'mcpSwitchLabel' }, '启用记忆'),
            h('span', { className: 'mcpSwitchHint' }, '关闭后不再提炼、不再注入；已有记忆保留')),
          h('label', { className: 'mcpSwitch' },
            h('input', {
              type: 'checkbox',
              className: 'mcpSwitchInput',
              checked: form.enabled === true,
              'aria-label': '启用记忆',
              onChange: (event) => set('enabled', event.target.checked),
            }),
            h('span', { className: 'mcpSwitchTrack' }, h('span', { className: 'mcpSwitchThumb' })))),
        h('div', { className: 'memMeta' },
          h('span', { className: 'memDot', 'data-ok': health?.ok === true }),
          h('span', null, memoryModeText(form)),
          h('span', null, typeof state?.count === 'number' && state.count >= 0 ? `${String(state.count)} 条记忆` : ''),
          memoryEmbeddingText(state) === '' ? null : h('span', null, memoryEmbeddingText(state)),
          health?.ok === false && health.detail ? h('span', null, health.detail) : null),
        cardExtractFailed && state?.diagnostics?.lastExtract?.error
          ? h('p', { className: 'memError', role: 'alert' }, `提炼失败：${state.diagnostics.lastExtract.error}`)
          : null,
        memoryField('存储方式', '', memorySeg([
          { value: 'local', label: '本地存储' },
          { value: 'external', label: '外部存储' },
        ], form.mode, (mode) => set('mode', mode))),
        external
          ? h(React.Fragment, null,
            memoryField('外部协议', '', memorySeg([
              { value: 'http', label: 'HTTP REST' },
              { value: 'mcp', label: 'MCP' },
            ], form.externalKind, (kind) => set('externalKind', kind))),
            form.externalKind === 'mcp' && mountedServers.length > 0
              ? memoryField('选择已挂载的服务', '工具名会自动识别，无需填写', h('select', {
                className: 'mcpInput',
                value: '',
                onChange: (event) => {
                  const picked = mountedServers.find((item) => item.id === event.target.value)
                  if (picked?.url !== undefined) set('externalBaseURL', picked.url)
                },
              },
                h('option', { value: '' }, '从已挂载的 MCP 服务选择…'),
                mountedServers.map((item) => h('option', { key: item.id, value: item.id }, `${item.id}（${item.url}）`))))
              : null,
            memoryField('服务地址', '', memoryTextInput(form.externalBaseURL, (value) => set('externalBaseURL', value), form.externalKind === 'mcp' ? 'MCP 端点' : 'Mem0 风格根地址')),
            h('div', { className: 'memGrid2' },
              memoryField('访问令牌', '', memoryTextInput(form.externalApiKey, (value) => set('externalApiKey', value), '已保存则留空', 'password')),
              memoryField('命名空间', '', memoryTextInput(form.externalNamespace, (value) => set('externalNamespace', value), 'dsh'))),
            form.externalKind === 'mcp'
              ? h('p', { className: 'memHint' }, '连接后会通过 tools/list 自动识别检索与写入工具；工具已在「工具箱 → MCP」里挂载的服务可直接选择。')
              : null)
          : h(React.Fragment, null,
            memoryField('数据库路径', '', h('div', { className: 'memPath' }, state?.database ?? '~/.dsh/dsh-sidebar/memory/memory.sqlite'))),
        !external
          ? h(React.Fragment, null,
            h('label', { className: 'mcpSwitchRow' },
              h('div', { className: 'mcpSwitchInfo' },
                h('span', { className: 'mcpSwitchLabel' }, '向量检索'),
                h('span', { className: 'mcpSwitchHint' }, '用 OpenAI 兼容的 /embeddings 接口，未配置时只用全文检索')),
              h('label', { className: 'mcpSwitch' },
                h('input', {
                  type: 'checkbox',
                  className: 'mcpSwitchInput',
                  checked: form.embeddingEnabled === true,
                  'aria-label': '向量检索',
                  onChange: (event) => set('embeddingEnabled', event.target.checked),
                }),
                h('span', { className: 'mcpSwitchTrack' }, h('span', { className: 'mcpSwitchThumb' })))),
            form.embeddingEnabled !== true
              ? null
              : h(React.Fragment, null,
                memoryField('嵌入地址', '', memoryTextInput(form.embeddingBaseURL, (value) => set('embeddingBaseURL', value), 'https://api.openai.com/v1')),
                h('div', { className: 'memRow2' },
                  memoryField('嵌入模型', '', memoryTextInput(form.embeddingModel, (value) => set('embeddingModel', value), 'text-embedding-v4')),
                  memoryField('维度', '0 = 跟随接口', memoryTextInput(form.embeddingDim, (value) => set('embeddingDim', Number(value) || 0), '0', 'number'))),
                memoryField('访问令牌', '', memoryTextInput(form.embeddingApiKey, (value) => set('embeddingApiKey', value), '已保存则留空', 'password'))))
          : null,
        memoryField('融合方式', '', memorySeg([
          { value: 'rrf', label: 'RRF 融合' },
          { value: 'vector', label: '仅向量' },
          { value: 'fulltext', label: '仅全文' },
        ], form.fusion, (fusion) => set('fusion', fusion))),
        h('div', { className: 'memRow2' },
          memoryField('召回条数', '', memoryTextInput(form.recallTopK, (value) => set('recallTopK', Number(value) || 5), '5', 'number')),
          memoryField('提炼模型', '留空用默认模型', memoryTextInput(form.extractModel, (value) => set('extractModel', value), '默认模型'))),
        memoryField('提炼模式', form.extractMode === 'explicit' ? '只在你说「记住…」时提炼' : '每轮对话结束都提炼', memorySeg([
          { value: 'auto', label: '每轮自动' },
          { value: 'explicit', label: '仅明确要求' },
        ], form.extractMode, (mode) => set('extractMode', mode))),
        form.extractMode !== 'explicit'
          ? null
          : memoryField('触发词', '', memoryTextInput(form.extractKeywords, (value) => set('extractKeywords', value), '记住, 记一下, 别忘了')),
        memoryField('提炼来源', '', memorySeg([
          { value: 'user', label: '只读我的发言' },
          { value: 'both', label: '含助手发言' },
        ], form.extractSource, (source) => set('extractSource', source))),
        memoryField('允许类型', '逗号分隔；留空为全部', memoryTextInput(form.extractKinds, (value) => set('extractKinds', value), 'preference, fact, decision')),
        h('div', { className: 'memRow2' },
          memoryField('置信度下限', '', memoryTextInput(form.extractMinConfidence, (value) => set('extractMinConfidence', Number(value) || 0.7), '0.7', 'number')),
          memoryField('单轮上限', '', memoryTextInput(form.extractMax, (value) => set('extractMax', Number(value) || 5), '5', 'number'))),
        memoryField('额外关注', '', memoryTextInput(form.extractFocus, (value) => set('extractFocus', value), '该记什么，例如：只记医疗相关偏好')),
        memoryField('额外排除', '', memoryTextInput(form.extractExclude, (value) => set('extractExclude', value), '不要记什么，例如：时间安排')),
        h('label', { className: 'mcpSwitchRow' },
          h('div', { className: 'mcpSwitchInfo' },
            h('span', { className: 'mcpSwitchLabel' }, '自动提炼'),
            h('span', { className: 'mcpSwitchHint' }, '总开关；关掉后只剩 Agent 工具与手动新增会写库')),
          h('label', { className: 'mcpSwitch' },
            h('input', {
              type: 'checkbox',
              className: 'mcpSwitchInput',
              checked: form.autoExtract === true,
              'aria-label': '自动提炼',
              onChange: (event) => set('autoExtract', event.target.checked),
            }),
            h('span', { className: 'mcpSwitchTrack' }, h('span', { className: 'mcpSwitchThumb' })))),
        h('label', { className: 'mcpSwitchRow' },
          h('div', { className: 'mcpSwitchInfo' },
            h('span', { className: 'mcpSwitchLabel' }, '自动召回'),
            h('span', { className: 'mcpSwitchHint' }, '每轮按当前输入检索相关记忆并注入上下文')),
          h('label', { className: 'mcpSwitch' },
            h('input', {
              type: 'checkbox',
              className: 'mcpSwitchInput',
              checked: form.autoRecall === true,
              'aria-label': '自动召回',
              onChange: (event) => set('autoRecall', event.target.checked),
            }),
            h('span', { className: 'mcpSwitchTrack' }, h('span', { className: 'mcpSwitchThumb' })))),
        error === '' ? null : h('p', { className: 'memError', role: 'alert' }, error),
        notice === '' ? null : h('p', { className: 'memHint' }, notice),
        h('div', { className: 'memFoot' },
          !external && form.embeddingEnabled === true
            ? h('button', { className: 'mcpBtn', type: 'button', disabled: busy, onClick: () => { void reembed() } }, '重建向量')
            : null,
          h('button', { className: 'mcpBtn', type: 'button', disabled: busy, onClick: () => { void load() } }, '放弃修改'),
          h('button', { className: 'mcpBtn mcpPrimary', type: 'button', disabled: busy, onClick: () => { void save() } }, busy ? '处理中…' : '保存'))))
    }

    function ToolboxPage({ onBack, projectCwd, listWorkspaces, subscribeWorkspaces }) {
      const [tab, setTab] = React.useState('skills')
      const [skillView, setSkillView] = React.useState('global')
      const [workspaces, setWorkspaces] = React.useState(() => listWorkspaces())
      const [activeWorkspaceId, setActiveWorkspaceId] = React.useState('')
      const [globalSkills, setGlobalSkills] = React.useState([])
      const [globalReady, setGlobalReady] = React.useState(false)
      const [projectSkills, setProjectSkills] = React.useState({})
      const [experts, setExperts] = React.useState([])
      const [links, setLinks] = React.useState([])
      const [draft, setDraft] = React.useState(null)
      const [skillDraft, setSkillDraft] = React.useState(null)
      const [toast, setToast] = React.useState('')
      const addMcp = React.useRef(() => {})
      const addMemory = React.useRef(() => {})
      const requestedPaths = React.useRef(new Set())
      const current = TOOL_TABS.find((item) => item.id === tab) || TOOL_TABS[0]
      const activeWorkspace = workspaces.find((item) => item.workspaceId === activeWorkspaceId) || null

      React.useEffect(() => {
        const sync = () => {
          const next = listWorkspaces()
          setWorkspaces((prev) => {
            const same = prev.length === next.length && prev.every((item, index) => (
              item.workspaceId === next[index].workspaceId
              && item.title === next[index].title
              && item.path === next[index].path
            ))
            return same ? prev : next
          })
        }
        sync()
        return subscribeWorkspaces(sync)
      }, [listWorkspaces, subscribeWorkspaces])

      React.useEffect(() => {
        setActiveWorkspaceId((prev) => {
          if (prev !== '' && workspaces.some((item) => item.workspaceId === prev)) return prev
          const cwd = projectCwd()
          const matched = workspaces.find((item) => item.path === cwd)
          return matched?.workspaceId || workspaces[0]?.workspaceId || ''
        })
      }, [workspaces, projectCwd])

      const loadGlobal = React.useCallback(async () => {
        const skills = await requestSkills('/')
        setGlobalSkills(skills.filter((item) => item.scope === 'global'))
        setGlobalReady(true)
      }, [])

      const loadProject = React.useCallback(async (path) => {
        const skills = await requestSkills(path)
        requestedPaths.current.add(path)
        setProjectSkills((prev) => ({ ...prev, [path]: skills.filter((item) => item.scope === 'project') }))
      }, [])

      React.useEffect(() => {
        let cancelled = false
        void loadGlobal().catch((error) => {
          if (cancelled) return
          setGlobalReady(true)
          setToast(error instanceof Error ? error.message : String(error))
        })
        return () => { cancelled = true }
      }, [loadGlobal])

      React.useEffect(() => {
        if (skillView !== 'project') return undefined
        let cancelled = false
        for (const workspace of workspaces) {
          if (workspace.path === '' || requestedPaths.current.has(workspace.path)) continue
          requestedPaths.current.add(workspace.path)
          void loadProject(workspace.path).catch((error) => {
            requestedPaths.current.delete(workspace.path)
            if (cancelled) return
            setToast(error instanceof Error ? error.message : String(error))
          })
        }
        return () => { cancelled = true }
      }, [skillView, workspaces, loadProject])

      React.useEffect(() => {
        if (toast === '') return undefined
        const timer = setTimeout(() => setToast(''), 4000)
        return () => clearTimeout(timer)
      }, [toast])

      const openAdd = () => {
        if (tab === 'mcp') {
          addMcp.current()
          return
        }
        if (tab === 'memory') {
          addMemory.current()
          return
        }
        if (tab === 'skills') {
          setSkillDraft({ scope: 'project', busy: false, dragging: false })
          return
        }
        setDraft({
          kind: tab,
          name: '',
          desc: '',
          auth: false,
        })
      }

      const confirmDraft = (event) => {
        event.preventDefault()
        if (draft === null || draft.name.trim() === '' || draft.kind === 'skills') return
        const item = {
          id: `${draft.kind}-${String(Date.now())}`,
          name: draft.name.trim(),
          desc: draft.desc.trim(),
          enabled: true,
          auth: draft.auth,
        }
        if (draft.kind === 'experts') setExperts((prev) => [...prev, item])
        else setLinks((prev) => [...prev, item])
        setDraft(null)
      }

      const toggleSkill = async (skill, enabled) => {
        const previous = skill.enabled
        const patchList = (list) => list.map((item) => item.sourceDir === skill.sourceDir ? { ...item, enabled } : item)
        setGlobalSkills((prev) => patchList(prev))
        setProjectSkills((prev) => {
          const next = {}
          for (const [path, list] of Object.entries(prev)) next[path] = patchList(list)
          return next
        })
        try {
          const res = await fetch('/api/dsh-sidebar/skills/toggle', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sourceDir: skill.sourceDir, enabled, cwd: activeWorkspace?.path || projectCwd() }),
          })
          const body = await res.json()
          if (!res.ok) throw new Error(typeof body?.error === 'string' ? body.error : '保存开关失败')
        } catch (error) {
          const rollback = (list) => list.map((item) => item.sourceDir === skill.sourceDir ? { ...item, enabled: previous } : item)
          setGlobalSkills((prev) => rollback(prev))
          setProjectSkills((prev) => {
            const next = {}
            for (const [path, list] of Object.entries(prev)) next[path] = rollback(list)
            return next
          })
          setToast(error instanceof Error ? error.message : String(error))
        }
      }

      const folderInputRef = React.useRef(null)
      const archiveInputRef = React.useRef(null)

      const doUpload = async (fileList) => {
        if (skillDraft === null || skillDraft.busy) return
        const files = Array.from(fileList || [])
        if (files.length === 0) return
        setSkillDraft({ ...skillDraft, busy: true })
        try {
          const fd = new FormData()
          fd.append('scope', skillDraft.scope)
          const cwd = skillDraft.scope === 'project' && activeWorkspace ? activeWorkspace.path : projectCwd()
          fd.append('cwd', cwd)
          fd.append('root', activeWorkspace?.path || '')
          const single = files.length === 1
          const looksArchive = single && /\.(zip|tar\.gz|tgz|tar)$/i.test(files[0].name)
          if (looksArchive) {
            fd.append('archive', files[0], files[0].name)
          } else {
            for (const f of files) fd.append('files', f, f.webkitRelativePath || f.name)
          }
          const res = await fetch('/api/dsh-sidebar/skills/upload', { method: 'POST', body: fd })
          const text = await res.text()
          let body
          try {
            body = text === '' ? {} : JSON.parse(text)
          } catch {
            throw new Error(text.trim() === 'not found' ? '上传接口还没生效，请先重启 dsh web' : (text.trim() || '上传失败'))
          }
          if (!res.ok) throw new Error(body?.error === 'already-installed' ? '这个技能已经安装过了' : (body?.error || '上传失败'))
          setSkillDraft(null)
          requestedPaths.current.delete('/')
          if (activeWorkspace) requestedPaths.current.delete(activeWorkspace.path)
          await loadGlobal()
          if (activeWorkspace) await loadProject(activeWorkspace.path)
        } catch (error) {
          setSkillDraft((currentDraft) => currentDraft === null ? null : { ...currentDraft, busy: false })
          setToast(error instanceof Error ? error.message : String(error))
        }
      }

      const cards = (items, setItems, round) => items.length === 0
        ? h('p', { className: 'tbEmpty' }, current.empty)
        : h('div', { className: 'tbGrid' }, items.map((item) => h('article', { className: 'tbCard', key: item.id },
          toolMark(item.name, round),
          h('div', { className: 'tbCardMain' },
            h('span', { className: 'tbCardName' }, item.name),
            item.desc === '' ? null : h('p', { className: 'tbCardDesc' }, item.desc),
          ),
          toolSwitch(item.enabled, (enabled) => {
            setItems((prev) => prev.map((row) => row.id === item.id ? { ...row, enabled } : row))
          }, item.enabled ? `停用${item.name}` : `启用${item.name}`),
        )))

      const renderSkillCard = (item) => h('article', { className: 'tbCard', key: item.sourceDir },
        toolMark(item.name, false),
        h('div', { className: 'tbCardMain' },
          h('span', { className: 'tbCardName' }, item.name),
          h('span', { className: 'tbScope' }, SKILL_SCOPE[item.scope] || item.scope),
          item.description ? h('p', { className: 'tbCardDesc' }, item.description) : null,
          item.shadowedBy ? h('p', { className: 'tbShadow' }, '已被项目级覆盖') : null,
        ),
        toolSwitch(item.enabled === true, (enabled) => { void toggleSkill(item, enabled) }, item.enabled ? `停用${item.name}` : `启用${item.name}`),
      )
      const skillGrid = (items, empty) => items.length === 0
        ? h('p', { className: 'tbEmpty' }, empty)
        : h('div', { className: 'tbGrid' }, items.map(renderSkillCard))
      const scopeBar = h('div', { className: 'tbScopeBar', role: 'tablist', 'aria-label': '技能范围' },
        h('button', {
          type: 'button',
          className: 'tbScopeBtn',
          role: 'tab',
          'data-active': skillView === 'global',
          'aria-selected': skillView === 'global',
          onClick: () => setSkillView('global'),
        }, '全局'),
        h('button', {
          type: 'button',
          className: 'tbScopeBtn',
          role: 'tab',
          'data-active': skillView === 'project',
          'aria-selected': skillView === 'project',
          onClick: () => setSkillView('project'),
        }, '工作区'),
      )
      const projectTabs = workspaces.length === 0 ? null : h('div', { className: 'tbProjTabs', role: 'tablist', 'aria-label': '工作区' },
        workspaces.map((workspace) => h('button', {
          key: workspace.workspaceId,
          type: 'button',
          className: 'tbProjTab',
          role: 'tab',
          'data-active': workspace.workspaceId === activeWorkspaceId,
          'aria-selected': workspace.workspaceId === activeWorkspaceId,
          onClick: () => setActiveWorkspaceId(workspace.workspaceId),
        }, workspace.title || workspace.path.split(/[/\\]/).filter(Boolean).pop() || workspace.path)),
      )
      const selectedProjectSkills = activeWorkspace ? projectSkills[activeWorkspace.path] : undefined
      const skillCards = skillView === 'global'
        ? h(React.Fragment, null,
          scopeBar,
          globalReady ? skillGrid(globalSkills, '还没有全局技能。') : h('p', { className: 'tbEmpty' }, '读取中…'),
        )
        : h(React.Fragment, null,
          scopeBar,
          workspaces.length === 0
            ? h('p', { className: 'tbEmpty' }, '还没有工作区。')
            : h(React.Fragment, null,
              projectTabs,
              selectedProjectSkills === undefined
                ? h('p', { className: 'tbEmpty' }, '读取中…')
                : skillGrid(selectedProjectSkills, '这个工作区还没有技能。'),
            ),
        )

      const linkRows = links.length === 0
        ? h('p', { className: 'tbEmpty' }, current.empty)
        : h('div', { className: 'tbList' }, links.map((item) => h('article', { className: 'tbRow', key: item.id },
          h('div', { className: 'tbRowMain' },
            h('span', { className: 'tbRowName' }, item.name),
            h('span', { className: 'tbRowMeta', 'data-on': item.auth }, item.auth ? '已授权' : '未授权'),
          ),
        )))

      return h('main', { className: 'dsb-page dsb-mcp' },
        h('button', { className: 'dsb-back dsb-back-top', type: 'button', onClick: onBack }, '← 返回对话'),
        h('div', { className: 'tbBar' },
          h('div', { className: 'tbTabs', role: 'tablist', 'aria-label': '工具箱' },
            TOOL_TABS.map((item) => h('button', {
              key: item.id,
              className: 'tbTab',
              type: 'button',
              role: 'tab',
              'data-active': tab === item.id,
              'aria-selected': tab === item.id,
              onClick: () => setTab(item.id),
            }, item.label))),
          h('button', { className: 'mcpBtn mcpBtnGhost', type: 'button', onClick: openAdd }, current.add),
        ),
        h('div', { className: 'tbPane', hidden: tab !== 'skills' }, skillCards),
        h('div', { className: 'tbPane', hidden: tab !== 'experts' }, cards(experts, setExperts, true)),
        h('div', { className: 'tbPane', hidden: tab !== 'mcp' },
          h(SettingsPanel, {
            t: mcpT,
            embedded: true,
            addAction: addMcp,
            projectCwd,
            workspaces,
            activeWorkspaceId,
            onSelectWorkspace: setActiveWorkspaceId,
          })),
        h('div', { className: 'tbPane', hidden: tab !== 'memory' },
          h(MemoryPanel, { openAddRef: addMemory, onToast: setToast })),
        h('div', { className: 'tbPane', hidden: tab !== 'links' }, linkRows),
        draft === null ? null : createPortal(h('div', {
          className: 'dsb-modal-back',
          onMouseDown: (event) => { if (event.target === event.currentTarget) setDraft(null) },
        },
          h('form', {
            className: 'dsb-modal',
            role: 'dialog',
            'aria-modal': 'true',
            onSubmit: confirmDraft,
          },
            h('h2', null, current.add.replace('+ ', '')),
            h('label', { className: 'dsb-field' }, '名称',
              h('input', {
                value: draft.name,
                autoFocus: true,
                onChange: (event) => setDraft({ ...draft, name: event.target.value }),
              })),
            draft.kind === 'links'
              ? h('label', { className: 'dsb-field' }, '授权状态',
                h('select', {
                  value: draft.auth ? 'on' : 'off',
                  onChange: (event) => setDraft({ ...draft, auth: event.target.value === 'on' }),
                },
                  h('option', { value: 'off' }, '未授权'),
                  h('option', { value: 'on' }, '已授权')))
              : h('label', { className: 'dsb-field' }, draft.kind === 'experts' ? '简介' : '描述',
                h('input', {
                  value: draft.desc,
                  onChange: (event) => setDraft({ ...draft, desc: event.target.value }),
                })),
            h('div', { className: 'dsb-modal-actions' },
              h('button', { type: 'submit', disabled: draft.name.trim() === '' }, '添加'),
              h('button', { type: 'button', onClick: () => setDraft(null) }, '取消')))), document.body),
        skillDraft === null ? null : createPortal(h('div', {
          className: 'dsb-modal-back',
          onMouseDown: (event) => { if (event.target === event.currentTarget && !skillDraft.busy) setSkillDraft(null) },
        },
          h('div', { className: 'dsb-modal tbUpload', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tb-upload-title' },
            h('div', { className: 'tbUploadHead' },
              h('h2', { id: 'tb-upload-title' }, '上传技能'),
              h('button', {
                type: 'button',
                className: 'tbUploadClose',
                'aria-label': '关闭',
                disabled: skillDraft.busy,
                onClick: () => setSkillDraft(null),
              }, '×')),
            h('div', { className: 'tbScopeSeg', role: 'tablist', 'aria-label': '安装位置' },
              h('button', {
                type: 'button',
                role: 'tab',
                'data-active': skillDraft.scope === 'project',
                'aria-selected': skillDraft.scope === 'project',
                onClick: () => setSkillDraft({ ...skillDraft, scope: 'project' }),
              }, '当前工作区'),
              h('button', {
                type: 'button',
                role: 'tab',
                'data-active': skillDraft.scope === 'global',
                'aria-selected': skillDraft.scope === 'global',
                onClick: () => setSkillDraft({ ...skillDraft, scope: 'global' }),
              }, '全局')),
            h('div', {
              className: 'tbDrop',
              'data-drag': skillDraft.dragging,
              'data-busy': skillDraft.busy,
              onClick: () => { if (!skillDraft.busy) folderInputRef.current?.click() },
              onDragOver: (event) => { event.preventDefault(); if (!skillDraft.busy) setSkillDraft({ ...skillDraft, dragging: true }) },
              onDragLeave: () => setSkillDraft({ ...skillDraft, dragging: false }),
              onDrop: (event) => {
                event.preventDefault()
                if (skillDraft.busy) return
                setSkillDraft({ ...skillDraft, dragging: false })
                void doUpload(event.dataTransfer.files)
              },
            },
              h('div', { className: 'tbDropIcon', 'aria-hidden': 'true' },
                h('svg', { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
                  h('path', { d: 'M12 16V7' }),
                  h('path', { d: 'm8.5 10 3.5-3.5L15.5 10' }),
                  h('path', { d: 'M5 16.5V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-1.5' }))),
              h('p', { className: 'tbDropTitle' }, skillDraft.busy ? '正在安装…' : '把技能拖到这里'),
              h('p', { className: 'tbDropSub' }, '文件夹，或 zip / tar.gz'),
              h('div', { className: 'tbDropActions' },
                h('button', {
                  type: 'button',
                  disabled: skillDraft.busy,
                  onClick: (event) => { event.stopPropagation(); folderInputRef.current?.click() },
                }, '选择文件夹'),
                h('button', {
                  type: 'button',
                  disabled: skillDraft.busy,
                  onClick: (event) => { event.stopPropagation(); archiveInputRef.current?.click() },
                }, '选择压缩包'))),
            h('p', { className: 'tbHint' }, '文件夹里需要有 SKILL.md。压缩包解压后也应是这样一个文件夹。'),
            h('input', {
              ref: folderInputRef, type: 'file', multiple: true,
              webkitdirectory: '', directory: '', style: { display: 'none' },
              onChange: (event) => { if (event.target.files?.length) void doUpload(event.target.files); event.target.value = '' },
            }),
            h('input', {
              ref: archiveInputRef, type: 'file', accept: '.zip,.tar,.gz,.tgz',
              style: { display: 'none' },
              onChange: (event) => { if (event.target.files?.length) void doUpload(event.target.files); event.target.value = '' },
            }),
          )), document.body),
        toast === '' ? null : createPortal(h('div', { className: 'tbToast', role: 'alert' }, toast), document.body))
    }

    function PageView({ page, onBack }) {
      return h('main', { className: 'dsb-page' },
        h('h1', null, page.label),
        h('p', { className: 'dsb-lead' }, page.lead),
        h('section', { className: 'dsb-card' },
          h('h2', null, '列表'),
          h('p', null, page.empty)),
        h('form', {
          className: 'dsb-card',
          onSubmit: (event) => event.preventDefault(),
        },
          h('h2', null, '表单'),
          page.fields.map(field => h('label', { className: 'dsb-field', key: field },
            field,
            h('input', { disabled: true, placeholder: '后续迭代中补充' })))),
        h('button', { className: 'dsb-back', type: 'button', onClick: onBack }, '返回对话'))
    }

    function WorkspacePicker({ items, busy, onClose, onPick, onCreate }) {
      return createPortal(h('div', {
        className: 'dsb-modal-back',
        onMouseDown: (event) => { if (event.target === event.currentTarget) onClose() },
      },
        h('div', {
          className: 'dsb-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dsb-picker-title',
        },
          h('h2', { id: 'dsb-picker-title' }, '选择工作区'),
          items.length === 0
            ? h('p', { className: 'dsb-empty' }, '还没有工作区。')
            : h('ul', { className: 'dsb-picker' }, items.map(item => h('li', { key: item.workspaceId },
              h('button', { type: 'button', onClick: () => onPick(item.workspaceId) }, item.title || item.path)))),
          h('div', { className: 'dsb-modal-actions' },
            h('button', { type: 'button', disabled: busy, onClick: onCreate }, busy ? '创建中…' : '新建工作区'),
            h('button', { type: 'button', onClick: onClose }, '取消')))), document.body)
    }

    function RecentMenu({ top, left, onRename, onFork, onArchive }) {
      return createPortal(h('div', {
        className: 'dsb-recent-menu',
        role: 'menu',
        style: { top: `${String(top)}px`, left: `${String(left)}px` },
      },
        h('button', { type: 'button', role: 'menuitem', onClick: onRename }, '重命名'),
        h('button', { type: 'button', role: 'menuitem', onClick: onFork }, '分叉对话'),
        h('button', { type: 'button', role: 'menuitem', 'data-danger': 'true', onClick: onArchive }, '归档')), document.body)
    }

    function RenameDialog({ value, busy, error, onChange, onClose, onConfirm }) {
      return createPortal(h('div', {
        className: 'dsb-modal-back',
        onMouseDown: (event) => { if (event.target === event.currentTarget) onClose() },
      },
        h('form', {
          className: 'dsb-modal',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': 'dsb-rename-title',
          onSubmit: (event) => { event.preventDefault(); onConfirm() },
        },
          h('h2', { id: 'dsb-rename-title' }, '重命名会话'),
          h('input', {
            value,
            'aria-label': '会话名称',
            autoFocus: true,
            disabled: busy,
            onChange: (event) => onChange(event.target.value),
          }),
          error && h('p', { className: 'dsb-error', role: 'alert' }, error),
          h('div', { className: 'dsb-modal-actions' },
            h('button', { type: 'submit', disabled: busy || value.trim() === '' }, busy ? '保存中…' : '重命名'),
            h('button', { type: 'button', onClick: onClose }, '取消')))), document.body)
    }

    function buttonRow(button, boundary) {
      let row = button
      while (
        row.parentElement
        && row.parentElement !== boundary
        && row.parentElement.childElementCount === 1
        && row.parentElement.querySelector('[role="treeitem"]') === null
      ) row = row.parentElement
      return row
    }

    function ensureBefore(id, anchor) {
      let mount = document.getElementById(id)
      if (!mount) {
        mount = document.createElement('div')
        mount.id = id
      }
      if (mount.parentElement !== anchor.parentElement || mount.nextElementSibling !== anchor) {
        anchor.parentElement.insertBefore(mount, anchor)
      }
      return mount
    }

    function isSettingsButton(button) {
      if (button.closest('#dsb-menu-mount, #dsb-recent-mount, [role="treeitem"]')) return false
      return button.textContent.replace(/\s+/g, '') === '设置'
    }

    function isChromeNewSession(button) {
      if (button.closest('#dsb-menu-mount, #dsb-recent-mount, [role="treeitem"]')) return false
      const text = button.textContent.replace(/\s+/g, '')
      if (text === '新会话') return true
      return text === '' && button.getAttribute('aria-label') === '新建会话'
    }

    function hostSidebarWide() {
      if (document.querySelector('[data-sidebar-collapsed]') !== null) return false
      return true
    }

    function hostChromeBusy() {
      return [...document.querySelectorAll('[role="menu"], [role="dialog"], [role="alertdialog"], [aria-modal="true"]')]
        .some(node => node.closest('.dsb-modal-back, .dsb-recent-menu') === null && !node.classList.contains('dsb-modal'))
    }

    function findHostSidebar() {
      const sessionButtons = [...document.querySelectorAll('button')].filter(isChromeNewSession)
      let best = null
      for (const sessionButton of sessionButtons) {
        let el = sessionButton.parentElement
        while (el && el !== document.body) {
          const settings = [...el.querySelectorAll('button')].find(isSettingsButton)
          if (settings) {
            if (!best || best.sidebar.contains(el)) best = { sidebar: el, sessionButton, settings }
            break
          }
          el = el.parentElement
        }
      }
      return best
    }

    const NO_HOST_INFO = {
      subscribe: () => () => {},
      getSnapshot: () => null,
    }

    /** 宿主连接源：与 dsh-client-ui-workspace 一样订阅 connection/reset，重连后触发重挂。 */
    function getHostInfo(source) {
      if (source === null || typeof source !== 'object') return NO_HOST_INFO
      const subscribe = typeof source.subscribe === 'function' ? source.subscribe : NO_HOST_INFO.subscribe
      const getSnapshot = typeof source.getSnapshot === 'function' ? source.getSnapshot : NO_HOST_INFO.getSnapshot
      return { subscribe, getSnapshot }
    }

    /** 插件渲染异常只降级自己这一块，不要把宿主的 React 根一起带崩。 */
    class Guard extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error }
      }
      componentDidCatch(error) {
        console.error('[dsh-sidebar] render failed:', error)
      }
      render() {
        if (this.state.error === null) return this.props.children
        return h('button', {
          className: 'dsb-row',
          type: 'button',
          role: 'alert',
          onClick: () => setStateSafely(this),
        }, '侧边栏渲染出错，点击重试')
      }
    }

    function setStateSafely(component) {
      try {
        component.setState({ error: null })
      } catch (error) {
        console.error('[dsh-sidebar] retry failed:', error)
      }
    }

    function guarded(element) {
      return h(Guard, null, element)
    }

    function SidebarHost({
      useSessions,
      useWorkspaces,
      usePanelInfo,
      hostInfo,
      startSession,
      selectPanel,
      openSession,
      pickDirectory,
      createWorkspace,
      openQuickChat,
      archiveSession,
      renameSession,
      forkSession,
    }) {
      const workspaceState = useWorkspaces(state => state)
      const sessionState = useSessions(state => state)
      const activePanel = usePanelInfo(info => info?.activePanelId ?? null)
      const [pickerOpen, setPickerOpen] = React.useState(false)
      const [expanded, setExpanded] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [wide, setWide] = React.useState(true)
      const [menuMount, setMenuMount] = React.useState(null)
      const [recentMount, setRecentMount] = React.useState(null)
      const [menu, setMenu] = React.useState(null)
      const [renameTarget, setRenameTarget] = React.useState(null)
      const [renameBusy, setRenameBusy] = React.useState(false)
      const [renameError, setRenameError] = React.useState(null)
      const [reconnectTick, setReconnectTick] = React.useState(0)
      const refs = workspaceRefs(workspaceState?.items)
      const projects = refs.filter(item => !isJustChatPath(item.path))
      const quick = refs.filter(item => isJustChatPath(item.path))
      const sessions = sessionMap(sessionState)
      const currentId = sessionState?.current === undefined || sessionState?.current === null
        ? undefined
        : String(sessionState.current)
      const recent = recentSessions(refs, sessions, archivedIds(workspaceState?.archivedSessionIds))
      const shown = expanded ? recent : recent.slice(0, RECENT_LIMIT)
      const rest = recent.length - shown.length
      const now = Date.now()
      const quickKey = quick.map(item => item.title).join('\n')

      React.useEffect(() => {
        const off = getHostInfo(hostInfo).subscribe(() => {
          // 重连后旧的锚点节点可能已经不在文档里，先收掉挂在旧锚点上的菜单。
          setMenu(null)
          setReconnectTick(tick => tick + 1)
        })
        return typeof off === 'function' ? off : undefined
      }, [hostInfo])

      React.useEffect(() => {
        const quickTitles = quickKey === '' ? [] : quickKey.split('\n')
        const apply = () => {
          const nextWide = hostSidebarWide()
          setWide(current => current === nextWide ? current : nextWide)
          const found = findHostSidebar()
          if (!found) return
          const { sidebar, sessionButton, settings } = found
          const sessionRow = buttonRow(sessionButton, sidebar)
          if (!sessionRow.querySelector('[role="treeitem"]')) {
            sessionRow.setAttribute('data-dsb-host-hide', 'true')
          }
          setMenuMount(current => {
            const mount = ensureBefore('dsb-menu-mount', sessionRow)
            return current === mount ? current : mount
          })
          setRecentMount(current => {
            const mount = ensureBefore('dsb-recent-mount', buttonRow(settings, sidebar))
            return current === mount ? current : mount
          })
          if (!hostChromeBusy()) hideRecentGroups(sidebar, quickTitles)
        }
        apply()
        let frame = 0
        const schedule = () => {
          cancelAnimationFrame(frame)
          frame = requestAnimationFrame(apply)
        }
        const observer = new MutationObserver(schedule)
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['data-sidebar-collapsed'],
        })
        // 宿主重连会重建侧边栏 DOM，MutationObserver 未必覆盖到被替换的挂载点；
        // 定时校验挂载点是否还在文档里，掉了就重新挂一次。
        const guard = window.setInterval(() => {
          if (document.getElementById('dsb-menu-mount') !== null) return
          apply()
        }, 2000)
        return () => {
          cancelAnimationFrame(frame)
          clearInterval(guard)
          observer.disconnect()
        }
      }, [quickKey, reconnectTick])

      const membership = refs.map(item => `${item.workspaceId}\n${item.sessionIds.join(',')}`).join('\n\n')
      const previousWorkspaces = React.useRef(null)
      React.useEffect(() => {
        const next = new Map(refs.map(item => [item.workspaceId, item.sessionIds]))
        const before = previousWorkspaces.current
        previousWorkspaces.current = next
        if (before === null) return
        // 重连期间工作区列表可能短暂为空，这时不要把它当成“工作区被删除”去归档会话。
        if (refs.length === 0) return
        const stillThere = new Set()
        for (const ids of next.values()) for (const id of ids) stillThere.add(id)
        for (const [id, sessionIds] of before) {
          if (next.has(id)) continue
          for (const sessionId of sessionIds) {
            if (stillThere.has(sessionId)) continue
            Promise.resolve(archiveSession(sessionId)).catch(() => {})
          }
        }
      }, [membership, archiveSession])

      React.useEffect(() => {
        if (menu === null) return
        const close = (event) => {
          const target = event.target
          if (!(target instanceof Element)) return
          if (target.closest('.dsb-recent-menu, .dsb-recent-more') !== null) return
          setMenu(null)
        }
        document.addEventListener('pointerdown', close)
        return () => document.removeEventListener('pointerdown', close)
      }, [menu])

      const fail = (reason) => {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
      const showChat = () => {
        try { selectPanel(null) } catch (reason) { fail(reason) }
      }
      const newWorkChat = () => {
        setError(null)
        showChat()
        const projectId = currentProjectId(refs, currentId)
        if (projectId) {
          startSession(projectId)
          return
        }
        setPickerOpen(true)
      }
      const newQuickChat = async () => {
        if (busy) return
        setBusy(true)
        setError(null)
        showChat()
        try {
          await openQuickChat()
        } catch (reason) {
          fail(reason)
        } finally {
          setBusy(false)
        }
      }
      const pickProject = (workspaceId) => {
        setPickerOpen(false)
        setError(null)
        showChat()
        startSession(workspaceId)
      }
      const createProject = async () => {
        if (busy) return
        setBusy(true)
        setError(null)
        try {
          const path = await pickDirectory()
          if (!path) return
          const workspace = await createWorkspace(path)
          setPickerOpen(false)
          showChat()
          startSession(workspace.workspaceId)
        } catch (reason) {
          fail(reason)
        } finally {
          setBusy(false)
        }
      }
      const openPage = (id) => {
        setError(null)
        try { selectPanel(id) } catch (reason) { fail(reason) }
      }
      const openRecentMenu = (row, anchor) => {
        setMenu(current => current?.id === row.id ? null : { id: row.id, anchor })
      }
      const renameRecent = (row) => {
        setMenu(null)
        setRenameError(null)
        setRenameTarget({ id: row.id, draft: row.title })
      }
      const confirmRename = async () => {
        if (renameTarget === null || renameBusy || renameTarget.draft.trim() === '') return
        setRenameBusy(true)
        setRenameError(null)
        try {
          await renameSession(renameTarget.id, renameTarget.draft.trim())
          setRenameTarget(null)
        } catch (reason) {
          setRenameError(reason instanceof Error ? reason.message : String(reason))
        } finally {
          setRenameBusy(false)
        }
      }
      const forkRecent = async (row) => {
        setMenu(null)
        setError(null)
        showChat()
        try {
          await forkSession(row.id)
        } catch (reason) {
          fail(reason)
        }
      }
      const archiveRecent = async (row) => {
        setMenu(null)
        setError(null)
        try {
          await archiveSession(row.id)
        } catch (reason) {
          fail(reason)
        }
      }

      const nav = h('nav', { className: wide ? 'dsb-menu' : 'dsb-rail', 'aria-label': '功能' },
        h('button', { className: 'dsb-row', type: 'button', onClick: newWorkChat },
          h(Icon, { name: 'pen' }), wide && '新工作对话'),
        h('button', { className: 'dsb-row', type: 'button', disabled: busy, onClick: () => { void newQuickChat() } },
          h(Icon, { name: 'chat' }), wide && (busy ? '打开中…' : '新对话')),
        PAGES.map(page => h('button', {
          className: 'dsb-row', type: 'button', key: page.id,
          'data-active': activePanel === page.id,
          onClick: () => openPage(page.id),
        }, h(Icon, { name: page.icon }), wide && page.label)))
      const recentList = h('section', { className: 'dsb-recent', 'aria-label': '最近对话' },
        h('h2', { className: 'dsb-section' }, '最近对话'),
        shown.length === 0
          ? h('p', { className: 'dsb-empty' }, '还没有对话。')
          : shown.map(row => {
            const open = menu?.id === row.id
            const rect = open ? menu.anchor.getBoundingClientRect() : null
            const menuHeight = 112
            const top = rect === null ? 0 : rect.bottom + 4 + menuHeight > window.innerHeight ? Math.max(8, rect.top - menuHeight - 4) : rect.bottom + 4
            const left = rect === null ? 0 : Math.max(8, Math.min(rect.right - 148, window.innerWidth - 156))
            return h('div', {
              className: 'dsb-recent-row',
              key: row.id,
              'data-active': row.id === currentId,
              'data-actions': row.blank !== true,
              'data-menu': open,
            },
              h('button', {
                className: 'dsb-recent-open',
                type: 'button',
                onClick: () => { setMenu(null); showChat(); openSession(row.id) },
              },
                h('span', { className: 'dsb-recent-title' }, row.title),
                h('span', { className: 'dsb-recent-time' }, relativeTime(row.updatedAt, now))),
              row.blank !== true && h('button', {
                className: 'dsb-recent-more',
                type: 'button',
                'aria-label': `会话“${row.title}”的操作`,
                'aria-expanded': open,
                'aria-haspopup': 'menu',
                onClick: (event) => openRecentMenu(row, event.currentTarget),
              }, '···'),
              open && h(RecentMenu, {
                top, left,
                onRename: () => renameRecent(row),
                onFork: () => { void forkRecent(row) },
                onArchive: () => { void archiveRecent(row) },
              }))
          }),
        rest > 0 && h('button', {
          className: 'dsb-more', type: 'button', onClick: () => setExpanded(true),
        }, `展开其余 ${String(rest)} 个会话`),
        error && h('p', { className: 'dsb-error', role: 'alert' }, error))

      return h(React.Fragment, null,
        menuMount && createPortal(nav, menuMount),
        recentMount && wide && createPortal(recentList, recentMount),
        pickerOpen && h(WorkspacePicker, {
          items: projects, busy, onClose: () => setPickerOpen(false), onPick: pickProject, onCreate: () => { void createProject() },
        }),
        renameTarget && h(RenameDialog, {
          value: renameTarget.draft,
          busy: renameBusy,
          error: renameError,
          onChange: (draft) => setRenameTarget(current => current === null ? current : { ...current, draft }),
          onClose: () => { if (!renameBusy) setRenameTarget(null) },
          onConfirm: () => { void confirmRename() },
        }))
    }

    async function openQuickChat(ctx) {
      const response = await fetch('/api/dsh-sidebar/recent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      if (!response.ok) {
        throw new Error('新对话未能打开。')
      }
      const result = await response.json()
      if (typeof result?.path !== 'string' || result.path === '') {
        throw new Error('新对话没有返回工作区路径。')
      }
      const workspace = await ctx.workspaces.create({ path: result.path })
      const workspaceId = workspace?.workspaceId
      if (typeof workspaceId !== 'string' || workspaceId === '') {
        throw new Error('新对话没有返回工作区。')
      }
      const ui = ctx.uiWorkspace ?? ctx.get('uiWorkspace')
      ui.startSession(workspaceId)
    }

    function workspaceSnapshot(ctx) {
      const list = ctx.workspaces?.list ?? ctx.workspaces
      const snapshot = list?.getSnapshot?.()
      return snapshot && Array.isArray(snapshot.items) ? snapshot : { items: [] }
    }

    function projectCwd(ctx) {
      const list = ctx.sessions?.list?.getSnapshot?.()
      const current = list?.current
      const cwd = current === undefined || current === null ? undefined : list?.byId?.[current]?.cwd
      if (typeof cwd === 'string' && cwd !== '') return cwd
      const items = workspaceSnapshot(ctx).items
      const project = items.find((item) => typeof item?.path === 'string' && !isJustChatPath(item.path))
      return typeof project?.path === 'string' ? project.path : ''
    }

    function hostConnection(ctx) {
      return {
        getSnapshot: () => {
          try {
            return ctx.remote?.$host ?? null
          } catch (error) {
            return null
          }
        },
        subscribe: (listener) => {
          if (typeof ctx.on !== 'function') return () => {}
          try {
            const off = ctx.on('connection/reset', listener)
            return typeof off === 'function' ? off : () => {}
          } catch (error) {
            console.error('[dsh-sidebar] connection/reset subscribe failed:', error)
            return () => {}
          }
        },
      }
    }

    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.pluginCss = 'dsh-sidebar'
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'dsh-sidebar: styles')

      const hostInfo = hostConnection(ctx)
      const listWorkspaces = () => workspaceRefs(workspaceSnapshot(ctx).items)
        .filter((item) => item.path !== '' && !isJustChatPath(item.path))
      const subscribeWorkspaces = (listener) => {
        const list = ctx.workspaces?.list ?? ctx.workspaces
        if (typeof list?.subscribe !== 'function') return () => {}
        return list.subscribe(listener)
      }
      const backToChat = () => { ctx.layout.selectPanel(null) }
      for (const page of PAGES) {
        const view = page.id === 'dsh-sidebar.toolbox'
          ? () => guarded(h(ToolboxPage, { onBack: backToChat, projectCwd: () => projectCwd(ctx), listWorkspaces, subscribeWorkspaces }))
          : () => guarded(h(PageView, { page, onBack: backToChat }))
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: page.id,
        }, view))
      }

      // 设置 → 插件 → 插件配置：宿主 serve 了 dsh-sidebar-memory 这个命名空间，
      // 这里认领同名卡片；两边缺一都不会渲染。
      ctx.slots.inject('settings.plugin.item', function* () {
        yield ctx.slots.register({
          name: 'settings.plugin.item',
          key: MEMORY_NS,
          inject: () => ({}),
        }, MemorySettingsCard)
      })

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'dsh-sidebar',
        order: 20,
        inject: () => ({
          hostInfo,
          startSession: (workspaceId) => {
            const ui = ctx.uiWorkspace ?? ctx.get('uiWorkspace')
            ui.startSession(workspaceId)
          },
          selectPanel: (id) => { ctx.layout.selectPanel(id) },
          openSession: (id) => { ctx.sessions.open(id) },
          pickDirectory: () => {
            const ui = ctx.uiWorkspace ?? ctx.get('uiWorkspace')
            return ui.pickDirectory()
          },
          createWorkspace: (path) => ctx.workspaces.create({ path }),
          archiveSession: (sessionId) => ctx.workspaces.archiveSession(sessionId),
          renameSession: async (sessionId, title) => {
            const session = ctx.sessions.binding(sessionId)?.session
            if (session === undefined) throw new Error(`找不到会话 ${sessionId}`)
            const result = await session.rename(title)
            if (!result.ok) throw new Error(result.error?.message ?? '重命名失败')
          },
          forkSession: (sessionId) => {
            const ui = ctx.uiWorkspace ?? ctx.get('uiWorkspace')
            return ui.forkSession(sessionId)
          },
          openQuickChat: () => openQuickChat(ctx),
        }),
      }, (props) => guarded(h(SidebarHost, props))))
    }

    return { apply, name: 'dsh-sidebar', inject: ['slots', 'layout', 'remote', 'workspaces', 'sessions', 'uiWorkspace'] }
  },
})
