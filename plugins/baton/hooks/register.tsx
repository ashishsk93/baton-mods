import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Panel, Queue, Sent, Task } from '../types'
import { badges, DEFAULT_HIDDEN, FINAL, GITHUB_PR, ICONS, isFollowed, matchTarget, parsePeers, prState, rowsFor, TITLES } from './shared'
import type { Row, Target, View } from './shared'
import { askPrompt, continuePrompt, taskPrompt, waitingDetail } from './prompts'

const peersAtom = atom({ plugin: 'baton', key: 'peers' } as const, { me: '', list: [] })
const queueAtom = atom({ plugin: 'baton', key: 'queue' } as const, { active: null, backlog: [] })
const sentAtom = atom({ plugin: 'baton', key: 'sent' } as const, [])
const openAtom = atom({ plugin: 'baton', key: 'open' } as const, null)

type $ = EngineInterface
/** PR follow-up for this load: whether its timer runs, and whether `gh` turned out to be missing. */
type Poll = { isOn: boolean; isGhMissing: boolean }
/** The person's options, read once per load. `warning` is a bad hidden_sessions pattern, toasted once. */
type Config = { branchRule: string; hidden: RegExp; worktree: boolean; warning?: { text: string; isShown: boolean } }

const MARK = 'BATON-PASS '
const MARK_LINE = /BATON-PASS (\{.*\})/
// A question: answered read-only, outside the task queue.
const ASK_MARK = 'BATON-ASK '
const ASK_LINE = /BATON-ASK (\{.*\})/
// The sender takes back a queued task; only the session that passed it may.
const CANCEL_MARK = 'BATON-CANCEL '
const CANCEL_LINE = /BATON-CANCEL (\{.*\})/
// The sender's answer to a receiver's ask_sender question.
const ANSWER_LINE = /BATON-ANSWER (\w+): ([\s\S]+)/
// Every report, from this mod or from a receiver's model without it, leads with this line.
const RESULT_LINE = /BATON-RESULT (\w+): ([\w-]+)/
const URL = /https?:\/\/\S+/
const PEERS_EVERY_MS = 20_000
const PR_EVERY_MS = 5 * 60_000
const PANE = 'baton'
const PANE_COLUMNS = 64
const STATUSES = ['done', 'already-done', 'blocked'] as const
// Used when the branch_rule option is unset. The repo's own instructions win when they name one.
const DEFAULT_BRANCH_RULE =
  'Branch off an up-to-date default branch as `<type>/<short-kebab-slug>`, type one of feat, fix, chore, refactor, perf, docs.'
const AUTO_PICK = true

const short = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}...` : s)
const label = (path: string) => path.split('/').filter(Boolean).pop() ?? path

// Receives can overlap; serialise the store's read-modify-write so no task is lost.
let lock: Promise<unknown> = Promise.resolve()
const serial = <T,>(fn: () => Promise<T>): Promise<T> => {
  const run = lock.then(fn, fn)
  lock = run.catch(() => undefined)
  return run
}

// The store keeps both lists past a restart; the atoms are what the band draws from.
const storeKey = async ($: $, name: string) => `${name}:${await $.session.root()}`
const load = async ($: $): Promise<Queue> =>
  ((await $.store.get(await storeKey($, 'queue'))) as Queue | undefined) ?? { active: null, backlog: [] }
const save = async ($: $, q: Queue) => {
  await $.store.set(await storeKey($, 'queue'), q)
  await update($, queueAtom, () => q)
}
const loadSent = async ($: $): Promise<Sent[]> => ((await $.store.get(await storeKey($, 'sent'))) as Sent[] | undefined) ?? []
// Questions this session still owes an answer to, so `answer` knows who asked.
const loadAsked = async ($: $): Promise<Task[]> => ((await $.store.get(await storeKey($, 'asked'))) as Task[] | undefined) ?? []
const saveAsked = async ($: $, list: Task[]) => $.store.set(await storeKey($, 'asked'), list.slice(-20))
// Tasks this session finished or dropped, so /baton-report can still reach their senders.
const loadFinished = async ($: $): Promise<Task[]> => ((await $.store.get(await storeKey($, 'finished'))) as Task[] | undefined) ?? []
const addFinished = async ($: $, t: Task) =>
  $.store.set(await storeKey($, 'finished'), [...(await loadFinished($)).filter(x => x.id !== t.id), t].slice(-20))
const changeSent = ($: $, fn: (list: Sent[]) => Sent[]) =>
  serial(async () => {
    const list = fn(await loadSent($)).slice(-50)
    await $.store.set(await storeKey($, 'sent'), list)
    await update($, sentAtom, () => list)
  })

export function parse(text: string, line = MARK_LINE): Task | undefined {
  const raw = line.exec(text)?.[1]
  if (!raw) return undefined
  try {
    const t = JSON.parse(raw) as Record<string, unknown>
    const ok = ['id', 'task', 'from', 'fromLabel'].every(k => typeof t[k] === 'string' && t[k] !== '')
    return ok ? { id: String(t.id), task: String(t.task), from: String(t.from), fromLabel: String(t.fromLabel) } : undefined
  } catch {
    return undefined
  }
}

const notify = async ($: $, t: Task, status: string, detail: string) => {
  const text = `BATON-RESULT ${t.id}: ${status}. [${label(await $.session.root())}] "${short(t.task)}" ${detail}`
  return $.session.send({ to: { sessionId: t.from }, text }).catch(err => $.ui.toast(`baton: cannot reach ${t.fromLabel}: ${err}`))
}

async function busyReason($: $, q: Queue, cfg: Config): Promise<string | undefined> {
  if (q.active) return `busy with #${q.active.id} "${short(q.active.task)}"`
  // A worktree leaves this checkout's uncommitted work alone, so it is no reason to wait.
  if (cfg.worktree) return undefined
  const git = await $.process.run(['git', 'status', '--porcelain'], { cwd: await $.session.root() })
  return git.exitCode === 0 && git.stdout.trim() ? 'uncommitted changes are already in place' : undefined
}

// A hook (tool call, command) may not submit while its turn runs; a timer may, and the
// engine runs the prompt once this session is idle.
const submitSoon = ($: $, id: string, text: string) =>
  void $.clock.after(0, () => void $.prompt.submit({ text }).catch(err => $.ui.toast(`baton: could not start #${id}: ${err}`)))
async function start($: $, t: Task, cfg: Config) {
  const worktree = cfg.worktree ? `../${label(await $.session.root())}-baton-${t.id}` : undefined
  submitSoon($, t.id, taskPrompt(t, cfg.branchRule, worktree))
}

/** Moves the next backlog task to active and starts it; answers what happened. */
async function pickNext($: $, cfg: Config): Promise<string> {
  const picked = await serial(async () => {
    const q = await load($)
    const [next, ...rest] = q.backlog
    if (!next) return 'The backlog is empty.'
    const why = await busyReason($, q, cfg)
    if (why) return `Not picking up the next task: ${why}.`
    await save($, { active: next, backlog: rest })
    return next
  })
  if (typeof picked === 'string') return picked
  await start($, picked, cfg)
  await notify($, picked, 'started', 'is now being worked on.')
  return `Started #${picked.id} "${short(picked.task)}".`
}

// The counter keeps ids made in the same millisecond apart.
let seq = 0
const newId = () => (Date.now() + seq++).toString(36).slice(-6)

const newTask = async ($: $, task: string, id = newId()): Promise<Task> => ({
  id,
  task,
  from: await $.session.id(),
  fromLabel: label(await $.session.root()),
})

// The cached list first; on a miss, a fresh ListAgents. With no listing at all, send as typed.
async function resolveTarget($: $, agent: string, cfg: Config): Promise<Target> {
  const first = matchTarget(await read($, peersAtom), agent)
  if ('to' in first) return first
  await refreshPeers($, cfg)
  const peers = await read($, peersAtom)
  return peers.me || peers.list.length ? matchTarget(peers, agent) : { to: agent }
}

/** One name, or several comma-separated (a fan-out: one task each, grouped). Any bad name sends nothing. */
async function pass($: $, typed: string, task: string, cfg: Config): Promise<string> {
  const targets: Target[] = []
  for (const name of typed.split(',').map(n => n.trim()).filter(Boolean)) targets.push(await resolveTarget($, name, cfg))
  const errors = targets.flatMap(t => ('error' in t ? [t.error] : []))
  if (errors.length || !targets.length) return errors.join('\n') || 'Usage: /pass <agent>[,<agent>…] <task>'
  const agents = targets.flatMap(t => ('to' in t ? [t.to] : []))
  const [only] = agents
  if (only && agents.length === 1) return sendTask($, only, task, cfg, newId())
  const group = newId()
  const lines: string[] = []
  for (const [i, agent] of agents.entries()) lines.push(await sendTask($, agent, task, cfg, `${group}${String.fromCharCode(97 + i)}`, group))
  return `Passed #${group} to ${agents.length} sessions:\n${lines.join('\n')}`
}

async function sendTask($: $, agent: string, task: string, cfg: Config, id: string, group?: string): Promise<string> {
  const t = await newTask($, task, id)
  const sent = await $.session.send({
    to: agent,
    // The full prompt rides along, so a receiver without this mod still gets the whole workflow.
    text: `${MARK}${JSON.stringify(t)}\n\n${taskPrompt(t, cfg.branchRule)}`,
  })
  if (!sent.isDelivered) return `Not delivered to ${agent}: ${sent.reason}`
  const now = await $.clock.now()
  await changeSent($, list => [...list, { id: t.id, agent, task, status: 'sent', sentAt: now, updatedAt: now, ...(group ? { group } : {}) }])
  return `Passed #${t.id} to ${agent}. It reports back here when it is queued, started and done.`
}

async function ask($: $, typed: string, question: string, cfg: Config): Promise<string> {
  const target = await resolveTarget($, typed, cfg)
  if ('error' in target) return target.error
  const agent = target.to
  const t = await newTask($, question)
  const sent = await $.session.send({ to: agent, text: `${ASK_MARK}${JSON.stringify(t)}\n\n${askPrompt(t)}` })
  if (!sent.isDelivered) return `Not delivered to ${agent}: ${sent.reason}`
  const now = await $.clock.now()
  await changeSent($, list => [...list, { id: t.id, agent, task: question, status: 'sent', kind: 'ask', sentAt: now, updatedAt: now }])
  return `Asked ${agent} (#${t.id}). The answer comes back here.`
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

const snapshot = async ($: $): Promise<View> => {
  const [peers, queue, sent, open, now] = await Promise.all([
    read($, peersAtom),
    read($, queueAtom),
    read($, sentAtom),
    read($, openAtom),
    $.clock.now(),
  ])
  return { peers, queue, sent, open, now }
}

async function moveTask($: $, id: string, by: number) {
  await serial(async () => {
    const q = await load($)
    const i = q.backlog.findIndex(t => t.id === id)
    const j = i + by
    const a = q.backlog[i]
    const b = q.backlog[j]
    if (i < 0 || !a || !b) return
    await save($, { ...q, backlog: q.backlog.map((t, k) => (k === i ? b : k === j ? a : t)) })
  })
}

async function dropTask($: $, id: string) {
  const dropped = await serial(async () => {
    const q = await load($)
    const hit = q.backlog.find(t => t.id === id)
    if (hit) await save($, { ...q, backlog: q.backlog.filter(t => t.id !== id) })
    return hit
  })
  if (dropped) await notify($, dropped, 'dropped', 'was removed from the backlog by the person here.')
}

const clearFinished = ($: $) => changeSent($, list => list.filter(s => !FINAL.has(s.status)))

// ListAgents is the only listing of sessions; a mod reaches it as a tool call.
async function refreshPeers($: EngineInterface, cfg: Config) {
  if (cfg.warning && !cfg.warning.isShown) {
    cfg.warning.isShown = true
    $.ui.toast(cfg.warning.text)
  }
  // No listing (denied, errored or unavailable) leaves the last one standing.
  const r = await $.tool.call({ tool: 'ListAgents' }).catch(() => undefined)
  if (!r || r.deny !== undefined || r.isError) return
  await update($, peersAtom, () => parsePeers(r.result.listing, cfg.hidden))
}

async function checkPrs($: $, poll: Poll) {
  if (poll.isGhMissing) return
  for (const s of (await loadSent($)).filter(isFollowed)) {
    const r = await $.process.run(['gh', 'pr', 'view', s.prUrl ?? '', '--json', 'state,statusCheckRollup']).catch(() => undefined)
    // gh is not installed or will not start: stop quietly for this load.
    if (!r) return void (poll.isGhMissing = true)
    const pr = r.exitCode === 0 ? prState(r.stdout) : undefined
    if (pr) await changeSent($, list => list.map(x => (x.id === s.id ? { ...x, pr } : x)))
  }
}

function followPrs($: $, poll: Poll) {
  void checkPrs($, poll)
  if (poll.isOn) return
  poll.isOn = true
  $.clock.every(PR_EVERY_MS, () => void checkPrs($, poll))
}

function parseCancel(text: string): { id: string; from: string } | undefined {
  const raw = CANCEL_LINE.exec(text)?.[1]
  if (!raw) return undefined
  try {
    const c = JSON.parse(raw) as Record<string, unknown>
    return typeof c.id === 'string' && typeof c.from === 'string' ? { id: c.id, from: c.from } : undefined
  } catch {
    return undefined
  }
}

function hiddenFrom(pattern: string): Pick<Config, 'hidden' | 'warning'> {
  if (!pattern) return { hidden: DEFAULT_HIDDEN }
  try {
    return { hidden: new RegExp(pattern) }
  } catch {
    const text = `baton: hidden_sessions "${pattern}" is not a valid pattern; hiding ${DEFAULT_HIDDEN.source} instead.`
    return { hidden: DEFAULT_HIDDEN, warning: { text, isShown: false } }
  }
}

export const register: Register = (on, options) => {
  const branchRule =
    typeof options.branch_rule === 'string' && options.branch_rule.trim() ? options.branch_rule : DEFAULT_BRANCH_RULE
  const pattern = typeof options.hidden_sessions === 'string' ? options.hidden_sessions.trim() : ''
  const cfg: Config = { branchRule, worktree: options.worktree === true, ...hiddenFrom(pattern) }
  const poll: Poll = { isOn: false, isGhMissing: false }

  on('session.start', async ($, e, next) => {
    await Promise.all([
      $.command.register({ name: 'pass', description: 'Pass a task to another named session', argumentHint: '<agent> <task>', immediate: true }),
      $.command.register({ name: 'ask', description: 'Ask another named session a question about its repo', argumentHint: '<agent> <question>', immediate: true }),
      $.command.register({ name: 'baton', description: 'Show the task this session is working on and its backlog', immediate: true }),
      $.command.register({ name: 'baton-next', description: 'Pick up the next passed task (force: drop the active one first)', argumentHint: '[force]' }),
      $.command.register({ name: 'baton-report', description: 'Report the outcome of a task that already left this session', argumentHint: '<id> <done|already-done|blocked> [PR URL] [summary]', immediate: true }),
      $.command.register({ name: 'baton-cancel', description: 'Take back a task you passed, if it is still queued', argumentHint: '<id>', immediate: true }),
      $.command.register({ name: 'baton-answer', description: 'Answer the question a session asked about a task you passed', argumentHint: '<id> <answer>', immediate: true }),
      $.tool.register({
        name: 'pass',
        description: 'Pass a task to another named Claude session (an agent as ListAgents lists it), or to several at once, comma-separated. It queues the task, takes it to a pull request and reports back.',
        inputSchema: {
          type: 'object',
          properties: { agent: { type: 'string' }, task: { type: 'string', description: 'What to change, in full: the receiver has none of this context.' } },
          required: ['agent', 'task'],
        },
      }),
      $.tool.register({
        name: 'ask',
        description: 'Ask another named Claude session (an agent as ListAgents lists it) a question about its repo. It answers read-only, changing nothing, and the answer comes back here as a message.',
        inputSchema: {
          type: 'object',
          properties: { agent: { type: 'string' }, question: { type: 'string', description: 'The question, in full: the receiver has none of this context.' } },
          required: ['agent', 'question'],
        },
      }),
      $.tool.register({
        name: 'answer',
        description: 'Send the answer to a question another session asked about this repo (a BATON-ASK).',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string' }, answer: { type: 'string' } },
          required: ['id', 'answer'],
        },
      }),
      $.tool.register({
        name: 'ask_sender',
        description: 'Ask the session that passed the active task a question you need answered to go on. Stop after calling it: the answer arrives as a message.',
        inputSchema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
      }),
      $.tool.register({
        name: 'task_done',
        description: 'Finish the passed task this session is working on: reports to the session that sent it and picks up the next queued task.',
        inputSchema: {
          type: 'object',
          properties: { status: { enum: STATUSES }, summary: { type: 'string' }, prUrl: { type: 'string' } },
          required: ['status', 'summary'],
        },
      }),
    ])
    await save($, await load($))
    await changeSent($, list => list)
    void refreshPeers($, cfg)
    $.clock.every(PEERS_EVERY_MS, () => void refreshPeers($, cfg))
    if ((await loadSent($)).some(isFollowed)) followPrs($, poll)
    return next(e)
  })

  on('session.receive', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    // Before results: a question's own text carries a BATON-RESULT line for receivers without this mod.
    const question = parse(e.text, ASK_LINE)
    if (question) {
      await serial(async () => saveAsked($, [...(await loadAsked($)).filter(q => q.id !== question.id), question]))
      submitSoon($, question.id, askPrompt(question))
      return { consumed: `baton question #${question.id} received` }
    }
    const cancel = parseCancel(e.text)
    if (cancel) {
      const hit = await serial(async () => {
        const q = await load($)
        const mine = (t: Task | null) => t?.id === cancel.id && t.from === cancel.from
        const queued = q.backlog.find(mine)
        if (queued) await save($, { ...q, backlog: q.backlog.filter(t => t !== queued) })
        return queued ? { task: queued, isQueued: true } : mine(q.active) && q.active ? { task: q.active, isQueued: false } : undefined
      })
      if (hit?.isQueued) await notify($, hit.task, 'cancelled', 'was removed from the backlog.')
      else if (hit) {
        $.ui.toast(`baton: ${hit.task.fromLabel} asked to cancel #${hit.task.id}, but it is already running.`)
        await notify($, hit.task, 'started', 'is already running, so it cannot be cancelled here.')
      }
      return { consumed: `baton cancel #${cancel.id}` }
    }
    const [, answerId, answerText] = ANSWER_LINE.exec(e.text) ?? []
    const active = answerId ? (await load($)).active : null
    if (active && answerText && active.id === answerId) {
      submitSoon($, active.id, continuePrompt(active, answerText.trim()))
      await notify($, active, 'started', 'has the answer and is carrying on.')
      return { consumed: `baton answer for #${active.id}` }
    }
    const [, id, status] = RESULT_LINE.exec(e.text) ?? []
    if (id && status) {
      // An answer is the text after its first line; any URL in it is not a PR.
      const answer = status === 'answered' ? clip(e.text.split('\n').slice(1).join(' ').trim(), 2000) : ''
      const question = status === 'waiting' ? e.text.split('\n')[1]?.trim() : undefined
      const prUrl = status === 'answered' || status === 'waiting' ? undefined : URL.exec(e.text)?.[0]
      const now = await $.clock.now()
      const ours = (await loadSent($)).find(s => s.id === id)
      await changeSent($, list =>
        list.map(s =>
          s.id === id ? { ...s, status, updatedAt: now, ...(prUrl ? { prUrl } : {}), ...(answer ? { answer } : {}), ...(question ? { question } : {}) } : s,
        ),
      )
      const extra = prUrl ?? question
      if (ours && (FINAL.has(status) || status === 'waiting'))
        $.ui.toast(`${ICONS[status] ?? '·'} ${ours.agent} ${status} #${id}${extra ? ` · ${extra}` : ''}`)
      if (ours && prUrl && GITHUB_PR.test(prUrl)) followPrs($, poll)
      return next(e)
    }
    const task = parse(e.text)
    if (!task) return next(e)
    const outcome = await serial(async () => {
      const q = await load($)
      const why = await busyReason($, q, cfg)
      if (why) {
        await save($, { ...q, backlog: [...q.backlog, task] })
        return { status: 'queued', detail: `is in the backlog at position ${q.backlog.length + 1} (${why}).` }
      }
      await save($, { ...q, active: task })
      await start($, task, cfg)
      return { status: 'started', detail: 'is now being worked on.' }
    })
    await notify($, task, outcome.status, outcome.detail)
    return { consumed: `baton task #${task.id} ${outcome.status}` }
  })

  on('tool.call', { tool: /^mcp__baton__pass$/ }, async ($, e) => {
    const { agent, task } = e as unknown as { agent?: unknown; task?: unknown }
    if (typeof agent !== 'string' || typeof task !== 'string' || !agent.trim() || !task.trim())
      return { deny: 'pass needs a non-empty agent and task.' }
    return { result: await pass($, agent.trim(), task.trim(), cfg) }
  })

  on('tool.call', { tool: /^mcp__baton__ask$/ }, async ($, e) => {
    const { agent, question } = e as unknown as { agent?: unknown; question?: unknown }
    if (typeof agent !== 'string' || typeof question !== 'string' || !agent.trim() || !question.trim())
      return { deny: 'ask needs a non-empty agent and question.' }
    return { result: await ask($, agent.trim(), question.trim(), cfg) }
  })

  on('tool.call', { tool: /^mcp__baton__answer$/ }, async ($, e) => {
    const { id, answer } = e as unknown as { id?: unknown; answer?: unknown }
    if (typeof id !== 'string' || typeof answer !== 'string' || !answer.trim())
      return { deny: 'answer needs the question id and a non-empty answer.' }
    const q = await serial(async () => {
      const list = await loadAsked($)
      const hit = list.find(x => x.id === id)
      if (hit) await saveAsked($, list.filter(x => x.id !== id))
      return hit
    })
    if (!q) return { deny: `No open question #${id} in this session.` }
    await notify($, q, 'answered', `\n${answer.trim()}`)
    return { result: `Answered #${id} for ${q.fromLabel}.` }
  })

  on('tool.call', { tool: /^mcp__baton__task_done$/ }, async ($, e) => {
    const { status, summary, prUrl } = e as unknown as { status?: unknown; summary?: unknown; prUrl?: unknown }
    if (!STATUSES.includes(status as never) || typeof summary !== 'string')
      return { deny: `task_done needs status (${STATUSES.join(', ')}) and summary.` }
    const done = await serial(async () => {
      const q = await load($)
      if (q.active) await save($, { ...q, active: null })
      if (q.active) await addFinished($, q.active)
      return q.active
    })
    if (!done) return { deny: 'No passed task is active in this session.' }
    const pr = typeof prUrl === 'string' && prUrl ? `\nPR: ${prUrl}` : ''
    await notify($, done, String(status), `\n${summary}${pr}`)
    const after = AUTO_PICK ? await pickNext($, cfg) : 'Run /baton-next to pick up the next one.'
    return { result: `Reported #${done.id} to ${done.fromLabel}. ${after}` }
  })

  on('tool.call', { tool: /^mcp__baton__ask_sender$/ }, async ($, e) => {
    const { question } = e as unknown as { question?: unknown }
    if (typeof question !== 'string' || !question.trim()) return { deny: 'ask_sender needs a question.' }
    const { active } = await load($)
    if (!active) return { deny: 'No passed task is active in this session.' }
    await notify($, active, 'waiting', waitingDetail(active.id, question.trim()))
    return { result: `Asked ${active.fromLabel}. Stop here: the answer arrives as a message and the task carries on.` }
  })

  on('command.run', { command: 'baton-report' }, async ($, e) => {
    const [id = '', status = '', ...rest] = e.args.trim().split(/\s+/)
    if (!id || !STATUSES.includes(status as never))
      return { text: `Usage: /baton-report <id> <${STATUSES.join('|')}> [PR URL] [summary]` }
    const finished = await loadFinished($)
    const t = finished.find(x => x.id === id)
    if (!t) return { text: `No recent task #${id} here. Recent: ${finished.map(x => `#${x.id}`).join(', ') || 'none'}.` }
    const url = rest[0] && /^https?:\/\//.test(rest[0]) ? rest[0] : undefined
    const summary = (url ? rest.slice(1) : rest).join(' ') || 'Reported by the person here.'
    await notify($, t, status, `\n${summary}${url ? `\nPR: ${url}` : ''}`)
    return { text: `Reported #${id} to ${t.fromLabel}: ${status}.` }
  })

  on('command.run', { command: 'baton-cancel' }, async ($, e) => {
    const id = e.args.trim()
    if (!id) return { text: 'Usage: /baton-cancel <id>' }
    const s = (await loadSent($)).find(x => x.id === id && !FINAL.has(x.status))
    if (!s) return { text: `No open task #${id} passed from here.` }
    const sent = await $.session.send({ to: s.agent, text: `${CANCEL_MARK}${JSON.stringify({ id, from: await $.session.id() })}` })
    if (!sent.isDelivered) return { text: `Not delivered to ${s.agent}: ${sent.reason}` }
    return { text: `Asked ${s.agent} to cancel #${id}. It replies "cancelled" if the task was still queued.` }
  })

  on('command.run', { command: 'baton-answer' }, async ($, e) => {
    const [id = '', ...rest] = e.args.trim().split(/\s+/)
    const answer = rest.join(' ')
    if (!id || !answer) return { text: 'Usage: /baton-answer <id> <answer>' }
    const s = (await loadSent($)).find(x => x.id === id && x.status === 'waiting')
    if (!s) return { text: `No task #${id} is waiting on an answer.` }
    const sent = await $.session.send({ to: s.agent, text: `BATON-ANSWER ${id}: ${answer}` })
    if (!sent.isDelivered) return { text: `Not delivered to ${s.agent}: ${sent.reason}` }
    return { text: `Answered #${id} for ${s.agent}.` }
  })

  on('command.run', { command: 'pass' }, async ($, e) => {
    const [agent = '', ...rest] = e.args.trim().split(/\s+/)
    const task = rest.join(' ')
    if (!agent || !task) return { text: 'Usage: /pass <agent> <task>' }
    return { text: await pass($, agent, task, cfg) }
  })

  on('command.run', { command: 'ask' }, async ($, e) => {
    const [agent = '', ...rest] = e.args.trim().split(/\s+/)
    const question = rest.join(' ')
    if (!agent || !question) return { text: 'Usage: /ask <agent> <question>' }
    return { text: await ask($, agent, question, cfg) }
  })

  on('command.run', { command: 'baton' }, async $ => {
    const q = await load($)
    const lines = [
      q.active ? `Active: #${q.active.id} from ${q.active.fromLabel}: ${q.active.task}` : 'Active: none',
      ...q.backlog.map((t, i) => `${i + 1}. #${t.id} from ${t.fromLabel}: ${t.task}`),
    ]
    return { text: lines.join('\n') }
  })

  on('command.run', { command: 'baton-next' }, async ($, e) => {
    const isForce = e.args.trim() === 'force'
    const dropped = await serial(async () => {
      const q = await load($)
      if (q.active && isForce) await save($, { ...q, active: null })
      if (q.active && isForce) await addFinished($, q.active)
      return q.active
    })
    if (dropped && !isForce) return { text: `#${dropped.id} is still active. Let it finish (task_done), or run /baton-next force to drop it.` }
    if (dropped) await notify($, dropped, 'dropped', 'was dropped by the person here.')
    return { text: await pickNext($, cfg) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const v = await snapshot($)
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    // Fullscreen docks a pane beside the transcript: details go there, not under the band.
    const docks = e.viewport?.isFullscreen === true
    const width = Math.max(20, e.props.bodyColumns - 4)
    const press = (p: Panel) => async () => {
      if (p === 'sessions') void refreshPeers($, cfg)
      if (!docks) return void (await update($, openAtom, o => (o === p ? null : p)))
      await update($, openAtom, () => p)
      await $.ui.open({ id: PANE, title: 'Baton', columns: PANE_COLUMNS })
    }
    const draw = (r: Row) =>
      r.isClear ? (
        <Button key={r.key} plain dimColor label={r.text} onPress={() => clearFinished($)} />
      ) : (
        <Text key={r.key} color={r.color} wrap="truncate-end">
          {r.link ? `${clip(r.text, width - r.link.label.length - 2)}  ` : clip(r.text, width)}
          {r.link ? <Link href={r.link.href} label={r.link.label} /> : null}
        </Text>
      )

    return (
      <Box flexDirection="column" width={e.props.bodyColumns}>
        <Box columnGap={2} justifyContent="flex-end">
          {badges(v).map(b => (
            <Button key={b.panel} plain label={b.label} onPress={press(b.panel)} />
          ))}
        </Box>
        {!docks && v.open && (
          <Box flexDirection="column" alignItems="flex-end">
            {rowsFor(v.open, v).map(draw)}
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const v = await snapshot($)
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const panel = v.open ?? 'tasks'
    const pick = (p: Panel) => async () => {
      if (p === 'sessions') void refreshPeers($, cfg)
      await update($, openAtom, () => p)
    }

    return (
      <Box flexDirection="column" rowGap={1}>
        <Box columnGap={2} flexWrap="wrap">
          {badges(v).map(b => (
            <Button key={b.panel} plain dimColor={b.panel !== panel} label={b.label} onPress={pick(b.panel)} />
          ))}
        </Box>
        <Text bold>{TITLES[panel]}</Text>
        <Box flexDirection="column">
          {rowsFor(panel, v).map(r => {
            if (r.isClear) return <Button key={r.key} plain dimColor label={r.text} onPress={() => clearFinished($)} />
            const text = (
              <Text key={r.key} color={r.color} wrap="wrap">
                {r.link ? `${r.text}  ` : r.text}
                {r.link ? <Link href={r.link.href} label={r.link.label} /> : null}
              </Text>
            )
            const id = r.taskId
            if (!id) return text
            return (
              <Box key={r.key} columnGap={1}>
                {text}
                <Button key={`up-${id}`} plain dimColor label="↑" onPress={() => moveTask($, id, -1)} />
                <Button key={`down-${id}`} plain dimColor label="↓" onPress={() => moveTask($, id, 1)} />
                <Button key={`drop-${id}`} plain dimColor label="✕" onPress={() => dropTask($, id)} />
              </Box>
            )
          })}
        </Box>
      </Box>
    )
  })
}
