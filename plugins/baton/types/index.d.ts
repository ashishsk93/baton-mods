export type Task = { id: string; task: string; from: string; fromLabel: string }
export type Queue = { active: Task | null; backlog: Task[] }
export type Peer = { name: string; ref: string; mode: string; state: string }
export type Peers = { me: string; list: Peer[] }
/** A task this session handed to another; `status` is the last BATON-RESULT heard. */
export type Sent = { id: string; agent: string; task: string; status: string; prUrl?: string }
export type Panel = 'me' | 'sessions' | 'tasks' | 'sent'

declare module 'claude-code' {
  interface PluginState {
    'baton': { peers: Peers; queue: Queue; sent: Sent[]; open: Panel | null }
  }
}
