import type { PeerStatus, Task } from '../types'

// The messages sessions exchange. Each leads with a mark a receiver without this mod can still read.
// Every pattern is anchored to the start of the message: a task's own text may quote any of them.
export const MARK = 'BATON-PASS '
const MARK_LINE = /^\s*BATON-PASS (\{.*\})/
// A question: answered read-only, outside the task queue.
export const ASK_MARK = 'BATON-ASK '
export const ASK_LINE = /^\s*BATON-ASK (\{.*\})/
// The sender takes back a queued task; only the session that passed it may.
export const CANCEL_MARK = 'BATON-CANCEL '
const CANCEL_LINE = /^\s*BATON-CANCEL (\{.*\})/
// The sender's answer to a receiver's ask_sender question.
export const ANSWER_LINE = /^\s*BATON-ANSWER (\w+): ([\s\S]+)/
// Every report, from this mod or from a receiver's model without it, leads with this line.
export const RESULT_LINE = /^\s*BATON-RESULT (\w+): ([\w-]+)/
// A peer asks what this session is on; the reply carries branch, active task and backlog.
export const STATUS_PING = 'BATON-STATUS? '
const STATUS_PING_LINE = /^\s*BATON-STATUS\? (\{.*\})/
export const STATUS_MARK = 'BATON-STATUS '
const STATUS_LINE = /^\s*BATON-STATUS (\{.*\})/
export const URL = /https?:\/\/\S+/

const json = (line: RegExp, text: string): Record<string, unknown> | undefined => {
  const raw = line.exec(text)?.[1]
  if (!raw) return undefined
  try {
    const value: unknown = JSON.parse(raw)
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

export function parse(text: string, line = MARK_LINE): Task | undefined {
  const t = json(line, text)
  if (!t) return undefined
  const ok = ['id', 'task', 'from', 'fromLabel'].every(k => typeof t[k] === 'string' && t[k] !== '')
  return ok ? { id: String(t.id), task: String(t.task), from: String(t.from), fromLabel: String(t.fromLabel) } : undefined
}

export function parseCancel(text: string): { id: string; from: string } | undefined {
  const c = json(CANCEL_LINE, text)
  const id = str(c?.id)
  const from = str(c?.from)
  return id && from ? { id, from } : undefined
}

export const parsePing = (text: string): string | undefined => str(json(STATUS_PING_LINE, text)?.from)

/** A peer's status reply, keyed by its session name (without the `[ref]`). */
export function parseStatus(text: string): { name: string; status: PeerStatus } | undefined {
  const s = json(STATUS_LINE, text)
  const name = str(s?.me)?.split(' ')[0]
  if (!s || !name) return undefined
  const a = s.active as Record<string, unknown> | null | undefined
  const active = a && str(a.id) && str(a.task) ? { id: String(a.id), task: String(a.task) } : null
  return { name, status: { branch: str(s.branch) ?? '', active, backlog: typeof s.backlog === 'number' ? s.backlog : 0 } }
}

/** A regex option: its pattern, or a warning to show once and the fallback when it does not compile. */
export function patternOption(option: unknown, name: string, fallback: string): { re?: RegExp; warning?: string } {
  const pattern = typeof option === 'string' ? option.trim() : ''
  if (!pattern) return {}
  try {
    return { re: new RegExp(pattern) }
  } catch {
    return { warning: `baton: ${name} "${pattern}" is not a valid pattern; ${fallback} instead.` }
  }
}
