export type Task = { id: string; task: string; from: string; fromLabel: string }
export type Queue = { active: Task | null; backlog: Task[] }
export type Peer = { name: string; ref: string; mode: string; state: string }
export type Peers = { me: string; list: Peer[] }
/** A task this session handed to another; `status` is the last BATON-RESULT heard. */
export type Sent = {
  id: string
  agent: string
  task: string
  status: string
  prUrl?: string
  kind?: 'ask'
  answer?: string
  /** Epoch ms; absent on entries stored before 1.3.0. */
  sentAt?: number
  updatedAt?: number
  /** Tasks passed in one fan-out share it. */
  group?: string
  /** The receiver's open question while `status` is `waiting`. */
  question?: string
  /** A GitHub PR's last known state, from `gh pr view`. */
  pr?: PrState
}
export type PrState = { state: 'open' | 'merged' | 'closed'; checks?: 'running' | 'passing' | 'failing' }
export type Panel = 'me' | 'sessions' | 'tasks' | 'sent'

declare module 'claude-code' {
  interface PluginState {
    'baton': { peers: Peers; queue: Queue; sent: Sent[]; open: Panel | null }
  }
}
