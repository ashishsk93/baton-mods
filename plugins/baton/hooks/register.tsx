import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Finished, Panel, Queue, Sent, Task } from '../types'
import { answererPrompt, askPrompt, continuePrompt, routePrompt, taskPrompt, waitingDetail } from './prompts'
import { ANSWER_LINE, ASK_LINE, ASK_MARK, CANCEL_MARK, footer, MARK, parse, parseCancel, parsePing, parseStatus } from './protocol'
import { fromFirstMark, senderOf, withoutFooter } from './protocol'
import { RESULT_LINE, STATUS_MARK, STATUS_PING, URL } from './protocol'
import { ACCENT, badges, chainState, FINAL, GITHUB_PR, ICONS, isFollowed, logText, matchTarget } from './shared'
import { LOGO, parsePeers, parsePick, prState, rowsFor, TITLES } from './shared'
import type { Target, View } from './shared'
import { ANSWERER, COMMANDS, STATUSES, TOOLS } from './tools'
import { clip, configFrom, label, mergeQueues, short } from './config'
import { ANSWER_WAIT_MS, AUTO_PICK, HOLD_MS, LOG_WINDOWS, PANE, PANE_COLUMNS, PEERS_EVERY_MS, PING_EVERY_MS, PR_EVERY_MS, STALE_MS } from './config'
import type { Config } from './config'

const peersAtom = atom({ plugin: 'baton', key: 'peers' } as const, { me: '', list: [] })
const queueAtom = atom({ plugin: 'baton', key: 'queue' } as const, { active: null, backlog: [] })
const sentAtom = atom({ plugin: 'baton', key: 'sent' } as const, [])
const openAtom = atom({ plugin: 'baton', key: 'open' } as const, null)
const statusAtom = atom({ plugin: 'baton', key: 'status' } as const, {})

type $ = EngineInterface
/**
 * Per-load state: PR follow-up's timer and whether `gh` is missing, when peers were last
 * pinged, and which answerer subagent owes which question its answer.
 */
type Live = { isPolling: boolean; isGhMissing: boolean; pingedAt: number; answering: Record<string, Task>; hasAnswerer: boolean }


// Receives can overlap; serialise the store's read-modify-write so no task is lost.
let lock: Promise<unknown> = Promise.resolve()
const serial = <T,>(fn: () => Promise<T>): Promise<T> => {
  const run = lock.then(fn, fn)
  lock = run.catch(() => undefined)
  return run
}

// ---------- store: one set of lists per session, adopted from sessions that stopped ----------

const LISTS = ['queue', 'sent', 'asked', 'finished', 'known'] as const
// Adoption runs once per session and load; concurrent callers share the run, and a failed one is retried.
let adoptedFor = ''
let adopting: { key: string; run: Promise<void> } | undefined

async function adoptStale($: $) {
  const [root, sid] = await Promise.all([$.session.root(), $.session.id()])
  const key = `${root}:${sid}`
  if (adoptedFor === key) return
  if (adopting?.key !== key) {
    const run = adoptNow($, root, sid).then(
      () => void (adoptedFor = key),
      () => void (adopting = undefined),
    )
    adopting = { key, run }
  }
  await adopting.run
}

async function adoptNow($: $, root: string, sid: string) {
  const now = await $.clock.now()
  const keys = await $.store.keys()
  // Lists from before 1.7.0 were shared by the folder (no session part); they go to the first session that loads.
  const owners = keys.some(k => LISTS.some(n => k === `${n}:${root}`)) ? [''] : []
  for (const k of keys.filter(k => k.startsWith(`beat:${root}:`) && k !== `beat:${root}:${sid}`)) {
    if (now - Number(await $.store.get(k)) >= STALE_MS) owners.push(k.slice(`beat:${root}:`.length))
  }
  for (const other of owners) {
    for (const n of LISTS) {
      const from = other ? `${n}:${root}:${other}` : `${n}:${root}`
      const theirs = await $.store.get(from)
      if (theirs === undefined) continue
      // Delete before merging, so a second session finds nothing to take. Not atomic across
      // processes: two sessions starting in the same instant may both copy the lists.
      await $.store.delete(from)
      const mine = await $.store.get(`${n}:${root}:${sid}`)
      await $.store.set(`${n}:${root}:${sid}`, n === 'queue' ? mergeQueues(mine as Queue, theirs as Queue) : [...((mine as unknown[]) ?? []), ...(theirs as unknown[])])
    }
    if (other) await $.store.delete(`beat:${root}:${other}`)
  }
  await $.store.set(`beat:${root}:${sid}`, now)
}

const storeKey = async ($: $, name: string) => {
  await adoptStale($)
  return `${name}:${await $.session.root()}:${await $.session.id()}`
}
const beat = async ($: $) => $.store.set(`beat:${await $.session.root()}:${await $.session.id()}`, await $.clock.now())
const load = async ($: $): Promise<Queue> =>
  ((await $.store.get(await storeKey($, 'queue'))) as Queue | undefined) ?? { active: null, backlog: [] }
const save = async ($: $, q: Queue) => {
  await $.store.set(await storeKey($, 'queue'), q)
  await beat($)
  await update($, queueAtom, () => q)
}
const loadSent = async ($: $): Promise<Sent[]> => ((await $.store.get(await storeKey($, 'sent'))) as Sent[] | undefined) ?? []
const changeSent = ($: $, fn: (list: Sent[]) => Sent[]) =>
  serial(async () => {
    const list = fn(await loadSent($)).slice(-50)
    await $.store.set(await storeKey($, 'sent'), list)
    await update($, sentAtom, () => list)
  })
const addSent = async ($: $, entry: Sent) => changeSent($, list => [...list, entry])
/** Patches entry `id` only if its status is still `from`, in one serialised write: true when this call won it. */
async function claim($: $, id: string, from: string, patch: Partial<Sent>): Promise<boolean> {
  const won = { value: false }
  await changeSent($, list =>
    list.map(s => {
      if (s.id !== id || s.status !== from) return s
      won.value = true
      return { ...s, ...patch }
    }),
  )
  return won.value
}
const setSent = ($: $, id: string, patch: Partial<Sent>) => changeSent($, list => list.map(s => (s.id === id ? { ...s, ...patch } : s)))
// Sessions known to run baton: the only ones the sessions panel pings.
const loadKnown = async ($: $): Promise<string[]> => ((await $.store.get(await storeKey($, 'known'))) as string[] | undefined) ?? []
async function addKnown($: $, name: string | undefined) {
  const known = await loadKnown($)
  if (name && !known.includes(name)) await $.store.set(await storeKey($, 'known'), [...known, name].slice(-50))
}
const myName = async ($: $) => (await read($, peersAtom)).me.split(' ')[0] ?? ''
// Questions this session still owes an answer to, so `answer` knows who asked.
const loadAsked = async ($: $): Promise<Task[]> => ((await $.store.get(await storeKey($, 'asked'))) as Task[] | undefined) ?? []
const saveAsked = async ($: $, list: Task[]) => $.store.set(await storeKey($, 'asked'), list.slice(-20))
// Tasks that left this session's queue: for /baton-report and /baton log.
const loadFinished = async ($: $): Promise<Finished[]> =>
  ((await $.store.get(await storeKey($, 'finished'))) as Finished[] | undefined) ?? []
const addFinished = async ($: $, t: Task, status: string, prUrl?: string) => {
  const entry: Finished = { ...t, status, finishedAt: await $.clock.now(), ...(prUrl ? { prUrl } : {}) }
  await $.store.set(await storeKey($, 'finished'), [...(await loadFinished($)).filter(x => x.id !== t.id), entry].slice(-50))
}

// ---------- receiving: tasks and questions ----------

const notify = async ($: $, t: Task, status: string, detail: string) => {
  const text = `BATON-RESULT ${t.id}: ${status}. [${label(await $.session.root())}] "${short(t.task)}" ${detail}${footer(await myName($))}`
  return $.session.send({ to: { sessionId: t.from }, text }).catch(err => $.ui.toast(`baton: cannot reach ${t.fromLabel}: ${err}`))
}

function showWarnings($: $, cfg: Config) {
  for (const w of cfg.warnings.filter(w => !w.isShown)) {
    w.isShown = true
    $.ui.toast(w.text)
  }
}

async function decline($: $, t: Task) {
  $.ui.toast(`baton: declined #${t.id} from ${t.fromLabel} (not accepted here).`)
  await notify($, t, 'declined', 'was not accepted here.')
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

/** Starts the task, or backlogs it when this session is busy (or `isQueued`); tells the sender which. */
async function takeTask($: $, task: Task, cfg: Config, isQueued = false) {
  const outcome = await serial(async () => {
    const q = await load($)
    const why = isQueued ? 'the person here queued it' : await busyReason($, q, cfg)
    if (why) {
      await save($, { ...q, backlog: [...q.backlog, task] })
      return { status: 'queued', detail: `is in the backlog at position ${q.backlog.length + 1} (${why}).` }
    }
    await save($, { ...q, active: task })
    await start($, task, cfg)
    return { status: 'started', detail: 'is now being worked on.' }
  })
  await notify($, task, outcome.status, outcome.detail)
}

async function confirmTask($: $, task: Task, cfg: Config) {
  const choice = await $.ui
    .ask(`Start #${task.id} from ${task.fromLabel}: "${short(task.task)}"?`, { options: ['Start', 'Queue', 'Decline'], header: 'baton' })
    .catch(() => 'Queue')
  if (choice === 'Decline') return void (await notify($, task, 'declined', 'was declined by the person here.'))
  await takeTask($, task, cfg, choice !== 'Start')
}

/** A read-only subagent answers, so the main conversation is never interrupted; a prompt if it cannot run. */
async function answerQuestion($: $, q: Task, live: Live) {
  await serial(async () => saveAsked($, [...(await loadAsked($)).filter(x => x.id !== q.id), q]))
  if (!live.hasAnswerer) live.hasAnswerer = await $.agent.register(ANSWERER).then(() => true, () => false)
  const run = await $.agent
    .spawn({ subagentType: `baton:${ANSWERER.name}`, prompt: answererPrompt(q), description: `Answer #${q.id}` })
    .catch(() => undefined)
  if (!run || run.deny !== undefined) return submitSoon($, q.id, askPrompt(q))
  // It replies through the answer tool; its id, when core gives one, lets turn.complete catch a reply it never sent.
  if (run.agentId) live.answering[run.agentId] = q
  else void $.clock.after(ANSWER_WAIT_MS, () => void askAgain($, q))
}

// The answerer never replied: ask the main session instead.
async function askAgain($: $, q: Task) {
  if ((await loadAsked($)).some(x => x.id === q.id)) submitSoon($, q.id, askPrompt(q))
}

async function confirmQuestion($: $, q: Task, live: Live) {
  const choice = await $.ui
    .ask(`Answer question #${q.id} from ${q.fromLabel}: "${short(q.task)}"?`, { options: ['Answer', 'Decline'], header: 'baton' })
    .catch(() => 'Decline')
  if (choice === 'Answer') await answerQuestion($, q, live)
  else await notify($, q, 'declined', 'was declined by the person here.')
}

async function finishAnswer($: $, id: string, answer: string): Promise<Task | undefined> {
  const q = await serial(async () => {
    const list = await loadAsked($)
    const hit = list.find(x => x.id === id)
    if (hit) await saveAsked($, list.filter(x => x.id !== id))
    return hit
  })
  if (q) await notify($, q, 'answered', `\n${answer.trim() || '(no answer)'}`)
  return q
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

// ---------- passing: send, hold, chain, route ----------

// The counter keeps ids made in the same millisecond apart.
let seq = 0
const newId = () => (Date.now() + seq++).toString(36).slice(-6)

const newTask = async ($: $, task: string, id = newId()): Promise<Task> => {
  const fromName = await myName($)
  return { id, task, from: await $.session.id(), fromLabel: label(await $.session.root()), ...(fromName ? { fromName } : {}) }
}

// The cached list first; on a miss, a fresh ListAgents. With no listing at all, send as typed.
async function resolveTarget($: $, agent: string, cfg: Config): Promise<Target> {
  const first = matchTarget(await read($, peersAtom), agent)
  if ('to' in first) return first
  await refreshPeers($, cfg)
  const peers = await read($, peersAtom)
  return peers.me || peers.list.length ? matchTarget(peers, agent) : { to: agent }
}

// The full prompt rides along, so a receiver without this mod still gets the whole workflow.
const deliver = async ($: $, agent: string, t: Task, cfg: Config) =>
  $.session.send({ to: agent, text: `${MARK}${JSON.stringify(t)}\n\n${taskPrompt(t, cfg.branchRule)}` })

/** One name, or several comma-separated (a fan-out: one task each, grouped). Any bad name sends nothing. */
async function pass($: $, typed: string, task: string, cfg: Config): Promise<string> {
  const names = typed.split(',').map(n => n.trim()).filter(Boolean)
  const targets: Target[] = []
  for (const name of names) targets.push(await resolveTarget($, name, cfg))
  const errors = targets.flatMap(t => ('error' in t ? [t.error] : []))
  const [name] = names
  const [error] = errors
  // One unknown name with no near miss: the session may simply not be running yet.
  if (name && error && names.length === 1 && error.startsWith('No session named') && !error.includes('Did you mean'))
    return holdTask($, name, task, error)
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
  const sent = await deliver($, agent, await newTask($, task, id), cfg)
  if (!sent.isDelivered) return `Not delivered to ${agent}: ${sent.reason}`
  const now = await $.clock.now()
  await addSent($, { id, agent, task, status: 'sent', sentAt: now, updatedAt: now, ...(group ? { group } : {}) })
  return `Passed #${id} to ${agent}. It reports back here when it is queued, started and done.`
}

async function holdTask($: $, name: string, task: string, error: string): Promise<string> {
  const choice = await $.ui
    .ask(`${name} isn't running — hold it and send when it appears?`, { options: ['Hold', "Don't send"], header: 'baton' })
    .catch(() => "Don't send")
  if (choice !== 'Hold') return `Not sent. ${error}`
  const id = newId()
  const now = await $.clock.now()
  await addSent($, { id, agent: name, task, status: 'held', sentAt: now, updatedAt: now })
  return `Holding #${id} for ${name}. It is sent when ${name} shows up, for up to a day.`
}

// On each peer refresh: send held tasks whose session appeared, expire the ones a day old.
async function deliverHeld($: $, cfg: Config) {
  const [peers, now] = [await read($, peersAtom), await $.clock.now()]
  for (const s of (await loadSent($)).filter(s => s.status === 'held')) {
    if (now - (s.sentAt ?? now) >= HOLD_MS) {
      if (await claim($, s.id, 'held', { status: 'expired', updatedAt: now }))
        $.ui.toast(`baton: held task #${s.id} for ${s.agent} expired after a day.`)
      continue
    }
    const target = matchTarget(peers, s.agent)
    // Claimed first, so an overlapping refresh cannot send it too.
    if (!('to' in target) || !(await claim($, s.id, 'held', { agent: target.to, status: 'sent', updatedAt: now }))) continue
    const sent = await deliver($, target.to, await newTask($, s.task, s.id), cfg)
    if (!sent.isDelivered) await setSent($, s.id, { agent: s.agent, status: 'held' })
  }
}

async function chainTask($: $, typed: string, after: string, task: string, cfg: Config): Promise<string> {
  if (!(await loadSent($)).some(s => s.id === after || s.group === after)) return `No task #${after} passed from here.`
  const target = await resolveTarget($, typed, cfg)
  if ('error' in target) return target.error
  const id = newId()
  const now = await $.clock.now()
  await addSent($, { id, agent: target.to, task, status: 'chained', after, sentAt: now, updatedAt: now })
  return `#${id} will be passed to ${target.to} once #${after} is done and its PR merges.`
}

// After any result or PR change: pass chained tasks whose earlier task is in, skip the ones it failed.
async function releaseChains($: $, cfg: Config) {
  const list = await loadSent($)
  const now = await $.clock.now()
  for (const c of list.filter(s => s.status === 'chained' && s.after)) {
    const state = chainState(list, c.after ?? '')
    if (state === 'wait') continue
    if (state === 'failed') {
      if (await claim($, c.id, 'chained', { status: 'skipped', updatedAt: now }))
        $.ui.toast(`baton: #${c.id} was not passed: #${c.after} did not make it in.`)
      continue
    }
    // Claimed first: a PR check and a result can release the same chain at once.
    if (!(await claim($, c.id, 'chained', { status: 'sent', sentAt: now, updatedAt: now }))) continue
    const sent = await deliver($, c.agent, await newTask($, c.task, c.id), cfg)
    if (sent.isDelivered) $.ui.toast(`baton: #${c.after} is in; passed #${c.id} to ${c.agent}.`)
    else await setSent($, c.id, { status: 'chained' })
  }
}

async function autoRoute($: $, task: string, cfg: Config): Promise<string> {
  await refreshPeers($, cfg)
  const names = (await read($, peersAtom)).list.map(p => p.name)
  if (!names.length) return 'No other sessions to pass to.'
  const reply = await $.model.complete({ model: 'haiku', prompt: routePrompt(task, names), maxTokens: 80 }).catch(() => undefined)
  const pick = reply?.isAnswered ? parsePick(reply.text, names) : undefined
  if (!pick) return 'Could not pick a session for this task. Pass it by name.'
  const choice = await $.ui.ask(`Pass it to ${pick.name}? (${pick.reason})`, { options: ['Send', 'Cancel'], header: 'baton' }).catch(() => 'Cancel')
  return choice === 'Send' ? pass($, pick.name, task, cfg) : 'Not sent.'
}

async function ask($: $, typed: string, question: string, cfg: Config): Promise<string> {
  const target = await resolveTarget($, typed, cfg)
  if ('error' in target) return target.error
  const agent = target.to
  const t = await newTask($, question)
  const sent = await $.session.send({ to: agent, text: `${ASK_MARK}${JSON.stringify(t)}\n\n${askPrompt(t)}` })
  if (!sent.isDelivered) return `Not delivered to ${agent}: ${sent.reason}`
  const now = await $.clock.now()
  await addSent($, { id: t.id, agent, task: question, status: 'sent', kind: 'ask', sentAt: now, updatedAt: now })
  return `Asked ${agent} (#${t.id}). The answer comes back here.`
}

// ---------- peers, status and PR follow-up ----------

// ListAgents is the only listing of sessions; a mod reaches it as a tool call.
async function refreshPeers($: EngineInterface, cfg: Config) {
  showWarnings($, cfg)
  await beat($)
  // No listing (denied, errored or unavailable) leaves the last one standing.
  const r = await $.tool.call({ tool: 'ListAgents' }).catch(() => undefined)
  if (!r || r.deny !== undefined || r.isError) return
  await update($, peersAtom, () => parsePeers(r.result.listing, cfg.hidden))
  await deliverHeld($, cfg)
}

// Opening the sessions panel asks peers running baton what they are on, at most once a minute.
async function pingPeers($: $, live: Live) {
  const [now, from, fromName, known] = await Promise.all([$.clock.now(), $.session.id(), myName($), loadKnown($)])
  // A session without baton would read the ping as a message and answer it: ping only known ones.
  const targets = (await read($, peersAtom)).list.filter(p => known.includes(p.name))
  if (!targets.length || now - live.pingedAt < PING_EVERY_MS) return
  live.pingedAt = now
  for (const p of targets)
    await $.session.send({ to: p.name, text: `${STATUS_PING}${JSON.stringify({ from, ...(fromName ? { fromName } : {}) })}` }).catch(() => undefined)
}

async function answerPing($: $, from: string) {
  const [q, peers, git] = await Promise.all([
    load($),
    read($, peersAtom),
    $.process.run(['git', 'branch', '--show-current'], { cwd: await $.session.root() }).catch(() => undefined),
  ])
  const branch = git?.exitCode === 0 ? git.stdout.trim() : ''
  const status = { me: peers.me, branch, active: q.active ? { id: q.active.id, task: short(q.active.task) } : null, backlog: q.backlog.length }
  await $.session.send({ to: { sessionId: from }, text: `${STATUS_MARK}${JSON.stringify(status)}` }).catch(() => undefined)
}

async function checkPrs($: $, cfg: Config, live: Live) {
  if (live.isGhMissing) return
  for (const s of (await loadSent($)).filter(isFollowed)) {
    const r = await $.process.run(['gh', 'pr', 'view', s.prUrl ?? '', '--json', 'state,statusCheckRollup']).catch(() => undefined)
    // gh is not installed or will not start: stop quietly for this load.
    if (!r) return void (live.isGhMissing = true)
    const pr = r.exitCode === 0 ? prState(r.stdout) : undefined
    if (pr) await setSent($, s.id, { pr })
  }
  await releaseChains($, cfg)
}

function followPrs($: $, cfg: Config, live: Live) {
  void checkPrs($, cfg, live)
  if (live.isPolling) return
  live.isPolling = true
  $.clock.every(PR_EVERY_MS, () => void checkPrs($, cfg, live))
}

const snapshot = async ($: $): Promise<View> => {
  const [peers, queue, sent, open, status] = await Promise.all([read($, peersAtom), read($, queueAtom), read($, sentAtom), read($, openAtom), read($, statusAtom)])
  return { peers, queue, sent, open, status, now: await $.clock.now() }
}

async function moveTask($: $, id: string, by: number) {
  await serial(async () => {
    const q = await load($)
    const i = q.backlog.findIndex(t => t.id === id)
    const j = i + by
    const [a, b] = [q.backlog[i], q.backlog[j]]
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

// Keeps finished tasks a pending chain still waits on.
const clearFinished = ($: $) =>
  changeSent($, list => {
    const awaited = new Set(list.filter(s => s.status === 'chained').map(s => s.after))
    return list.filter(s => !FINAL.has(s.status) || awaited.has(s.id) || (s.group !== undefined && awaited.has(s.group)))
  })

// A BATON-RESULT for a task passed from here: update its row, toast what matters, follow its PR.
async function onResult($: $, signed: string, id: string, status: string, cfg: Config, live: Live) {
  await addKnown($, senderOf(signed))
  const text = withoutFooter(signed)
  // An answer is the text after its first line; any URL in it is not a PR.
  const answer = status === 'answered' ? clip(text.split('\n').slice(1).join(' ').trim(), 2000) : ''
  const question = status === 'waiting' ? text.split('\n')[1]?.trim() : undefined
  const prUrl = status === 'answered' || status === 'waiting' ? undefined : URL.exec(text)?.[0]
  const ours = (await loadSent($)).find(s => s.id === id)
  if (!ours) return
  const now = await $.clock.now()
  await setSent($, id, { status, updatedAt: now, ...(prUrl ? { prUrl } : {}), ...(answer ? { answer } : {}), ...(question ? { question } : {}) })
  const extra = prUrl ?? question
  if (FINAL.has(status) || status === 'waiting') $.ui.toast(`${ICONS[status] ?? '·'} ${ours.agent} ${status} #${id}${extra ? ` · ${extra}` : ''}`)
  if (prUrl && GITHUB_PR.test(prUrl)) followPrs($, cfg, live)
  await releaseChains($, cfg)
}

async function openSessions($: $, cfg: Config, live: Live) {
  await refreshPeers($, cfg)
  await pingPeers($, live)
}

export const register: Register = (on, options) => {
  const cfg = configFrom(options)
  const live: Live = { isPolling: false, isGhMissing: false, pingedAt: -Infinity, answering: {}, hasAnswerer: false }
  const accepts = (t: Task) => !cfg.accept || cfg.accept.test(t.fromLabel)

  on('session.start', async ($, e, next) => {
    await Promise.all([...COMMANDS.map(c => $.command.register(c)), ...TOOLS.map(t => $.tool.register(t))])
    live.hasAnswerer = await $.agent.register(ANSWERER).then(
      () => true,
      err => ($.ui.log(`baton: answerer subagent unavailable: ${err}`, { to: 'debug' }), false),
    )
    await save($, await load($))
    await changeSent($, list => list)
    void refreshPeers($, cfg)
    $.clock.every(PEERS_EVERY_MS, () => void refreshPeers($, cfg))
    if ((await loadSent($)).some(isFollowed)) followPrs($, cfg, live)
    return next(e)
  })

  // The answerer is baton's own: the model never delegates to it.
  on('agent.offer', { agent: `baton:${ANSWERER.name}` }, () => ({ isOffered: false }))

  on('turn.complete', async ($, e, next) => {
    const q = e.agentId ? live.answering[e.agentId] : undefined
    if (e.agentId && q) {
      delete live.answering[e.agentId]
      await finishAnswer($, q.id, e.answer)
    }
    return next(e)
  })

  on('session.receive', async ($, e, next) => {
    const body = e.agentId === undefined ? fromFirstMark(e.text) : undefined
    if (!body) return next(e) // for a subagent, or not baton's
    showWarnings($, cfg)
    const ping = parsePing(body)
    if (ping) {
      await addKnown($, ping.fromName)
      await answerPing($, ping.from)
      return { consumed: 'baton status ping' }
    }
    const status = parseStatus(body)
    if (status) {
      await addKnown($, status.name)
      await update($, statusAtom, all => ({ ...all, [status.name]: status.status }))
      return { consumed: `baton status from ${status.name}` }
    }
    // Before results: a question's own text carries a BATON-RESULT line for receivers without this mod.
    const question = parse(body, ASK_LINE)
    if (question) {
      await addKnown($, question.fromName)
      if (!accepts(question)) await decline($, question)
      else if (cfg.confirm) void $.clock.after(0, () => void confirmQuestion($, question, live))
      else await answerQuestion($, question, live)
      return { consumed: `baton question #${question.id} received` }
    }
    const cancel = parseCancel(body)
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
    const [, answerId, answerText] = ANSWER_LINE.exec(body) ?? []
    const active = answerId ? (await load($)).active : null
    if (active && answerText && active.id === answerId) {
      submitSoon($, active.id, continuePrompt(active, answerText.trim()))
      await notify($, active, 'started', 'has the answer and is carrying on.')
      return { consumed: `baton answer for #${active.id}` }
    }
    const [, id, result] = RESULT_LINE.exec(body) ?? []
    if (id && result) {
      await onResult($, body, id, result, cfg, live)
      return next(e)
    }
    const parsed = parse(body)
    if (!parsed) return next(e)
    const task: Task = { ...parsed, receivedAt: await $.clock.now() }
    await addKnown($, task.fromName)
    if (!accepts(task)) await decline($, task)
    else if (cfg.confirm) {
      await notify($, task, 'queued', 'is waiting for the person here to confirm.')
      void $.clock.after(0, () => void confirmTask($, task, cfg))
    } else await takeTask($, task, cfg)
    return { consumed: `baton task #${task.id} received` }
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
    const q = await finishAnswer($, id, answer)
    return q ? { result: `Answered #${id} for ${q.fromLabel}.` } : { deny: `No open question #${id} in this session.` }
  })

  on('tool.call', { tool: /^mcp__baton__task_done$/ }, async ($, e) => {
    const { status, summary, prUrl } = e as unknown as { status?: unknown; summary?: unknown; prUrl?: unknown }
    if (!STATUSES.includes(status as never) || typeof summary !== 'string')
      return { deny: `task_done needs status (${STATUSES.join(', ')}) and summary.` }
    const url = typeof prUrl === 'string' && prUrl ? prUrl : undefined
    const done = await serial(async () => {
      const q = await load($)
      if (q.active) await save($, { ...q, active: null })
      if (q.active) await addFinished($, q.active, String(status), url)
      return q.active
    })
    if (!done) return { deny: 'No passed task is active in this session.' }
    await notify($, done, String(status), `\n${summary}${url ? `\nPR: ${url}` : ''}`)
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
    // Not sent yet: nothing to ask the receiver.
    if (s.status === 'held' || s.status === 'chained') {
      await setSent($, id, { status: 'cancelled', updatedAt: await $.clock.now() })
      return { text: `Cancelled #${id}; it was never sent.` }
    }
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
    const args = e.args.trim()
    const chained = /^(\S+)\s+after\s+#(\w+)\s+([\s\S]+)$/.exec(args)
    if (chained) return { text: await chainTask($, chained[1] ?? '', chained[2] ?? '', chained[3] ?? '', cfg) }
    const [agent = '', ...rest] = args.split(/\s+/)
    const task = rest.join(' ')
    if (!agent || !task) return { text: 'Usage: /pass <agent> <task>' }
    return { text: agent === 'auto' ? await autoRoute($, task, cfg) : await pass($, agent, task, cfg) }
  })

  on('command.run', { command: 'ask' }, async ($, e) => {
    const [agent = '', ...rest] = e.args.trim().split(/\s+/)
    const question = rest.join(' ')
    if (!agent || !question) return { text: 'Usage: /ask <agent> <question>' }
    return { text: await ask($, agent, question, cfg) }
  })

  on('command.run', { command: 'baton' }, async ($, e) => {
    const [sub, span = 'today'] = e.args.trim().split(/\s+/)
    if (sub === 'log') {
      const windowMs = LOG_WINDOWS[span] ?? LOG_WINDOWS.today ?? 0
      return { text: logText(await loadSent($), await loadFinished($), await $.clock.now(), windowMs, span in LOG_WINDOWS ? span : 'today') }
    }
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
      if (q.active && isForce) await addFinished($, q.active, 'dropped')
      return q.active
    })
    if (dropped && !isForce) return { text: `#${dropped.id} is still active. Let it finish (task_done), or run /baton-next force to drop it.` }
    if (dropped) await notify($, dropped, 'dropped', 'was dropped by the person here.')
    return { text: await pickNext($, cfg) }
  })

  // The right end of the prompt footer: the engine's mode labels, dim, then the badges.
  // A one-row footer has no room for details: a press opens the side panel on that tab.
  on('ui.render', { component: 'SessionMode' }, async ($, e) => {
    const v = await snapshot($)
    const { Box, Button, Text } = $.ui.resolve(e)
    const press = (p: Panel) => async () => {
      if (p === 'sessions') void openSessions($, cfg, live)
      await update($, openAtom, () => p)
      await $.ui.open({ id: PANE, title: 'Baton', columns: PANE_COLUMNS })
    }

    return (
      <Box columnGap={2}>
        {e.props.modes.length > 0 && <Text dimColor>{e.props.modes.join(' & ')}</Text>}
        {badges(v).map(b => (
          <Box key={`badge-${b.panel}`}>
            <Text color={ACCENT[b.panel]}>▌</Text>
            <Button key={b.panel} plain dimColor={!!v.open && v.open !== b.panel} label={b.label} onPress={press(b.panel)} />
          </Box>
        ))}
      </Box>
    )
  })

  // The side panel: the BATON banner on top, then the tabs and the open tab's rows.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const v = await snapshot($)
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const panel = v.open ?? 'tasks'
    const pick = (p: Panel) => async () => {
      if (p === 'sessions') void openSessions($, cfg, live)
      await update($, openAtom, () => p)
    }

    return (
      <Box flexDirection="column" rowGap={1}>
        <Box flexDirection="column" alignItems="center">
          <Box columnGap={1}>
            {LOGO.map((l, i) => (
              <Box key={`logo-${i}`} flexDirection="column" width={5}>
                {l.rows.map((r, j) => (
                  <Text key={`logo-${i}-${j}`} color={l.color}>
                    {r}
                  </Text>
                ))}
              </Box>
            ))}
          </Box>
          <Text color="#c792ea" italic>
            ✦ pass the baton ✦
          </Text>
        </Box>
        <Box columnGap={2} flexWrap="wrap">
          {badges(v).map(b => (
            <Box key={`badge-${b.panel}`}>
              <Text color={ACCENT[b.panel]}>▌</Text>
              <Button key={b.panel} plain dimColor={b.panel !== panel} label={b.label} onPress={pick(b.panel)} />
            </Box>
          ))}
        </Box>
        <Text bold color={ACCENT[panel]}>
          {TITLES[panel]}
        </Text>
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
