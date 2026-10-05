import type { Panel, Peer, Peers, Queue, Sent } from '../types'

export const FINAL = new Set(['done', 'already-done', 'blocked', 'dropped', 'answered'])
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
        ...sent.flatMap(s => {
          const at = lastWord(s)
          const quiet = isQuiet(s, now)
          const age = at === undefined ? '' : quiet ? ` · no word in ${ago(now - at)}` : ` ${ago(now - at)}`
          return [
            {
              key: s.id,
              text: `${icon(s)} #${s.id} → ${s.agent}  ${s.status}${age}  ${s.task}`,
              color: quiet ? 'gray' : s.status === 'blocked' ? 'red' : FINAL.has(s.status) ? 'green' : 'yellow',
              ...(s.prUrl ? { link: { href: s.prUrl, label: prLabel(s.prUrl) } } : {}),
            },
            ...(s.answer ? [{ key: `${s.id}-answer`, text: `  ↳ ${s.answer}`, color: 'gray' }] : []),
          ]
        }),
        ...(sent.some(s => FINAL.has(s.status)) ? [{ key: 'clear', text: 'clear finished', isClear: true as const }] : []),
      ]
  }
}
