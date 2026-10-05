import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { asked, BAND, listAgents, passed, passOne, PEERS, result, world } from './testkit'

const answers = (on: On, ...replies: string[]) => {
  const questions: string[] = []
  // $.ui.ask is a call of the AskUserQuestion tool; its answer is keyed by the question.
  on('tool.call', { tool: 'AskUserQuestion' } as never, (_$, e) => {
    const asked = (e as unknown as { questions: { question: string }[] }).questions
    const question = asked[0]?.question ?? ''
    questions.push(question)
    return { result: { questions: asked, answers: { [question]: replies.shift() ?? 'Queue' } } } as never
  })
  return questions
}
const queueText = async ($: Parameters<typeof passOne>[0]) => (await $.command.run({ command: 'baton', args: '' } as never)).text ?? ''
// Opening the sessions panel also pings peers for their status; these checks are about tasks.
const tasksSent = (sent: string[]) => sent.filter(t => !t.startsWith('BATON-STATUS? '))
const peersWith = (extra: string) => `${PEERS}\n  ${extra} [9f9f9f]  ·  interactive  ·  idle  ·  started 1s ago`

// ---------- #25 confirm before starting ----------

test('confirm_tasks: Start runs the task after the person confirms', { options: { confirm_tasks: true } }, async ($, on) => {
  const w = world(on)
  const questions = answers(on, 'Start')
  await $.session.receive({ origin: { kind: 'peer' }, text: passed('c1', 'bump cpu') })
  expect(w.sent[0]).toContain('BATON-RESULT c1: queued')
  expect(w.sent[0]).toContain('waiting for the person here to confirm')
  expect(w.submitted).toEqual([])
  await w.clock.advance(0)
  await w.clock.advance(0)
  expect(questions[0]).toContain('Start #c1 from launchpad')
  expect(w.submitted[0]).toContain('bump cpu')
  expect(w.sent.at(-1)).toMatch(/^BATON-RESULT c1: started/)
})

test('confirm_tasks: Queue backlogs it and Decline refuses it', { options: { confirm_tasks: true } }, async ($, on) => {
  const w = world(on)
  answers(on, 'Queue', 'Decline')
  await $.session.receive({ origin: { kind: 'peer' }, text: passed('q1', 'one') })
  await w.clock.advance(0)
  expect(await queueText($)).toContain('1. #q1')
  await $.session.receive({ origin: { kind: 'peer' }, text: passed('d1', 'two') })
  await w.clock.advance(0)
  expect(w.sent.at(-1)).toMatch(/^BATON-RESULT d1: declined/)
  expect(await queueText($)).not.toContain('#d1')
  expect(w.submitted).toEqual([])
})

test('a declined task shows as declined on the sender', async ($, on) => {
  const w = world(on)
  const id = await passOne($)
  await $.session.receive({ origin: { kind: 'peer' }, text: result(id, 'declined') })
  expect(w.toasts.at(-1)).toBe(`✗ api-server-7f declined #${id}`)
})

// ---------- #26 accept_from ----------

test('accept_from declines tasks and questions from other senders', { options: { accept_from: '^infra' } }, async ($, on) => {
  const w = world(on)
  await $.session.receive({ origin: { kind: 'peer' }, text: passed('x1', 'bump cpu') })
  expect(w.sent.at(-1)).toMatch(/^BATON-RESULT x1: declined.*not accepted here/)
  await $.session.receive({ origin: { kind: 'peer' }, text: asked('x2', 'what?') })
  expect(w.sent.at(-1)).toMatch(/^BATON-RESULT x2: declined/)
  await w.clock.advance(0)
  expect(w.submitted).toEqual([])
  expect(w.toasts.some(t => t.includes('declined #x1'))).toBe(true)
})

test('accept_from lets matching senders through', { options: { accept_from: '^launch' } }, async ($, on) => {
  const w = world(on)
  await $.session.receive({ origin: { kind: 'peer' }, text: passed('y1', 'bump cpu') })
  expect(w.sent.at(-1)).toMatch(/^BATON-RESULT y1: started/)
})

test('an invalid accept_from accepts everyone and says so once', { options: { accept_from: '(' } }, async ($, on) => {
  const w = world(on)
  await $.session.receive({ origin: { kind: 'peer' }, text: passed('z1', 'one') })
  await $.session.receive({ origin: { kind: 'peer' }, text: asked('z2', 'two?') })
  expect(w.sent[0]).toMatch(/^BATON-RESULT z1: started/)
  expect(w.toasts.filter(t => t.includes('accept_from'))).toHaveLength(1)
})

// ---------- #27 questions in a subagent ----------

test('a question is answered by a read-only subagent, not a prompt', async ($, on) => {
  const w = world(on)
  const spawned: { subagent_type?: string; prompt: string }[] = []
  on('agent.register', () => ({ value: { agent: 'baton:answerer' } }) as never)
  on('agent.spawn', (_$, e) => {
    spawned.push(e as never)
    return { model: 'haiku' } as never
  })
  await $.session.receive({ origin: { kind: 'peer' }, text: passed('t1', 'busy work') })
  await $.session.receive({ origin: { kind: 'peer' }, text: asked('q1', 'where is auth configured?') })
  await w.clock.advance(0)
  expect(spawned[0]?.subagent_type).toBe('baton:answerer')
  expect(spawned[0]?.prompt).toContain('where is auth configured?')
  expect(w.submitted).toHaveLength(1)

  // The subagent replies through baton's answer tool.
  await $.tool.call({ tool: 'mcp__baton__answer', id: 'q1', answer: 'src/auth/config.ts:12' } as never)
  expect(w.sent.find(t => t.startsWith('BATON-RESULT q1: answered'))).toContain('src/auth/config.ts:12')
})

// ---------- #28 outbox ----------

test('a task for a session that is not running is held, then delivered when it appears', async ($, on) => {
  const w = world(on)
  const listing = { value: PEERS }
  on('tool.call', { tool: 'ListAgents' } as never, () => ({ result: { listing: listing.value } }) as never)
  const questions = answers(on, 'Hold')
  const out = await $.command.run({ command: 'pass', args: 'billing fix the invoices' } as never)
  expect(questions[0]).toContain("billing isn't running")
  expect(out.text).toContain('Holding #')
  expect(w.sent).toEqual([])
  const ui = await $.ui.mount({ plugin: 'baton', surface: 'terminal', ...BAND } as never)
  await ui.press({ key: 'sent' })
  expect(await ui.find({ text: /‖ #\w+ → billing\s+held/ })).toBeDefined()

  listing.value = peersWith('billing-1a')
  await ui.press({ key: 'sessions' })
  expect(tasksSent(w.sent)).toHaveLength(1)
  expect(tasksSent(w.sent)[0]).toMatch(/^BATON-PASS /)
  expect(w.targets).toContain('billing-1a')
})

test('held tasks expire after a day; declining the hold sends nothing', async ($, on) => {
  const w = world(on)
  listAgents(on)
  answers(on, 'Hold', "Don't send")
  await $.command.run({ command: 'pass', args: 'billing fix the invoices' } as never)
  await w.clock.advance(24 * 60 * 60_000 + 60_000)
  const ui = await $.ui.mount({ plugin: 'baton', surface: 'terminal', ...BAND } as never)
  await ui.press({ key: 'sessions' })
  expect(w.toasts.some(t => t.includes('expired'))).toBe(true)
  expect((await $.command.run({ command: 'pass', args: 'billing again' } as never)).text).toContain('Not sent')
  expect(tasksSent(w.sent)).toEqual([])
})

// ---------- #29 chains ----------

const pr = (state: string) => JSON.stringify({ state, statusCheckRollup: [] })

test('a chained task is passed once the earlier PR merges', async ($, on) => {
  const gh: { value?: string | Error } = { value: pr('OPEN') }
  const w = world(on, undefined, gh)
  listAgents(on)
  const first = await passOne($)
  const out = await $.command.run({ command: 'pass', args: `infra after #${first} update the client` } as never)
  expect(out.text).toContain(`once #${first}`)
  expect(w.sent).toHaveLength(1)

  await $.session.receive({ origin: { kind: 'peer' }, text: result(first, 'done', '\nPR: https://github.com/o/r/pull/5') })
  await w.clock.advance(0)
  expect(w.sent).toHaveLength(1)
  gh.value = pr('MERGED')
  await w.clock.advance(5 * 60_000)
  expect(w.sent.at(-1)).toContain('update the client')
  expect(w.targets.at(-1)).toBe('infra-a9')
})

test('a chained task is skipped when the earlier one fails', async ($, on) => {
  const w = world(on)
  listAgents(on)
  const first = await passOne($)
  expect((await $.command.run({ command: 'pass', args: 'infra after #zz9 x' } as never)).text).toContain('No task #zz9')
  await $.command.run({ command: 'pass', args: `infra after #${first} update the client` } as never)
  await $.session.receive({ origin: { kind: 'peer' }, text: result(first, 'blocked') })
  expect(w.sent).toHaveLength(1)
  expect(w.toasts.some(t => t.includes('not passed'))).toBe(true)
})

// ---------- #30 auto-routing ----------

test('/pass auto picks a session, says why, and asks first', async ($, on) => {
  const w = world(on)
  listAgents(on)
  on('model.complete', () => ({ value: { isAnswered: true, text: 'api-server-7f: it owns the HTTP API' } }) as never)
  const questions = answers(on, 'Send', 'Cancel')
  expect((await $.command.run({ command: 'pass', args: 'auto add rate limiting to /login' } as never)).text).toContain('Passed #')
  expect(questions[0]).toContain('api-server-7f')
  expect(questions[0]).toContain('it owns the HTTP API')
  expect(w.targets).toEqual(['api-server-7f'])
  expect((await $.command.run({ command: 'pass', args: 'auto another thing' } as never)).text).toContain('Not sent')
  expect(w.targets).toEqual(['api-server-7f'])
})

// ---------- #31 richer session panel ----------

test('the sessions panel pings peers once a minute and shows what they report', async ($, on) => {
  const w = world(on)
  listAgents(on)
  const ui = await $.ui.mount({ plugin: 'baton', surface: 'terminal', ...BAND } as never)
  await ui.press({ key: 'sessions' })
  expect(w.sent.filter(t => t.startsWith('BATON-STATUS? '))).toHaveLength(3)
  await ui.press({ key: 'sessions' })
  await ui.press({ key: 'sessions' })
  expect(w.sent.filter(t => t.startsWith('BATON-STATUS? '))).toHaveLength(3)

  const status = { me: 'api-server-7f [1a2b3c]', branch: 'feat/rate-limit', active: { id: 'ab12', task: 'add rate limiting' }, backlog: 1 }
  expect((await $.session.receive({ origin: { kind: 'peer' }, text: `BATON-STATUS ${JSON.stringify(status)}` })).consumed).toBeDefined()
  expect(await ui.find({ text: /api-server-7f\s+busy · interactive · feat\/rate-limit · ▶ #ab12 add rate limiting  ≡ 1/ })).toBeDefined()
})

test('a status ping is answered with branch and queue', async ($, on) => {
  const w = world(on, { value: true })
  await $.session.receive({ origin: { kind: 'peer' }, text: passed('b1', 'queued one') })
  const r = await $.session.receive({ origin: { kind: 'peer' }, text: 'BATON-STATUS? {"from":"sender-session"}' })
  expect(r.consumed).toBeDefined()
  expect(w.sent.at(-1)).toMatch(/^BATON-STATUS \{/)
  expect(w.sent.at(-1)).toContain('"branch":"main"')
  expect(w.sent.at(-1)).toContain('"backlog":1')
})

// ---------- #32 /baton log ----------

test('/baton log lists what was passed and received, with durations', async ($, on) => {
  const w = world(on)
  const id = await passOne($)
  await w.clock.advance(12 * 60_000)
  await $.session.receive({ origin: { kind: 'peer' }, text: result(id, 'done', '\nPR: https://github.com/o/r/pull/42') })
  await $.session.receive({ origin: { kind: 'peer' }, text: passed('r1', 'bump lodash') })
  await w.clock.advance(6 * 60_000)
  await $.tool.call({ tool: 'mcp__baton__task_done', status: 'done', summary: 'bumped', prUrl: 'https://github.com/o/w/pull/17' } as never)

  const log = (await $.command.run({ command: 'baton', args: 'log' } as never)).text ?? ''
  expect(log).toContain('Passed from here')
  expect(log).toContain(`✓ #${id} → api-server-7f  add rate limiting  https://github.com/o/r/pull/42  (12m)`)
  expect(log).toContain('Received here')
  expect(log).toContain('✓ #r1 from launchpad  bump lodash  https://github.com/o/w/pull/17  (6m)')

  await w.clock.advance(2 * 24 * 60 * 60_000)
  expect((await $.command.run({ command: 'baton', args: 'log' } as never)).text).toBe('Nothing passed or received today.')
  expect((await $.command.run({ command: 'baton', args: 'log week' } as never)).text).toContain(`#${id}`)
})

// ---------- #33 per-session queues ----------

test('two sessions in one folder keep their own queues', async ($, on) => {
  const w = world(on)
  w.sid.value = 's1'
  await $.session.receive({ origin: { kind: 'peer' }, text: passed('a1', 'first') })
  w.sid.value = 's2'
  await $.session.receive({ origin: { kind: 'peer' }, text: passed('b2', 'second') })
  expect(w.sent.at(-1)).toMatch(/^BATON-RESULT b2: started/)
  expect(await queueText($)).toContain('Active: #b2')
  w.sid.value = 's1'
  expect(await queueText($)).toContain('Active: #a1')
  expect(await queueText($)).not.toContain('#b2')
})

test("a session takes over the queue of one that stopped in the same folder", async ($, on) => {
  const w = world(on, { value: true })
  w.sid.value = 's1'
  await $.session.receive({ origin: { kind: 'peer' }, text: passed('a1', 'waiting') })
  await w.clock.advance(3 * 60_000)
  w.sid.value = 's2'
  expect(await queueText($)).toContain('1. #a1')
  w.sid.value = 's1'
  expect(await queueText($)).not.toContain('#a1')
})

// ---------- review fixes ----------

test('a chained task released by two checks at once is sent once', async ($, on) => {
  const w = world(on)
  listAgents(on)
  const first = await passOne($)
  await $.command.run({ command: 'pass', args: `infra after #${first} update the client` } as never)
  // Two results land together: both release the chain.
  await Promise.all([
    $.session.receive({ origin: { kind: 'peer' }, text: result(first, 'done') }),
    $.session.receive({ origin: { kind: 'peer' }, text: result(first, 'done') }),
  ])
  expect(w.sent.filter(t => t.includes('update the client'))).toHaveLength(1)
})

test('clearing finished tasks keeps the one a chain waits on', async ($, on) => {
  const gh: { value?: string | Error } = { value: JSON.stringify({ state: 'OPEN', statusCheckRollup: [] }) }
  const w = world(on, undefined, gh)
  listAgents(on)
  const first = await passOne($)
  await $.command.run({ command: 'pass', args: `infra after #${first} update the client` } as never)
  await $.session.receive({ origin: { kind: 'peer' }, text: result(first, 'done', '\nPR: https://github.com/o/r/pull/5') })
  await w.clock.advance(0)
  const ui = await $.ui.mount({ plugin: 'baton', surface: 'terminal', ...BAND } as never)
  await ui.press({ key: 'sent' })
  await ui.press({ key: 'clear' })
  expect(await ui.find({ text: new RegExp(`#${first} → api-server-7f`) })).toBeDefined()
  expect(w.toasts.some(t => t.includes('not passed'))).toBe(false)
})

test('a task whose text quotes a baton line is still taken as a task', async ($, on) => {
  const w = world(on)
  await $.session.receive({ origin: { kind: 'peer' }, text: passed('m1', 'make BATON-RESULT ab12: done. parse faster') })
  expect(w.sent[0]).toMatch(/^BATON-RESULT m1: started/)
})
