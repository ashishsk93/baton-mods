import type { Queue } from '../types'
import { patternOption } from './protocol'
import { DEFAULT_HIDDEN } from './shared'

// Timings and layout.
export const PEERS_EVERY_MS = 20_000
export const PR_EVERY_MS = 5 * 60_000
export const PING_EVERY_MS = 60_000
export const ANSWER_WAIT_MS = 5 * 60_000
export const HOLD_MS = 24 * 60 * 60_000
// A session whose heartbeat is older than this has stopped; another in its folder takes its lists.
export const STALE_MS = 2 * 60_000
export const LOG_WINDOWS: Record<string, number> = { today: 24 * 60 * 60_000, week: 7 * 24 * 60 * 60_000 }
export const PANE = 'baton'
export const PANE_COLUMNS = 64
export const AUTO_PICK = true

export type Warning = { text: string; isShown: boolean }
/** The person's options, read once per load. Bad patterns become warnings, each toasted once. */
export type Config = { branchRule: string; hidden: RegExp; accept?: RegExp; worktree: boolean; confirm: boolean; warnings: Warning[] }
// Used when the branch_rule option is unset. The repo's own instructions win when they name one.
const DEFAULT_BRANCH_RULE =
  'Branch off an up-to-date default branch as `<type>/<short-kebab-slug>`, type one of feat, fix, chore, refactor, perf, docs.'

export const short = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}...` : s)
export const label = (path: string) => path.split('/').filter(Boolean).pop() ?? path
export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

// An adopted active task was cut off mid-way: it goes back to the front of the backlog.
export const mergeQueues = (mine: Queue | undefined, theirs: Queue): Queue => ({
  active: mine?.active ?? null,
  backlog: [...(theirs.active ? [theirs.active] : []), ...(mine?.backlog ?? []), ...theirs.backlog],
})

export function configFrom(options: Record<string, unknown>): Config {
  const hidden = patternOption(options.hidden_sessions, 'hidden_sessions', `hiding ${DEFAULT_HIDDEN.source}`)
  const accept = patternOption(options.accept_from, 'accept_from', 'accepting every session')
  return {
    branchRule: typeof options.branch_rule === 'string' && options.branch_rule.trim() ? options.branch_rule : DEFAULT_BRANCH_RULE,
    hidden: hidden.re ?? DEFAULT_HIDDEN,
    ...(accept.re ? { accept: accept.re } : {}),
    worktree: options.worktree === true,
    confirm: options.confirm_tasks === true,
    warnings: [hidden.warning, accept.warning].flatMap(text => (text ? [{ text, isShown: false }] : [])),
  }
}
