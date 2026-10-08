import { expect, test } from 'claude-code/testing'

import { BAND, listAgents, passed, passOne, result, world, openPanel } from './testkit'

const cancel = (id: string, from = 'sender-session') => `BATON-CANCEL ${JSON.stringify({ id, from })}`
const backlog = async ($: Parameters<typeof passOne>[0]) =>
  ((await $.command.run({ command: 'baton', args: '' } as never)).text ?? '').match(/#\w+/g) ?? []

// ---------- #10 /baton-report ----------

test('/baton-report sends the real outcome of a task that already left the queue', async ($, on) => {
  const w = world(on)
  await $.session.receive({ origin: { kind: 'peer' }, text: passed('r1', 'bump cpu') })
  await $.tool.call({ tool: 'mcp__baton__task_done', status: 'blocked', summary: 'push denied' } as never)
  expect(w.sent.at(-1)).toContain('BATON-RESULT r1: blocked')

  const out = await $.command.run({ command: 'baton-report', args: 'r1 done https://github.com/o/r/pull/9 pushed by hand' } as never)
  expect(out.text).toContain('Reported #r1')
  expect(w.sent.at(-1)).toMatch(/^BATON-RESULT r1: done/)
  expect(w.sent.at(-1)).toContain('pushed by hand')
  expect(w.sent.at(-1)).toContain('PR: https://github.com/o/r/pull/9')

  expect((await $.command.run({ command: 'baton-report', args: 'zz done' } as never)).text).toBe('No recent task #zz here. Recent: #r1.')
  expect((await $.command.run({ command: 'baton-report', args: 'r1 nope' } as never)).text).toContain('Usage: /baton-report')
})

// ---------- #11 /baton-cancel ----------

test('/baton-cancel asks the receiver to drop a passed task', async ($, on) => {
  const w = world(on)
  const id = await passOne($)
  expect((await $.command.run({ command: 'baton-cancel', args: id } as never)).text).toContain(`Asked api-server-7f to cancel #${id}`)
  expect(w.sent.at(-1)).toBe(cancel(id, 'receiver-session'))
  expect(w.targets.at(-1)).toBe('api-server-7f')
  expect((await $.command.run({ command: 'baton-cancel', args: 'nope' } as never)).text).toBe('No open task #nope passed from here.')

  await $.session.receive({ origin: { kind: 'peer' }, text: result(id, 'cancelled') })
  expect(w.toasts.at(-1)).toBe(`✗ api-server-7f cancelled #${id}`)
  expect((await $.command.run({ command: 'baton-cancel', args: id } as never)).text).toBe(`No open task #${id} passed from here.`)
})

test('a cancel removes a queued task, only for its sender', async ($, on) => {
  const w = world(on, { value: true })
  await $.session.receive({ origin: { kind: 'peer' }, text: passed('k1', 'one') })
  await $.session.receive({ origin: { kind: 'peer' }, text: passed('k2', 'two') })
  expect((await $.session.receive({ origin: { kind: 'peer' }, text: cancel('k2', 'someone-else') })).consumed).toBeDefined()
  expect(await backlog($)).toEqual(['#k1', '#k2'])

  expect((await $.session.receive({ origin: { kind: 'peer' }, text: cancel('k2') })).consumed).toBeDefined()
  expect(await backlog($)).toEqual(['#k1'])
  expect(w.sent.at(-1)).toMatch(/^BATON-RESULT k2: cancelled/)
})

test('a cancel for the running task leaves it running and says so', async ($, on) => {
  const w = world(on)
  await $.session.receive({ origin: { kind: 'peer' }, text: passed('a1', 'one') })
  await $.session.receive({ origin: { kind: 'peer' }, text: cancel('a1') })
  expect((await $.command.run({ command: 'baton', args: '' } as never)).text).toContain('Active: #a1')
  expect(w.sent.at(-1)).toMatch(/^BATON-RESULT a1: started.*already running/)
  expect(w.toasts.at(-1)).toContain('asked to cancel #a1')
})

// ---------- #12 ask back ----------

test('the receiver asks the sender a question and carries on with the answer', async ($, on) => {
  const w = world(on)
  await $.session.receive({ origin: { kind: 'peer' }, text: passed('t1', 'raise memory') })
  await w.clock.advance(0)
  expect(w.submitted[0]).toContain('ask_sender')

  const asked = await $.tool.call({ tool: 'mcp__baton__ask_sender', question: 'which region?' } as never)
  expect(JSON.stringify(asked)).toContain('Asked launchpad')
  expect(w.sent.at(-1)).toMatch(/^BATON-RESULT t1: waiting/)
  expect(w.sent.at(-1)).toContain('\nwhich region?\n')
  expect(w.sent.at(-1)).toContain('BATON-ANSWER t1: <answer>')

  expect((await $.session.receive({ origin: { kind: 'peer' }, text: 'BATON-ANSWER t1: us-east-1' })).consumed).toBeDefined()
  await w.clock.advance(0)
  expect(w.submitted[1]).toContain('us-east-1')
  expect(w.submitted[1]).toContain('#t1')
  expect(w.sent.at(-1)).toMatch(/^BATON-RESULT t1: started/)

  const unknown = await $.session.receive({ origin: { kind: 'peer' }, text: 'BATON-ANSWER zz: hi' })
  expect(unknown.consumed).toBeUndefined()
})

test('ask_sender needs an active task', async ($, on) => {
  world(on)
  expect(JSON.stringify(await $.tool.call({ tool: 'mcp__baton__ask_sender', question: 'x?' } as never))).toContain('No passed task is active')
})

test('the sender sees a waiting question and answers it with /baton-answer', async ($, on) => {
  const w = world(on)
  const id = await passOne($)
  await $.session.receive({ origin: { kind: 'peer' }, text: result(id, 'waiting', '\nwhich region?\nReply with …') })
  expect(w.toasts.at(-1)).toBe(`? api-server-7f waiting #${id} · which region?`)
  const ui = await openPanel($, 'sent')
  expect(await ui.find({ text: new RegExp(`\\? #${id} → api-server-7f\\s+waiting`) })).toBeDefined()
  expect(await ui.find({ text: /\? which region\?/ })).toBeDefined()

  expect((await $.command.run({ command: 'baton-answer', args: `${id} us-east-1, the default` } as never)).text).toContain('Answered')
  expect(w.sent.at(-1)).toBe(`BATON-ANSWER ${id}: us-east-1, the default`)
  expect(w.targets.at(-1)).toBe('api-server-7f')
  expect((await $.command.run({ command: 'baton-answer', args: 'zz hi' } as never)).text).toBe('No task #zz is waiting on an answer.')
})

// ---------- #14 fan-out ----------

test('/pass to several sessions sends one task each and groups them', async ($, on) => {
  const w = world(on)
  listAgents(on)
  const out = await $.command.run({ command: 'pass', args: 'api-server,infra bump lodash to 4.17.21' } as never)
  expect(w.targets).toEqual(['api-server-7f', 'infra-a9'])
  const ids = [...(out.text ?? '').matchAll(/#(\w+)/g)].map(m => m[1])
  expect(ids).toHaveLength(3)
  const [group, first] = ids

  const ui = await openPanel($, 'sent')
  expect(await ui.find({ text: /◇ 0\/2 done  bump lodash/ })).toBeDefined()
  await $.session.receive({ origin: { kind: 'peer' }, text: result(first ?? '', 'done') })
  expect(await ui.find({ text: /◇ 1\/2 done  bump lodash/ })).toBeDefined()
  expect(group).toBeDefined()
})

test('a fan-out with an unknown name sends nothing', async ($, on) => {
  const w = world(on)
  listAgents(on)
  expect((await $.command.run({ command: 'pass', args: 'api-server,billing bump it' } as never)).text).toContain('No session named billing')
  expect(w.sent).toEqual([])
})

// ---------- #15 PR follow-up ----------

const pr = (state: string, checks: { status: string; conclusion: string | null }[]) => JSON.stringify({ state, statusCheckRollup: checks })

test('a GitHub PR is followed until it merges', async ($, on) => {
  const gh: { value?: string | Error } = { value: pr('OPEN', [{ status: 'IN_PROGRESS', conclusion: null }]) }
  const w = world(on, undefined, gh)
  const id = await passOne($)
  await $.session.receive({ origin: { kind: 'peer' }, text: result(id, 'done', '\nPR: https://github.com/o/r/pull/42') })
  await w.clock.advance(0)
  expect(w.ghCalls).toEqual(['gh pr view https://github.com/o/r/pull/42 --json state,statusCheckRollup'])
  const ui = await openPanel($, 'sent')
  expect(await ui.find({ text: /done.*● CI running/ })).toBeDefined()

  gh.value = pr('OPEN', [{ status: 'COMPLETED', conclusion: 'FAILURE' }])
  await w.clock.advance(5 * 60_000)
  expect(await ui.find({ text: /✗ CI failing/ })).toBeDefined()

  gh.value = pr('MERGED', [{ status: 'COMPLETED', conclusion: 'SUCCESS' }])
  await w.clock.advance(5 * 60_000)
  expect(await ui.find({ text: /✓ merged/ })).toBeDefined()
  const calls = w.ghCalls.length
  await w.clock.advance(15 * 60_000)
  expect(w.ghCalls.length).toBe(calls)
})

test('PR follow-up skips non-GitHub links and stops quietly without gh', async ($, on) => {
  const gh: { value?: string | Error } = { value: new Error('gh: not found') }
  const w = world(on, undefined, gh)
  const a = await passOne($)
  await $.session.receive({ origin: { kind: 'peer' }, text: result(a, 'done', '\nPR: https://bitbucket.org/x/pull-requests/7') })
  await w.clock.advance(0)
  expect(w.ghCalls).toEqual([])

  await w.clock.advance(1)
  const b = await passOne($, 'infra-a9')
  await $.session.receive({ origin: { kind: 'peer' }, text: result(b, 'done', '\nPR: https://github.com/o/r/pull/1') })
  await w.clock.advance(0)
  expect(w.ghCalls).toHaveLength(1)
  await w.clock.advance(15 * 60_000)
  expect(w.ghCalls).toHaveLength(1)
  expect(w.toasts.filter(t => t.includes('gh'))).toEqual([])
})

// ---------- #13 worktree mode ----------

test('worktree mode takes a task despite uncommitted changes and works in a worktree', { options: { worktree: true } }, async ($, on) => {
  const w = world(on, { value: true })
  await $.session.receive({ origin: { kind: 'peer' }, text: passed('w1', 'rotate logs') })
  expect(w.sent[0]).toContain('BATON-RESULT w1: started')
  await w.clock.advance(0)
  expect(w.submitted[0]).toContain('git worktree add ../data_dashboards_db-baton-w1')
  expect(w.submitted[0]).toContain('git worktree remove ../data_dashboards_db-baton-w1')
  expect(w.submitted[0]).toContain('Branch off an up-to-date default branch')

  await $.session.receive({ origin: { kind: 'peer' }, text: passed('w2', 'second') })
  expect(w.sent[1]).toContain('busy with #w1')
})

test('without worktree mode the prompt works in this checkout', async ($, on) => {
  const w = world(on)
  await $.session.receive({ origin: { kind: 'peer' }, text: passed('n1', 'rotate logs') })
  await w.clock.advance(0)
  expect(w.submitted[0]).not.toContain('git worktree')
})
