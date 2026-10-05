import type { Panel, Peer, Peers, Queue, Sent } from '../types'

export const FINAL = new Set(['done', 'already-done', 'blocked', 'dropped'])
const PEER_LINE = /^\s+(\S+) \[(\w+)\]\s+·\s+([\w-]+)\s+·\s+([\w-]+)/gm
// claude-mem's background summarisers: not sessions a person passes work to.
const HIDDEN = /^observer-sessions-/

export function parsePeers(listing: string): Peers {
  const me = /^This session is (\S+(?: \[\w+\])?)/m.exec(listing)?.[1] ?? ''
  const list: Peer[] = [...listing.matchAll(PEER_LINE)]
    .map(m => ({ name: m[1] ?? '', ref: m[2] ?? '', mode: m[3] ?? '', state: m[4] ?? '' }))
    .filter(p => !HIDDEN.test(p.name))
  return { me, list }
}

export type View = { peers: Peers; queue: Queue; sent: Sent[]; open: Panel | null }
export type Row = { key: string; text: string; color?: string; isClear?: true }

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
  return [
    { panel: 'me', label: `◆ ${v.peers.me.split(' ')[0] || '…'}` },
    { panel: 'sessions', label: `◎ ${v.peers.list.length}${busy ? ` (${busy} busy)` : ''}` },
    { panel: 'tasks', label: `▶ ${v.queue.active ? 1 : 0} ≡ ${v.queue.backlog.length}` },
    { panel: 'sent', label: `→ ${pending}/${v.sent.length}` },
  ]
}

export function rowsFor(panel: Panel, v: View): Row[] {
  const { peers, queue, sent } = v
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
        ...queue.backlog.map((t, i) => ({ key: t.id, text: `${i + 1}. #${t.id} from ${t.fromLabel}: ${t.task}` })),
        ...(queue.backlog.length ? [] : [{ key: 'empty', text: '≡ backlog empty', color: 'gray' }]),
      ]
    case 'sent':
      return [
        ...(sent.length ? [] : [{ key: 'none', text: 'Nothing passed on yet.', color: 'gray' }]),
        ...sent.map(s => ({
          key: s.id,
          text: `#${s.id} → ${s.agent}  ${s.status}  ${s.task}${s.prUrl ? `  ${s.prUrl}` : ''}`,
          color: s.status === 'blocked' ? 'red' : FINAL.has(s.status) ? 'green' : 'yellow',
        })),
        ...(sent.some(s => FINAL.has(s.status)) ? [{ key: 'clear', text: 'clear finished', isClear: true as const }] : []),
      ]
  }
}
