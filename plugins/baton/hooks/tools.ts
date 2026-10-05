// What baton adds to a session: plain data, registered at session.start.
import type { CommandSpec } from 'claude-code'

export const STATUSES = ['done', 'already-done', 'blocked'] as const

export const COMMANDS: CommandSpec[] = [
  { name: 'pass', description: 'Pass a task to another named session (or several, comma-separated; "auto" to pick; "<agent> after #id" to chain)', argumentHint: '<agent> <task>', immediate: true },
  { name: 'ask', description: 'Ask another named session a question about its repo', argumentHint: '<agent> <question>', immediate: true },
  { name: 'baton', description: 'Show the task this session is working on and its backlog; "log [today|week]" for history', argumentHint: '[log [today|week]]', immediate: true },
  { name: 'baton-next', description: 'Pick up the next passed task (force: drop the active one first)', argumentHint: '[force]' },
  { name: 'baton-report', description: 'Report the outcome of a task that already left this session', argumentHint: '<id> <done|already-done|blocked> [PR URL] [summary]', immediate: true },
  { name: 'baton-cancel', description: 'Take back a task you passed, if it is still queued or held', argumentHint: '<id>', immediate: true },
  { name: 'baton-answer', description: 'Answer the question a session asked about a task you passed', argumentHint: '<id> <answer>', immediate: true },
]

export const TOOLS = [
  {
    name: 'pass',
    description: 'Pass a task to another named Claude session (an agent as ListAgents lists it), or to several at once, comma-separated. It queues the task, takes it to a pull request and reports back.',
    inputSchema: {
      type: 'object',
      properties: { agent: { type: 'string' }, task: { type: 'string', description: 'What to change, in full: the receiver has none of this context.' } },
      required: ['agent', 'task'],
    },
  },
  {
    name: 'ask',
    description: 'Ask another named Claude session (an agent as ListAgents lists it) a question about its repo. It answers read-only, changing nothing, and the answer comes back here as a message.',
    inputSchema: {
      type: 'object',
      properties: { agent: { type: 'string' }, question: { type: 'string', description: 'The question, in full: the receiver has none of this context.' } },
      required: ['agent', 'question'],
    },
  },
  {
    name: 'answer',
    description: 'Send the answer to a question another session asked about this repo (a BATON-ASK).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, answer: { type: 'string' } }, required: ['id', 'answer'] },
  },
  {
    name: 'ask_sender',
    description: 'Ask the session that passed the active task a question you need answered to go on. Stop after calling it: the answer arrives as a message.',
    inputSchema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
  },
  {
    name: 'task_done',
    description: 'Finish the passed task this session is working on: reports to the session that sent it and picks up the next queued task.',
    inputSchema: {
      type: 'object',
      properties: { status: { enum: STATUSES }, summary: { type: 'string' }, prUrl: { type: 'string' } },
      required: ['status', 'summary'],
    },
  },
]

// Answers BATON-ASK questions without touching the main conversation. Read tools only.
export const ANSWERER = {
  name: 'answerer',
  description: 'Answers a question another Claude session asked about this repo, read-only.',
  prompt:
    'You answer one question about this repository for another Claude Code session. Read only: never edit, write, branch, commit or push. Look in the code, docs and config. Then call the answer tool once, with the question id and the answer alone: short and specific, with file paths and line numbers where they help.',
  // Read tools, plus baton's own answer tool to send the reply.
  tools: ['Read', 'Grep', 'Glob', 'mcp__baton__answer'],
}
