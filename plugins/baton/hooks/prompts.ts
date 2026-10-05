import type { Task } from '../types'

/** `worktree`, when given, is the path (relative to the repo) the task's own worktree goes at. */
export const taskPrompt = (t: Task, branchRule: string, worktree?: string) =>
  [
    `Task #${t.id}, passed from ${t.fromLabel}:`,
    '',
    t.task,
    '',
    'Take it through to a pull request that is ready for review:',
    '1. Check first whether this change is already in place. If it is, change nothing and call the task_done tool with status "already-done" and what you found.',
    `   Something unclear that only ${t.fromLabel} can answer? Call the ask_sender tool with the question and stop: the answer arrives as a message.`,
    `2. ${branchRule} If this repo's own instructions name a branch rule, use that one.`,
    ...(worktree
      ? [
          `   Make that branch in a worktree of its own, not in this checkout: \`git worktree add ${worktree} -b <branch> <the up-to-date default branch>\`.`,
          `   Do all of the work below inside ${worktree}. This checkout may hold someone's uncommitted work: leave it untouched.`,
        ]
      : []),
    '3. Make the change, run the checks this repo has, and commit.',
    "4. Push the branch and open a pull request with the tooling this repo's remote supports. If you cannot open one, push and give the URL to create it.",
    ...(worktree ? [`   Then remove the worktree with \`git worktree remove ${worktree}\`; the branch stays.`] : []),
    '5. Call the task_done tool with status "done", a short summary and the PR URL. If you are blocked, call it with status "blocked" and the reason.',
    `   No task_done tool? Send the report with SendMessage to the session that sent this message, its first line \`BATON-RESULT ${t.id}: <done|already-done|blocked>.\``,
  ].join('\n')

export const askPrompt = (t: Task) =>
  [
    `Question #${t.id} from ${t.fromLabel}, about this repo:`,
    '',
    t.task,
    '',
    "Answer it from this repo: its code, docs, config and git history. Read only: change no files, and do not branch, commit or push.",
    `Then call the answer tool with id "${t.id}" and your answer: short and specific, with file paths and line numbers where they help.`,
    `   No answer tool? Send the answer with SendMessage to the session that sent this message, its first line \`BATON-RESULT ${t.id}: answered.\``,
  ].join('\n')

/** What a waiting task sends home: the question on its own line, then how to answer. */
export const waitingDetail = (id: string, question: string) =>
  `\n${question}\nReply with /baton-answer ${id} <answer>, or a message whose first line is \`BATON-ANSWER ${id}: <answer>\`.`

export const continuePrompt = (t: Task, answer: string) =>
  [
    `${t.fromLabel} answered your question on task #${t.id}:`,
    '',
    answer,
    '',
    `Carry on with task #${t.id} from where you stopped, through the same steps, and finish with the task_done tool.`,
  ].join('\n')
