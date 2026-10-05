# Changelog

All notable changes to the baton plugin. Versions match `plugins/baton/.claude-plugin/plugin.json`.

## 1.6.0 — 2026-10-05

### Added
- **Worktree** option (`/config` → baton → Worktree, off by default). Each passed task is worked in its own `git worktree` next to the repo, so uncommitted changes no longer hold tasks in the queue. (#13)

## 1.5.0 — 2026-10-05

### Added
- `/baton-report <id> <status> [PR URL] [summary]`: send the real outcome of a task that already left the queue. (#10)
- `/baton-cancel <id>`: take back a task you passed. It's dropped if still queued, and left running if it already started. (#11)
- Ask back: the receiver can call `ask_sender` instead of guessing; answer with `/baton-answer <id> <answer>`. (#12)
- Fan-out: `/pass a,b,c <task>` sends one task to each session and groups them in the panel. (#14)
- PR follow-up: GitHub PRs show `● CI running`, `✗ CI failing`, `✓ CI passing` or `✓ merged`, checked with `gh` every 5 minutes. (#15)

### Fixed
- Task ids made in the same millisecond no longer collide.

## 1.4.0 — 2026-10-05

### Added
- **Hidden sessions** option: a regex for sessions to leave out of the band. (#16)
- `/pass` and `/ask` check the name first: a unique prefix resolves, near misses are suggested, and unknown names send nothing. (#17)
- Passing to your own session is refused. (#18)

### Fixed
- A failing ListAgents call keeps the last session list instead of leaving an unhandled error.

## 1.3.0 — 2026-10-05

### Added
- Toast when a passed task finishes, gets stuck or is answered. (#5)
- Status icons and age on sent rows. (#6)
- Clickable PR links. (#7)
- Quiet marker for tasks with no word for 2 hours. (#8)
- Reorder and drop queued tasks from the side panel. (#9)

## 1.2.0 — 2026-10-05

### Added
- `/ask <session> <question>`: the other session answers from its repo, read-only, and the answer comes back here.

## 1.1.0 — 2026-10-05

### Changed
- claude-mem's `observer-sessions-*` are hidden from the band.
- README examples use generic session names.

## 1.0.0 — 2026-10-05

### Added
- First release as the `baton-mods` marketplace: `/pass`, `/baton`, `/baton-next`, the band and side panel.
- **Branch rule** option in `/config`.
