# baton

Pass tasks between your Claude Code sessions.

Keep one Claude Code session per repo. When work belongs somewhere else, pass it there:

```
/pass data-dashboards raise the service's CPU to 2048
```

The receiving session:

- queues it if it's already on a task or has uncommitted changes, and tells you your place in line;
- checks first whether the change is already in place;
- takes it to a PR: branches by your rule, makes the change, runs the repo's checks, commits, pushes, opens a pull request;
- reports back to your session with the outcome and the PR link;
- picks up the next task on its own, or when you run `/baton-next`.

A band above the prompt shows where everything stands, and in fullscreen a side panel shows the details:

```
◆ launchpad-20   ◎ 3 (1 busy)   ▶ 1 ≡ 2   → 1/4
```

From left to right: this session · other sessions (busy) · working · queued · passed on (open/total).

## Install

```sh
claude plugin marketplace add ashishsk93/baton-mods
claude plugin install baton@baton-mods
```

Needs Claude Code v2.1.287 or later. Install it on every machine whose sessions should send or receive tasks.

## Commands

| Command | What it does |
| --- | --- |
| `/pass <session> <task>` | Pass a task to a session by its name in ListAgents. You can also just ask Claude to "pass this to …". |
| `/baton` | Show the task this session is working on and its backlog |
| `/baton-next [force]` | Pick up the next queued task; `force` drops a stuck one first |

## Configure

Set your branch naming rule in `/config` (baton → Branch rule). A repo's own instructions win when they name one.

## What it can do on your machine

baton is a mod: it runs inside Claude Code with your permissions. It runs `git status` in the session's repo, submits prompts in the receiving session, and sends messages between your own local sessions. Run `claude plugin validate plugins/baton` to see the full list before you install it.
