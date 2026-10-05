/** `receivedAt`: epoch ms the task reached this session (absent before 1.7.0). */
export type Task = { id: string; task: string; from: string; fromLabel: string; receivedAt?: number }
export type Queue = { active: Task | null; backlog: Task[] }
/** A task that left this session's queue: how it ended, and when. */
export type Finished = Task & { status: string; finishedAt?: number; prUrl?: string }
export type Peer = { name: string; ref: string; mode: string; state: string }
export type Peers = { me: string; list: Peer[] }
/** What a peer running baton reports about itself (BATON-STATUS). */
export type PeerStatus = { branch: string; active: { id: string; task: string } | null; backlog: number }
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
  /** A chained task waits on this task or group id. */
  after?: string
}
export type PrState = { state: 'open' | 'merged' | 'closed'; checks?: 'running' | 'passing' | 'failing' }
export type Panel = 'me' | 'sessions' | 'tasks' | 'sent'

declare module 'claude-code' {
  interface PluginState {
    'baton': { peers: Peers; queue: Queue; sent: Sent[]; open: Panel | null; status: Record<string, PeerStatus> }
  }
}
