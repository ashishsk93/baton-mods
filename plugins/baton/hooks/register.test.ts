import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { parsePeers } from './shared'

const passed = (id: string, task: string) =>
  `BATON-PASS ${JSON.stringify({ id, task, from: 'sender-session', fromLabel: 'launchpad' })}\n\nTask from launchpad: ${task}`

function world(on: On, dirty = { value: false }) {
  const sent: string[] = []
  const submitted: string[] = []
  mock.store(on)
  const clock = mock.clock(on)
  on('session.root', () => ({ value: '/repos/data_dashboards_db' }))
  on('session.id', () => ({ value: 'receiver-session' }))
  on('ui.status', () => ({ value: undefined }))
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('process.run', () => ({
    value: {
      exitCode: 0,
      stdout: dirty.value ? ' M Makefile\n' : '',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('session.send', (_$, e) => {
    sent.push(e.text)
    return { isDelivered: true }
  })
  on('session.receive', (_$, e) => ({ text: e.text }))
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  return { sent, submitted, toasts, clock }
}

test('starts a task, backlogs the next, reports done and picks up the backlog', async ($, on) => {
  const w = world(on)

  const first = await $.session.receive({ origin: { kind: 'peer' }, text: passed('a1', 'raise data_dashboard_db memory to 4GB') })
  expect(first.consumed).toBeDefined()
  await w.clock.advance(0)
  expect(w.submitted.length).toBe(1)
  expect(w.submitted[0]).toContain('raise data_dashboard_db memory to 4GB')
  expect(w.sent[0]).toContain('BATON-RESULT a1: started')

  const second = await $.session.receive({ origin: { kind: 'peer' }, text: passed('b2', 'add an index') })
  expect(second.consumed).toBeDefined()
  expect(w.submitted.length).toBe(1)
  expect(w.sent[1]).toContain('backlog at position 1')

  const done = await $.tool.call({ tool: 'mcp__baton__task_done', status: 'done', summary: 'bumped', prUrl: 'https://pr/1' } as never)
  expect(w.sent[2]).toContain('BATON-RESULT a1: done')
  expect(w.sent[2]).toContain('https://pr/1')
  expect(JSON.stringify(done)).toContain('Started #b2')
  await w.clock.advance(0)
  expect(w.submitted.length).toBe(2)
  expect(w.submitted[1]).toContain('add an index')
  expect(w.sent[3]).toContain('BATON-RESULT b2: started')
})

test('/baton-next refuses while a task is active, force drops it', async ($, on) => {
  const w = world(on)
  await $.session.receive({ origin: { kind: 'peer' }, text: passed('d4', 'one') })
  await $.session.receive({ origin: { kind: 'peer' }, text: passed('e5', 'two') })
  expect((await $.command.run({ command: 'baton-next', args: '' } as never)).text).toContain('still active')
  expect((await $.command.run({ command: 'baton-next', args: 'force' } as never)).text).toContain('Started #e5')
  expect(w.sent.some(t => t.includes('BATON-RESULT d4: dropped'))).toBe(true)
  await w.clock.advance(0)
  expect(w.toasts).toEqual([])
  expect(w.submitted.length).toBe(2)
})

test('uncommitted changes send a task to the backlog', async ($, on) => {
  const w = world(on, { value: true })
  await $.session.receive({ origin: { kind: 'peer' }, text: passed('c3', 'rotate logs') })
  expect(w.submitted.length).toBe(0)
  expect(w.sent[0]).toContain('uncommitted changes')
})

test('ordinary peer messages pass through', async ($, on) => {
  world(on)
  const r = await $.session.receive({ origin: { kind: 'peer' }, text: 'hello' })
  expect(r.text).toBe('hello')
})

const LISTING = `This session is launchpad-20 [31ab25] — the name other sessions use to message it.

Peer sessions (3):
  data-dashboards-ca [30c8e0]  ·  interactive  ·  idle  ·  started 28s ago
  observer-sessions-35 [07c6f3]  ·  interactive  ·  busy  ·  started 4m ago
  api-server-7f [1a2b3c]  ·  interactive  ·  busy  ·  started 9m ago`

test('parses this session and its peers from ListAgents, hiding claude-mem observers', () => {
  const peers = parsePeers(LISTING)
  expect(peers.me).toBe('launchpad-20 [31ab25]')
  expect(peers.list.map(p => `${p.name}:${p.state}`)).toEqual(['data-dashboards-ca:idle', 'api-server-7f:busy'])
})

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 },
} as const

test('the band counts sent tasks, tracks their results and expands on press', async ($, on) => {
  world(on)
  const handed = await $.command.run({ command: 'pass', args: 'data-dashboards-ca raise cpu to 2048' } as never)
  const id = /#(\w+)/.exec(handed.text ?? '')?.[1]
  await $.session.receive({ origin: { kind: 'peer' }, text: 'BATON-RESULT zz: done. not ours' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'baton', surface, ...BAND } as never)
    expect((await ui.find({ key: 'sent' }))?.text).toContain('→ 1/1')
    await ui.press({ key: 'sent' })
    expect(await ui.find({ text: /→ data-dashboards-ca\s+sent/ })).toBeDefined()
    await ui.press({ key: 'sent' })
    await ui.unmount()
  }

  await $.session.receive({ origin: { kind: 'peer' }, text: `BATON-RESULT ${id}: done. PR: https://bitbucket.org/x/pull-requests/7` })
  const ui = await $.ui.mount({ plugin: 'baton', surface: 'terminal', ...BAND } as never)
  expect((await ui.find({ key: 'sent' }))?.text).toContain('→ 0/1')
  await ui.press({ key: 'sent' })
  expect(await ui.find({ text: /done.*pull-requests\/7/ })).toBeDefined()
})

test('fullscreen: a press opens the docked pane on that tab instead of expanding the band', async ($, on) => {
  world(on)
  const opened: string[] = []
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  await $.session.receive({ origin: { kind: 'peer' }, text: passed('f6', 'bump cpu') })

  const band = await $.ui.mount({
    plugin: 'baton',
    surface: 'terminal',
    ...BAND,
    viewport: { columns: 200, rows: 50, isFullscreen: true },
  } as never)
  await band.press({ key: 'tasks' })
  expect(opened).toEqual(['baton'])
  expect(await band.find({ text: /#f6 from launchpad/ })).toBeUndefined()

  const pane = await $.ui.mount({
    plugin: 'baton',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'baton',
    props: { title: 'Baton', isFocused: false, bodyColumns: 60, placement: 'dock' },
  } as never)
  expect(await pane.find({ text: 'Tasks passed to this session' })).toBeDefined()
  expect(await pane.find({ text: /#f6 from launchpad: bump cpu/ })).toBeDefined()
  await pane.press({ key: 'me' })
  expect(await pane.find({ text: 'This session' })).toBeDefined()
})

test('the branch_rule option goes into the task prompt', { options: { branch_rule: 'Use release/<slug>' } }, async ($, on) => {
  const w = world(on)
  await $.session.receive({ origin: { kind: 'peer' }, text: passed('g7', 'ship it') })
  await w.clock.advance(0)
  expect(w.submitted[0]).toContain('Use release/<slug>')
})
