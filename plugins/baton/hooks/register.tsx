import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Panel, Queue, Sent, Task } from '../types'
import { badges, FINAL, parsePeers, rowsFor, TITLES } from './shared'
import type { Row, View } from './shared'

const peersAtom = atom({ plugin: 'baton', key: 'peers' } as const, { me: '', list: [] })
const queueAtom = atom({ plugin: 'baton', key: 'queue' } as const, { active: null, backlog: [] })
const sentAtom = atom({ plugin: 'baton', key: 'sent' } as const, [])
const openAtom = atom({ plugin: 'baton', key: 'open' } as const, null)

type $ = EngineInterface

const MARK = 'BATON-PASS '
const MARK_LINE = /BATON-PASS (\{.*\})/
// A question: answered read-only, outside the task queue.
const ASK_MARK = 'BATON-ASK '
const ASK_LINE = /BATON-ASK (\{.*\})/
// Every report, from this mod or from a receiver's model without it, leads with this line.
const RESULT_LINE = /BATON-RESULT (\w+): ([\w-]+)/
const URL = /https?:\/\/\S+/
const PEERS_EVERY_MS = 20_000
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

const taskPrompt = (t: Task, branchRule: string) =>
  [
    `Task #${t.id}, passed from ${t.fromLabel}:`,
    '',
    t.task,
    '',
    'Take it through to a pull request that is ready for review:',
    '1. Check first whether this change is already in place. If it is, change nothing and call the task_done tool with status "already-done" and what you found.',
    `2. ${branchRule} If this repo's own instructions name a branch rule, use that one.`,
    '3. Make the change, run the checks this repo has, and commit.',
    "4. Push the branch and open a pull request with the tooling this repo's remote supports. If you cannot open one, push and give the URL to create it.",
    '5. Call the task_done tool with status "done", a short summary and the PR URL. If you are blocked, call it with status "blocked" and the reason.',
    `   No task_done tool? Send the report with SendMessage to the session that sent this message, its first line \`BATON-RESULT ${t.id}: <done|already-done|blocked>.\``,
  ].join('\n')

const askPrompt = (t: Task) =>
  [
    `Question #${t.id} from ${t.fromLabel}, about this repo:`,
    '',
    t.task,
    '',
    "Answer it from this repo: its code, docs, config and git history. Read only: change no files, and do not branch, commit or push.",
    `Then call the answer tool with id "${t.id}" and your answer: short and specific, with file paths and line numbers where they help.`,
    `   No answer tool? Send the answer with SendMessage to the session that sent this message, its first line \`BATON-RESULT ${t.id}: answered.\``,
  ].join('\n')

const notify = async ($: $, t: Task, status: string, detail: string) => {
  const text = `BATON-RESULT ${t.id}: ${status}. [${label(await $.session.root())}] "${short(t.task)}" ${detail}`
  return $.session.send({ to: { sessionId: t.from }, text }).catch(err => $.ui.toast(`baton: cannot reach ${t.fromLabel}: ${err}`))
}

async function busyReason($: $, q: Queue): Promise<string | undefined> {
  if (q.active) return `busy with #${q.active.id} "${short(q.active.task)}"`
  const git = await $.process.run(['git', 'status', '--porcelain'], { cwd: await $.session.root() })
  return git.exitCode === 0 && git.stdout.trim() ? 'uncommitted changes are already in place' : undefined
}

// A hook (tool call, command) may not submit while its turn runs; a timer may, and the
// engine runs the prompt once this session is idle.
const submitSoon = ($: $, id: string, text: string) =>
  void $.clock.after(0, () => void $.prompt.submit({ text }).catch(err => $.ui.toast(`baton: could not start #${id}: ${err}`)))
const start = ($: $, t: Task, branchRule: string) => submitSoon($, t.id, taskPrompt(t, branchRule))

/** Moves the next backlog task to active and starts it; answers what happened. */
async function pickNext($: $, branchRule: string): Promise<string> {
  const picked = await serial(async () => {
    const q = await load($)
    const [next, ...rest] = q.backlog
    if (!next) return 'The backlog is empty.'
    const why = await busyReason($, q)
    if (why) return `Not picking up the next task: ${why}.`
    await save($, { active: next, backlog: rest })
    return next
  })
  if (typeof picked === 'string') return picked
  start($, picked, branchRule)
  await notify($, picked, 'started', 'is now being worked on.')
  return `Started #${picked.id} "${short(picked.task)}".`
}

const newTask = async ($: $, task: string): Promise<Task> => ({
  id: Date.now().toString(36).slice(-6),
  task,
  from: await $.session.id(),
  fromLabel: label(await $.session.root()),
})

async function pass($: $, agent: string, task: string, branchRule: string): Promise<string> {
  const t = await newTask($, task)
  const sent = await $.session.send({
    to: agent,
    // The full prompt rides along, so a receiver without this mod still gets the whole workflow.
    text: `${MARK}${JSON.stringify(t)}\n\n${taskPrompt(t, branchRule)}`,
  })
  if (!sent.isDelivered) return `Not delivered to ${agent}: ${sent.reason}`
  await changeSent($, list => [...list, { id: t.id, agent, task, status: 'sent' }])
  return `Passed #${t.id} to ${agent}. It reports back here when it is queued, started and done.`
}

async function ask($: $, agent: string, question: string): Promise<string> {
  const t = await newTask($, question)
  const sent = await $.session.send({ to: agent, text: `${ASK_MARK}${JSON.stringify(t)}\n\n${askPrompt(t)}` })
  if (!sent.isDelivered) return `Not delivered to ${agent}: ${sent.reason}`
  await changeSent($, list => [...list, { id: t.id, agent, task: question, status: 'sent', kind: 'ask' }])
  return `Asked ${agent} (#${t.id}). The answer comes back here.`
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

const snapshot = async ($: $): Promise<View> => {
  const [peers, queue, sent, open] = await Promise.all([read($, peersAtom), read($, queueAtom), read($, sentAtom), read($, openAtom)])
  return { peers, queue, sent, open }
}

const clearFinished = ($: $) => changeSent($, list => list.filter(s => !FINAL.has(s.status)))

// ListAgents is the only listing of sessions; a mod reaches it as a tool call.
async function refreshPeers($: EngineInterface) {
  const r = await $.tool.call({ tool: 'ListAgents' })
  if (r.deny !== undefined || r.isError) return
  await update($, peersAtom, () => parsePeers(r.result.listing))
}

export const register: Register = (on, options) => {
  const branchRule =
    typeof options.branch_rule === 'string' && options.branch_rule.trim() ? options.branch_rule : DEFAULT_BRANCH_RULE

  on('session.start', async ($, e, next) => {
    await Promise.all([
      $.command.register({ name: 'pass', description: 'Pass a task to another named session', argumentHint: '<agent> <task>', immediate: true }),
      $.command.register({ name: 'ask', description: 'Ask another named session a question about its repo', argumentHint: '<agent> <question>', immediate: true }),
      $.command.register({ name: 'baton', description: 'Show the task this session is working on and its backlog', immediate: true }),
      $.command.register({ name: 'baton-next', description: 'Pick up the next passed task (force: drop the active one first)', argumentHint: '[force]' }),
      $.tool.register({
        name: 'pass',
        description: 'Pass a task to another named Claude session (an agent as ListAgents lists it). It queues the task, takes it to a pull request and reports back.',
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
    void refreshPeers($)
    $.clock.every(PEERS_EVERY_MS, () => void refreshPeers($))
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
    const [, id, status] = RESULT_LINE.exec(e.text) ?? []
    if (id && status) {
      // An answer is the text after its first line; any URL in it is not a PR.
      const answer = status === 'answered' ? clip(e.text.split('\n').slice(1).join(' ').trim(), 2000) : ''
      const prUrl = status === 'answered' ? undefined : URL.exec(e.text)?.[0]
      await changeSent($, list =>
        list.map(s => (s.id === id ? { ...s, status, ...(prUrl ? { prUrl } : {}), ...(answer ? { answer } : {}) } : s)),
      )
      return next(e)
    }
    const task = parse(e.text)
    if (!task) return next(e)
    const outcome = await serial(async () => {
      const q = await load($)
      const why = await busyReason($, q)
      if (why) {
        await save($, { ...q, backlog: [...q.backlog, task] })
        return { status: 'queued', detail: `is in the backlog at position ${q.backlog.length + 1} (${why}).` }
      }
      await save($, { ...q, active: task })
      start($, task, branchRule)
      return { status: 'started', detail: 'is now being worked on.' }
    })
    await notify($, task, outcome.status, outcome.detail)
    return { consumed: `baton task #${task.id} ${outcome.status}` }
  })

  on('tool.call', { tool: /^mcp__baton__pass$/ }, async ($, e) => {
    const { agent, task } = e as unknown as { agent?: unknown; task?: unknown }
    if (typeof agent !== 'string' || typeof task !== 'string' || !agent.trim() || !task.trim())
      return { deny: 'pass needs a non-empty agent and task.' }
    return { result: await pass($, agent.trim(), task.trim(), branchRule) }
  })

  on('tool.call', { tool: /^mcp__baton__ask$/ }, async ($, e) => {
    const { agent, question } = e as unknown as { agent?: unknown; question?: unknown }
    if (typeof agent !== 'string' || typeof question !== 'string' || !agent.trim() || !question.trim())
      return { deny: 'ask needs a non-empty agent and question.' }
    return { result: await ask($, agent.trim(), question.trim()) }
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
      return q.active
    })
    if (!done) return { deny: 'No passed task is active in this session.' }
    const pr = typeof prUrl === 'string' && prUrl ? `\nPR: ${prUrl}` : ''
    await notify($, done, String(status), `\n${summary}${pr}`)
    const after = AUTO_PICK ? await pickNext($, branchRule) : 'Run /baton-next to pick up the next one.'
    return { result: `Reported #${done.id} to ${done.fromLabel}. ${after}` }
  })

  on('command.run', { command: 'pass' }, async ($, e) => {
    const [agent = '', ...rest] = e.args.trim().split(/\s+/)
    const task = rest.join(' ')
    if (!agent || !task) return { text: 'Usage: /pass <agent> <task>' }
    return { text: await pass($, agent, task, branchRule) }
  })

  on('command.run', { command: 'ask' }, async ($, e) => {
    const [agent = '', ...rest] = e.args.trim().split(/\s+/)
    const question = rest.join(' ')
    if (!agent || !question) return { text: 'Usage: /ask <agent> <question>' }
    return { text: await ask($, agent, question) }
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
      return q.active
    })
    if (dropped && !isForce) return { text: `#${dropped.id} is still active. Let it finish (task_done), or run /baton-next force to drop it.` }
    if (dropped) await notify($, dropped, 'dropped', 'was dropped by the person here.')
    return { text: await pickNext($, branchRule) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const v = await snapshot($)
    const { Box, Button, Text } = $.ui.resolve(e)
    // Fullscreen docks a pane beside the transcript: details go there, not under the band.
    const docks = e.viewport?.isFullscreen === true
    const width = Math.max(20, e.props.bodyColumns - 4)
    const press = (p: Panel) => async () => {
      if (p === 'sessions') void refreshPeers($)
      if (!docks) return void (await update($, openAtom, o => (o === p ? null : p)))
      await update($, openAtom, () => p)
      await $.ui.open({ id: PANE, title: 'Baton', columns: PANE_COLUMNS })
    }
    const draw = (r: Row) =>
      r.isClear ? (
        <Button key={r.key} plain dimColor label={r.text} onPress={() => clearFinished($)} />
      ) : (
        <Text key={r.key} color={r.color} wrap="truncate-end">
          {clip(r.text, width)}
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
    const { Box, Button, Text } = $.ui.resolve(e)
    const panel = v.open ?? 'tasks'
    const pick = (p: Panel) => async () => {
      if (p === 'sessions') void refreshPeers($)
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
          {rowsFor(panel, v).map(r =>
            r.isClear ? (
              <Button key={r.key} plain dimColor label={r.text} onPress={() => clearFinished($)} />
            ) : (
              <Text key={r.key} color={r.color} wrap="wrap">
                {r.text}
              </Text>
            ),
          )}
        </Box>
      </Box>
    )
  })
}
