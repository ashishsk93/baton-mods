import type { Panel, Peer, Peers, PrState, Queue, Sent } from '../types'

export const FINAL = new Set(['done', 'already-done', 'blocked', 'dropped', 'answered', 'cancelled'])
const PEER_LINE = /^\s+(\S+) \[(\w+)\]\s+·\s+([\w-]+)\s+·\s+([\w-]+)/gm
// claude-mem's background summarisers: not sessions a person passes work to.
export const DEFAULT_HIDDEN = /^observer-sessions-/

export function parsePeers(listing: string, hidden: RegExp = DEFAULT_HIDDEN): Peers {
  const me = /^This session is (\S+(?: \[\w+\])?)/m.exec(listing)?.[1] ?? ''
  const list: Peer[] = [...listing.matchAll(PEER_LINE)]
    .map(m => ({ name: m[1] ?? '', ref: m[2] ?? '', mode: m[3] ?? '', state: m[4] ?? '' }))
    .filter(p => !hidden.test(p.name))
  return { me, list }
}

export type Target = { to: string } | { error: string }

/** Where a typed session name goes: itself, the one peer it is a prefix of, or an error naming the near misses. */
export function matchTarget(peers: Peers, agent: string): Target {
  const name = agent.replace(/ \[\w+\]$/, '')
  if (name && name === peers.me.split(' ')[0]) return { error: `${agent} is this session. Pass it to another one.` }
  if (peers.list.some(p => p.name === name)) return { to: agent }
  const starts = peers.list.filter(p => p.name.startsWith(name))
  const [only] = starts
  if (only && starts.length === 1) return { to: only.name }
  const near = starts.length ? starts : peers.list.filter(p => p.name.includes(name) || name.includes(p.name))
  if (near.length) return { error: `No session named ${agent}. Did you mean ${near.map(p => p.name).join(', ')}?` }
  return { error: `No session named ${agent}. Sessions: ${peers.list.map(p => p.name).join(', ') || 'none'}.` }
}

export type View = { peers: Peers; queue: Queue; sent: Sent[]; open: Panel | null; now: number }
/** `link` draws after the text; `taskId` gives a backlog row its move and drop buttons in the pane. */
export type Row = { key: string; text: string; color?: string; isClear?: true; link?: { href: string; label: string }; taskId?: string }

// A passed task with no word for this long is marked quiet.
export const QUIET_MS = 2 * 60 * 60_000
export const ICONS: Record<string, string> = {
  sent: '○',
  queued: '≡',
  started: '▶',
  done: '✓',
  'already-done': '✓',
  answered: '✓',
  blocked: '✗',
  dropped: '✗',
  cancelled: '✗',
  waiting: '?',
}
export const icon = (s: Sent) => (s.kind === 'ask' && s.status === 'sent' ? '?' : (ICONS[s.status] ?? '·'))

export function ago(ms: number): string {
  const m = Math.floor(ms / 60_000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`
}

const lastWord = (s: Sent) => s.updatedAt ?? s.sentAt
export const isQuiet = (s: Sent, now: number) => {
  const at = lastWord(s)
  return !FINAL.has(s.status) && at !== undefined && now - at >= QUIET_MS
}
export const GITHUB_PR = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/
// Followed until merged or closed.
export const isFollowed = (s: Sent) => !!s.prUrl && GITHUB_PR.test(s.prUrl) && (!s.pr || s.pr.state === 'open')

const BAD = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
/** `gh pr view --json state,statusCheckRollup` → what the row shows; undefined when unreadable. */
export function prState(json: string): PrState | undefined {
  try {
    const raw = JSON.parse(json) as { state?: unknown; statusCheckRollup?: unknown }
    const state = String(raw.state).toLowerCase()
    if (state !== 'open' && state !== 'merged' && state !== 'closed') return undefined
    const runs = Array.isArray(raw.statusCheckRollup) ? (raw.statusCheckRollup as Record<string, unknown>[]) : []
    if (!runs.length) return { state }
    const outcome = (r: Record<string, unknown>) => String(r.conclusion ?? r.state ?? '').toUpperCase()
    if (runs.some(r => BAD.has(outcome(r)))) return { state, checks: 'failing' }
    const isRunning = runs.some(r => (r.status !== undefined && r.status !== 'COMPLETED') || outcome(r) === 'PENDING')
    return { state, checks: isRunning ? 'running' : 'passing' }
  } catch {
    return undefined
  }
}

const prNote = (pr?: PrState) =>
  !pr
    ? ''
    : pr.state === 'merged'
      ? '  ✓ merged'
      : pr.state === 'closed'
        ? '  ✗ closed'
        : pr.checks === 'failing'
          ? '  ✗ CI failing'
          : pr.checks === 'running'
            ? '  ● CI running'
            : pr.checks === 'passing'
              ? '  ✓ CI passing'
              : ''

const prLabel = (url: string) => {
  const n = /\/pull(?:-requests)?\/(\d+)/.exec(url)?.[1]
  return n ? `PR #${n}` : 'PR'
}

export const TITLES: Record<Panel, string> = {
  me: 'This session',
  sessions: 'Sessions',
  tasks: 'Tasks passed to this session',
  sent: 'Tasks passed on',
}

// Glyphs from blocks every monospace font carries, so the terminal and the font agree on width.
export function badges(v: View): { panel: Panel; label: string }[] {
  const busy = v.peers.list.filter(p => p.state === 'busy').length
  const pending = v.sent.filter(s => !FINAL.has(s.status)).length
  const quiet = v.sent.filter(s => isQuiet(s, v.now)).length
  return [
    { panel: 'me', label: `◆ ${v.peers.me.split(' ')[0] || '…'}` },
    { panel: 'sessions', label: `◎ ${v.peers.list.length}${busy ? ` (${busy} busy)` : ''}` },
    { panel: 'tasks', label: `▶ ${v.queue.active ? 1 : 0} ≡ ${v.queue.backlog.length}` },
    { panel: 'sent', label: `→ ${pending}/${v.sent.length}${quiet ? ` (${quiet} quiet)` : ''}` },
  ]
}

export function rowsFor(panel: Panel, v: View): Row[] {
  const { peers, queue, sent, now } = v
  switch (panel) {
    case 'me':
      return [
        { key: 'me', text: `This session: ${peers.me || 'unknown (open ◎ to refresh)'}` },
        { key: 'me-hint', text: 'Other sessions hand tasks to it by that name.', color: 'gray' },
      ]
    case 'sessions':
      return peers.list.length
        ? peers.list.map(p => ({
            key: p.ref,
            text: `${p.state === 'busy' ? '●' : '○'} ${p.name}  ${p.state} · ${p.mode}`,
            color: p.state === 'busy' ? 'yellow' : undefined,
          }))
        : [{ key: 'none', text: 'No other sessions.', color: 'gray' }]
    case 'tasks':
      return [
        queue.active
          ? { key: 'active', text: `▶ #${queue.active.id} from ${queue.active.fromLabel}: ${queue.active.task}`, color: 'green' }
          : { key: 'active', text: '▶ nothing active', color: 'gray' },
        ...queue.backlog.map((t, i) => ({ key: t.id, text: `${i + 1}. #${t.id} from ${t.fromLabel}: ${t.task}`, taskId: t.id })),
        ...(queue.backlog.length ? [] : [{ key: 'empty', text: '≡ backlog empty', color: 'gray' }]),
      ]
    case 'sent':
      return [
        ...(sent.length ? [] : [{ key: 'none', text: 'Nothing passed on yet.', color: 'gray' }]),
        ...groupedRows(sent, now),
        ...(sent.some(s => FINAL.has(s.status)) ? [{ key: 'clear', text: 'clear finished', isClear: true as const }] : []),
      ]
  }
}

function sentRows(s: Sent, now: number, indent: string): Row[] {
  const at = lastWord(s)
  const quiet = isQuiet(s, now)
  const age = at === undefined ? '' : quiet ? ` · no word in ${ago(now - at)}` : ` ${ago(now - at)}`
  return [
    {
      key: s.id,
      text: `${indent}${icon(s)} #${s.id} → ${s.agent}  ${s.status}${age}  ${s.task}${prNote(s.pr)}`,
      color: quiet ? 'gray' : s.status === 'blocked' ? 'red' : FINAL.has(s.status) ? 'green' : 'yellow',
      ...(s.prUrl ? { link: { href: s.prUrl, label: prLabel(s.prUrl) } } : {}),
    },
    ...(s.status === 'waiting' && s.question ? [{ key: `${s.id}-question`, text: `${indent}  ? ${s.question}`, color: 'yellow' }] : []),
    ...(s.answer ? [{ key: `${s.id}-answer`, text: `${indent}  ↳ ${s.answer}`, color: 'gray' }] : []),
  ]
}

// A fan-out draws as one header, where its first member stood, with its members under it.
function groupedRows(sent: Sent[], now: number): Row[] {
  return sent.flatMap((s, i) => {
    if (!s.group) return sentRows(s, now, '')
    if (sent.findIndex(x => x.group === s.group) !== i) return []
    const members = sent.filter(x => x.group === s.group)
    const finished = members.filter(x => FINAL.has(x.status)).length
    const color = members.some(x => x.status === 'blocked') ? 'red' : finished === members.length ? 'green' : 'yellow'
    return [
      { key: `group-${s.group}`, text: `◇ ${finished}/${members.length} done  ${s.task}`, color },
      ...members.flatMap(m => sentRows(m, now, '  ')),
    ]
  })
}
