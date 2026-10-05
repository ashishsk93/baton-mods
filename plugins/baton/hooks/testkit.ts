import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

export const passed = (id: string, task: string) =>
  `BATON-PASS ${JSON.stringify({ id, task, from: 'sender-session', fromLabel: 'launchpad' })}\n\nTask from launchpad: ${task}`

export const asked = (id: string, question: string) =>
  `BATON-ASK ${JSON.stringify({ id, task: question, from: 'sender-session', fromLabel: 'web-app' })}\n\nQuestion from web-app: ${question}`

export const result = (id: string, status: string, rest = '') => `BATON-RESULT ${id}: ${status}. [api] "task"${rest}`

export function world(on: On, dirty = { value: false }, gh: { value?: string | Error } = {}) {
  const sent: string[] = []
  const targets: unknown[] = []
  const submitted: string[] = []
  mock.store(on)
  const clock = mock.clock(on)
  on('session.root', () => ({ value: '/repos/data_dashboards_db' }))
  const sid = { value: 'receiver-session' }
  on('session.id', () => ({ value: sid.value }))
  on('ui.status', () => ({ value: undefined }))
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const ghCalls: string[] = []
  const ran = (exitCode: number, stdout: string) => ({
    value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  })
  on('process.run', (_$, e) => {
    if (e.argv[0] === 'git' && e.argv[1] === 'branch') return ran(0, 'main\n')
    if (e.argv[0] !== 'gh') return ran(0, dirty.value ? ' M Makefile\n' : '')
    ghCalls.push(e.argv.join(' '))
    if (gh.value instanceof Error) throw gh.value
    return gh.value === undefined ? ran(1, '') : ran(0, gh.value)
  })
  on('session.send', (_$, e) => {
    sent.push(e.text)
    targets.push(e.to)
    return { isDelivered: true }
  })
  on('session.receive', (_$, e) => ({ text: e.text }))
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  return { sent, targets, submitted, toasts, clock, ghCalls, sid }
}

export const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 },
} as const

export const PEERS = `This session is web-app-3f [aa11bb] — the name other sessions use to message it.

Peer sessions (4):
  api-server-7f [1a2b3c]  ·  interactive  ·  busy  ·  started 9m ago
  api-gateway-2c [4d5e6f]  ·  interactive  ·  idle  ·  started 2m ago
  infra-a9 [7a8b9c]  ·  interactive  ·  idle  ·  started 1h ago
  observer-sessions-35 [07c6f3]  ·  interactive  ·  busy  ·  started 4m ago`

export const listAgents = (on: On, listing = PEERS) => on('tool.call', { tool: 'ListAgents' } as never, () => ({ result: { listing } }) as never)

export async function passOne($: Engine, agent = 'api-server-7f') {
  const out = await $.command.run({ command: 'pass', args: `${agent} add rate limiting` } as never)
  return /#(\w+)/.exec(out.text ?? '')?.[1] ?? ''
}
