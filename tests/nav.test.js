import assert from 'node:assert/strict'
import test from 'node:test'
import {
  currentProjectId,
  isJustChatPath,
  justChatTitle,
  projectWorkspaces,
  recentSessions,
  relativeTime,
} from '../lib/nav.js'

const project = {
  workspaceId: 'proj',
  path: '/work/proj',
  title: '项目A',
  sessionIds: ['s1'],
}

const quick = {
  workspaceId: 'quick',
  path: 'C:\\Users\\me\\.dsh\\just-chat\\sessions\\chat-abc',
  title: '快速对话 · 09-17 15:03',
  sessionIds: ['q1', 'q2'],
}

test('treats background and leftover quick-chat directories as hidden projects', () => {
  assert.equal(isJustChatPath(quick.path), true)
  assert.equal(isJustChatPath('/Users/me/.dsh/just-chat/sessions/chat-x'), true)
  assert.equal(isJustChatPath('/Users/me/.dsh/dsh-sidebar/recent'), true)
  assert.equal(isJustChatPath('/work/proj'), false)
})

test('keeps real projects and drops quick-chat workspaces', () => {
  assert.deepEqual(projectWorkspaces([project, quick]).map(item => item.workspaceId), ['proj'])
})

test('a quick-chat session is not a selected project', () => {
  assert.equal(currentProjectId([project, quick], 's1'), 'proj')
  assert.equal(currentProjectId([project, quick], 'q1'), undefined)
  assert.equal(currentProjectId([project, quick], undefined), undefined)
})

test('flattens recent history, keeps a blank chat, and drops archived rows', () => {
  const sessions = {
    q1: { id: 'q1', title: '旧对话', updatedAt: 10, blank: false },
    q2: { id: 'q2', title: '新对话', updatedAt: 50, blank: false },
    blank: { id: 'blank', title: '新会话', updatedAt: 80, blank: true },
  }
  const withBlank = { ...quick, sessionIds: ['q1', 'q2', 'blank', 'gone'] }
  const rows = recentSessions([project, withBlank], sessions, new Set(['q1']))
  assert.deepEqual(rows.map(row => row.id), ['blank', 'q2'])
})

test('formats relative time the way the sidebar already does', () => {
  const now = 10_000_000
  assert.equal(relativeTime(now, now), '刚刚')
  assert.equal(relativeTime(now - 40 * 60_000, now), '40分钟')
  assert.equal(relativeTime(now - 3 * 60 * 60_000, now), '3小时')
  assert.equal(relativeTime(now - 2 * 24 * 60 * 60_000, now), '2天')
})

test('builds the default quick-chat title', () => {
  assert.equal(justChatTitle(new Date(2026, 8, 17, 15, 3, 0)), '快速对话 · 09-17 15:03')
})
