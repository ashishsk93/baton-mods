import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

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
  expect(await ui.find({ text: /✓ #\w+ → data-dashboards-ca\s+done/ })).toBeDefined()
  expect((await ui.find({ type: 'Link' }))?.props).toMatchObject({ href: 'https://bitbucket.org/x/pull-requests/7', label: 'PR #7' })
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

const asked = (id: string, question: string) =>
  `BATON-ASK ${JSON.stringify({ id, task: question, from: 'sender-session', fromLabel: 'web-app' })}\n\nQuestion from web-app: ${question}`

test('a question is answered read-only, even while busy, and the answer goes back', async ($, on) => {
  const w = world(on, { value: true })
  await $.session.receive({ origin: { kind: 'peer' }, text: passed('t1', 'busy work') })
  const r = await $.session.receive({ origin: { kind: 'peer' }, text: asked('q1', 'where is auth configured?') })
  expect(r.consumed).toBeDefined()
  await w.clock.advance(0)
  expect(w.submitted.length).toBe(1)
  expect(w.submitted[0]).toContain('where is auth configured?')
  expect(w.submitted[0]).toContain('Read only')
  expect((await $.command.run({ command: 'baton', args: '' } as never)).text).toContain('1. #t1')

  const done = await $.tool.call({ tool: 'mcp__baton__answer', id: 'q1', answer: 'src/auth/config.ts:12' } as never)
  expect(JSON.stringify(done)).toContain('Answered #q1')
  const reply = w.sent.find(t => t.startsWith('BATON-RESULT q1: answered'))
  expect(reply).toContain('src/auth/config.ts:12')
  const again = await $.tool.call({ tool: 'mcp__baton__answer', id: 'q1', answer: 'twice' } as never)
  expect(JSON.stringify(again)).toContain('No open question')
})

test('/ask sends a question and shows the answer when it comes back', async ($, on) => {
  const w = world(on)
  const out = await $.command.run({ command: 'ask', args: 'api-server-7f where is auth configured?' } as never)
  const id = /#(\w+)/.exec(out.text ?? '')?.[1]
  expect(w.sent[0]).toContain('BATON-ASK')
  expect(w.sent[0]).toContain('where is auth configured?')

  await $.session.receive({
    origin: { kind: 'peer' },
    text: `BATON-RESULT ${id}: answered. [api] "where is auth configured?"\nIn src/auth/config.ts:12, see https://example.com/doc`,
  })
  const ui = await $.ui.mount({ plugin: 'baton', surface: 'terminal', ...BAND } as never)
  expect((await ui.find({ key: 'sent' }))?.text).toContain('→ 0/1')
  await ui.press({ key: 'sent' })
  expect(await ui.find({ text: /✓ #\w+ → api-server-7f\s+answered/ })).toBeDefined()
  expect(await ui.find({ text: /↳ In src\/auth\/config\.ts:12/ })).toBeDefined()
  // A URL inside an answer is not taken as a PR link on the question row.
  expect(await ui.find({ text: /configured\?\s+https/ })).toBeUndefined()
})

const result = (id: string, status: string, rest = '') => `BATON-RESULT ${id}: ${status}. [api] "task"${rest}`

async function passOne($: Engine, agent = 'api-server-7f') {
  const out = await $.command.run({ command: 'pass', args: `${agent} add rate limiting` } as never)
  return /#(\w+)/.exec(out.text ?? '')?.[1] ?? ''
}

test('a final result for a task passed from here raises a toast; others do not', async ($, on) => {
  const w = world(on)
  const id = await passOne($)
  await $.session.receive({ origin: { kind: 'peer' }, text: result(id, 'started') })
  await $.session.receive({ origin: { kind: 'peer' }, text: result('zz9', 'done') })
  expect(w.toasts).toEqual([])
  await $.session.receive({ origin: { kind: 'peer' }, text: result(id, 'done', '\nPR: https://github.com/o/r/pull/42') })
  expect(w.toasts).toEqual([`✓ api-server-7f done #${id} · https://github.com/o/r/pull/42`])
  await $.session.receive({ origin: { kind: 'peer' }, text: result(id, 'blocked') })
  expect(w.toasts[1]).toBe(`✗ api-server-7f blocked #${id}`)
})

test('sent rows carry a status icon and an age', async ($, on) => {
  const w = world(on)
  const id = await passOne($)
  await w.clock.advance(12 * 60_000)
  const ui = await $.ui.mount({ plugin: 'baton', surface: 'terminal', ...BAND } as never)
  await ui.press({ key: 'sent' })
  expect(await ui.find({ text: new RegExp(`○ #${id} → api-server-7f\\s+sent 12m`) })).toBeDefined()
  await $.session.receive({ origin: { kind: 'peer' }, text: result(id, 'done') })
  await w.clock.advance(60 * 60_000)
  // The panel is still open from the first press: `open` is shared state.
  const later = await $.ui.mount({ plugin: 'baton', surface: 'terminal', ...BAND } as never)
  expect(await later.find({ text: new RegExp(`✓ #${id} → api-server-7f\\s+done 1h`) })).toBeDefined()
})

test('a passed task with no word for 2h is marked quiet', async ($, on) => {
  const w = world(on)
  await passOne($)
  await w.clock.advance(119 * 60_000)
  const ui = await $.ui.mount({ plugin: 'baton', surface: 'terminal', ...BAND } as never)
  expect((await ui.find({ key: 'sent' }))?.text).toBe('→ 1/1')
  await w.clock.advance(2 * 60_000)
  await $.session.receive({ origin: { kind: 'peer' }, text: 'hello' })
  const later = await $.ui.mount({ plugin: 'baton', surface: 'terminal', ...BAND } as never)
  expect((await later.find({ key: 'sent' }))?.text).toBe('→ 1/1 (1 quiet)')
  await later.press({ key: 'sent' })
  expect(await later.find({ text: /no word in 2h/ })).toBeDefined()
})

test('backlog rows in the pane move up, down and drop', async ($, on) => {
  const w = world(on, { value: true })
  for (const id of ['a1', 'b2', 'c3']) await $.session.receive({ origin: { kind: 'peer' }, text: passed(id, `task ${id}`) })
  const order = async () => ((await $.command.run({ command: 'baton', args: '' } as never)).text ?? '').match(/#\w+/g)
  expect(await order()).toEqual(['#a1', '#b2', '#c3'])
  const pane = await $.ui.mount({
    plugin: 'baton',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'baton',
    props: { title: 'Baton', isFocused: false, bodyColumns: 60, placement: 'dock' },
  } as never)
  await pane.press({ key: 'down-a1' })
  expect(await order()).toEqual(['#b2', '#a1', '#c3'])
  await pane.press({ key: 'up-c3' })
  expect(await order()).toEqual(['#b2', '#c3', '#a1'])
  await pane.press({ key: 'drop-c3' })
  expect(await order()).toEqual(['#b2', '#a1'])
  expect(w.sent.some(t => t.startsWith('BATON-RESULT c3: dropped'))).toBe(true)
})
