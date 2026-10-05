<div align="center">

# 🏃 baton

**Pass tasks between your Claude Code sessions.**

One session per repo. When work belongs somewhere else, hand it off and keep going.

[![Version](https://img.shields.io/badge/version-1.0.0-blue)](plugins/baton/.claude-plugin/plugin.json)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-%E2%89%A5%202.1.287-d97757)](https://claude.com/claude-code)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

</div>

```
/pass data-dashboards raise the service's CPU to 2048
```

That's it. The `data-dashboards` session picks it up, takes it to a pull request and tells you when it's done.

## ✨ What the receiving session does

| | |
| --- | --- |
| 📥 **Queues it** | If it's already on a task or has uncommitted changes, the task waits in line and you hear your place. |
| 🔍 **Checks first** | If the change is already in place, it says so and changes nothing. |
| 🛠️ **Takes it to a PR** | Branches by your rule, makes the change, runs the repo's checks, commits, pushes, opens a pull request. |
| 📣 **Reports back** | Your session gets the outcome and the PR link. |
| ⏭️ **Picks up the next** | On its own, or when you run `/baton-next`. |

## 🔁 How a handoff flows

```mermaid
sequenceDiagram
    participant You as launchpad (you)
    participant R as data-dashboards
    You->>R: /pass data-dashboards raise CPU to 2048
    alt busy or uncommitted changes
        R-->>You: queued, position 2
    else free
        R-->>You: started
    end
    R->>R: branch · change · checks · commit · push · PR
    R-->>You: done ✅ PR: https://github.com/…/pull/42
    R->>R: next task from the backlog
```

## 📊 The band

A band above the prompt shows where everything stands. Press a badge to expand it. In fullscreen, a side panel shows the details.

```
◆ launchpad-20   ◎ 3 (1 busy)   ▶ 1 ≡ 2   → 1/4
```

| Badge | Means |
| --- | --- |
| `◆ launchpad-20` | This session |
| `◎ 3 (1 busy)` | Other sessions, and how many are busy |
| `▶ 1` | Tasks this session is working on |
| `≡ 2` | Tasks queued here |
| `→ 1/4` | Tasks you passed on: open / total |

## 🚀 Install

```sh
claude plugin marketplace add ashishsk93/baton-mods
claude plugin install baton@baton-mods
```

Needs Claude Code **v2.1.287** or later. Install it on every machine whose sessions should send or receive tasks.

## ⌨️ Commands

| Command | What it does |
| --- | --- |
| `/pass <session> <task>` | Pass a task to a session by its name in ListAgents. You can also just ask Claude to "pass this to …". |
| `/baton` | Show the task this session is working on and its backlog |
| `/baton-next [force]` | Pick up the next queued task; `force` drops a stuck one first |

## ⚙️ Configure

Set your branch naming rule in `/config` (**baton → Branch rule**). A repo's own instructions win when they name one.

Default:

> Branch off an up-to-date default branch as `<type>/<short-kebab-slug>`, type one of feat, fix, chore, refactor, perf, docs.

## 🔒 What it can do on your machine

baton is a mod: it runs inside Claude Code with your permissions. It:

- runs `git status` in the session's repo,
- submits prompts in the receiving session,
- sends messages between your own local sessions.

Run `claude plugin validate plugins/baton` to see the full list before you install it.

## 📄 License

[MIT](LICENSE) © 2026 Ashish S Kumar
