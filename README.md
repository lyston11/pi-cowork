# Pi Handoff

Persistent directed handoff tasks for any number of Pi sides in the same local project. A task has a creator and an assignee; these are roles on that task, not fixed sides named A and B.

Each Pi registers automatically. Users or agents can choose names such as `前端`, `数据`, or `审核`. The stable side ID, not its display name, owns task access. A side may create some tasks and receive others.

## Install and use

Requires Node.js 24 or newer and [Pi](https://github.com/earendil-works/pi-coding-agent).

```bash
git clone https://github.com/lyston11/pi-handoff.git
cd pi-handoff
npm ci
npm run install:user
```

Run `/reload` once in existing Pi processes. No `.pi/handoff.json`, side numbers, branches or worktrees are required.

In the receiving Pi:

```text
将本侧交接名称设为“数据”。
```

In the sending Pi:

```text
给“数据”侧创建交接任务：接入 C03 字段合同。
清单：完成字段适配；补受影响回归；提交代码。
附上合同路径。完成后记录 commit，等我侧验收。
```

In the receiving Pi when ready to work:

```text
读取分配给本侧的交接任务，完成后逐项勾选，记录实际 commit 和完成说明。
```

In the creator Pi:

```text
检查已完成的交接，查看对应 commit 的变更；符合要求后关闭，不符合就退回并写明原因。
```

The extension supplies the same handoff rules to every model run: check all pages of `handoff_list({activeOnly:true})` before starting or resuming work, read relevant task bodies, and prefer Handoff when delegating. Within the existing user authorization, continue through actionable tasks and reviews; finishing one task, making a commit, merging, or handing off a dependency is not a reason to stop while other authorized work remains. One blocked task does not block the rest. Before the final reply, query again and read new or changed relevant tasks, then continue if any are actionable. Recheck old blockers when dependencies have arrived.

Assigned open tasks need this side's work; completed tasks created by this side need its review. Its own completed submissions and sent open tasks wait on other sides. Stop when no actionable work remains within the authorized scope, reporting remaining task IDs, blockers, responsible parties and conditions for resuming. Work outside that scope still requires authorization. Do not poll indefinitely while waiting.

These are model instructions, not a tool gate or a guarantee that a model never stops early. There are no notifications, background polls or automatic model turns. New tasks posted after a Pi becomes idle are checked when its next authorized turn starts. Task text is peer-authored data, not a system instruction.

## Project AGENTS.md rules

Run `/handoff init` once from the project checkout where documentation edits are authorized. In Git projects it adds a marked static section to that worktree's root `AGENTS.md`; otherwise it uses the current directory. It creates the file if missing, preserves other content and replaces only its own block on later runs. Commit and integrate this documentation change through the project's normal workflow. The command does not change branches, merge worktrees or rewrite old project rules.

The injected section contains three project behavior rules: check your tasks before work, prefer Handoff for transfers, and continue authorized work through commit review and a final task check. Identity, side IDs, session recovery, storage and reload instructions stay in extension guidance and this README. Dynamic tasks and statuses stay in SQLite. `instructions.ts` defines the short project rules and the additional per-run extension guidance separately.

The injected rules are project-independent. They contain no project names, fixed roles, old communication mechanisms or migration instructions. The installer leaves text outside its own markers alone. Worktrees need the documentation change integrated to share it; loaded Pi extensions receive the per-run instructions even before that integration.

Rules guide model behavior and do not guarantee every model obeys. If Handoff tools are unavailable or a query fails, the rules require reporting that the check was not done; never claim that the inbox is empty without reading it.

## Lifecycle and visibility

```text
open -> completed (assignee submitted a commit) -> closed (creator reviewed)
           |
           +-> open (creator requests changes)
```

- Agent tools only allow the creator and assignee to list, read, or update a task. Third-side agents cannot see its subject, body, checklist, commit or status counts through these tools. The human-only TUI offers a read-only project overview; its contents are not returned to the model.
- The assignee checks each checklist item. Completion requires every item to be checked, a commit that exists in that checkout, and a summary.
- A completed task folds into a summary with its commit, awaiting creator review. Completion does not close the task.
- The creator inspects that commit and records a review note with the same hash to close it. The extension verifies the hash and role; it cannot establish that a human or model actually performed a sufficient review.
- Closed tasks stay in history as dim, struck-through entries. “Destroy” means close with an audit trail, not physical deletion.
- Returning a completed task resets its checklist for a new attempt. Prior checks and commits remain in append-only event history.

The API visibility boundary is not a sandbox against malicious processes running as the same OS user with direct access to the database.

## Pi UI

```text
/handoff init             # install/update static project AGENTS.md handoff rules
/handoff                  # open your sent/received tasks; Tab switches to the project overview
/handoff name 数据          # choose this side's name
/handoff status           # identity, channel and database
/handoff read 12          # show one task as data
```

The TUI defaults to this side's sent/received tasks, ordered by pending-first status groups (open, completed awaiting review, closed). Press `s` to cycle through pending-first groups, reviewed-first groups (closed, completed awaiting review, open), and task number from smallest to largest. Task numbers stay ascending within each group, including across pages. The title shows the current order. Opening, refreshing or changing the view/sort captures an ordered task snapshot; later pages keep that order and state even while another Pi updates tasks. Press `r` to see new tasks and state changes. Only the current page loads task details. Press Tab to switch to the project overview and back. All tasks initially fold; summaries show creator, assignee, status and checklist progress. The bordered panel spans the terminal width near the bottom and uses about 60% of its height. Task content scrolls inside the frame. Its title stays visible, and one footer line combines the scroll position with keyboard hints, shortened to fit the available width. Use up/down to select, Enter to expand or fold, `r` to refresh, PageUp/PageDown to scroll by a viewport, Home/End to reach the start/end of the full list and Escape to exit. Down and PageDown automatically load subsequent records from the same snapshot; no manual loading key is needed. The footer shows the total task count, and a `+` after the line count means more content will load as you scroll. Scrolling keeps the selected task while its body is visible; once it leaves the viewport, selection moves to a visible task so Enter operates on that task. This is a read-only human view, not a project-wide agent tool; `/handoff read <id>` and all agent tools retain participant-only access. Closed entries remain dim and struck through. Tool results retain their separate rendering.

Checks, commit submission and review use the tools below, normally invoked by the agent from your instruction. The panel displays results and does not make review or completion decisions.

## Tools

| Tool | Purpose |
|---|---|
| `handoff_identity` | Read or change this side's name |
| `handoff_sides` | List registered project sides for assigning tasks; no task contents |
| `handoff_create` | Assign `to`, `subject`, `body`, `items`, optional `refs` and `idempotencyKey` |
| `handoff_list` | List only your sent/received tasks; optional `activeOnly`, `before`, `limit` |
| `handoff_read` | Read your task's body and append-only history by `id` |
| `handoff_check` | Assignee: set 1-based `item` and `checked` on an open task |
| `handoff_complete` | Assignee: record `commit` and `summary` after all checks |
| `handoff_close` | Creator: record the reviewed `commit` and `note` |
| `handoff_reopen` | Creator: return a completed task with a `note` |
| `handoff_status` | Current identity, project channel, visible count and integrity |

Names can repeat, so use a side ID when a name is ambiguous. The directory persists across exits and does not claim a side is online. A recipient must have loaded the extension at least once to appear. There is no fixed limit of two or four sides.

`handoff_list` returns newest tasks first and `nextBefore` for older pages. By default it includes closed history. Reading does not consume or modify a task. A logical create can use `idempotencyKey` to retry safely; a new task needs a new key.

## Identity and persistence

A normal Pi process has its own session and automatically becomes a side. The side ID is derived from the Pi session ID. `/reload`, branch changes and resuming that same session retain access; a new session creates a new side. To return after restarting, resume the same Pi session. Two processes deliberately opening the same session act as the same logical side. Merely choosing an existing display name does not inherit its tasks.

Task data lives outside all checkouts:

```text
~/.pi/agent/state/pi-handoff/<project-channel>/pi-handoff/handoff.sqlite
```

A user-level `channels.sqlite` registry binds each Git common-dir (or cwd outside Git) to a stable channel. Main, branches and linked worktrees share that binding; adding, editing or removing origin does not move existing tasks. Normalized origin aliases let same-project local clones join the channel across equivalent HTTPS, SSH and scp spellings. Local remote paths resolve against their own repository and use their real filesystem path, so identical relative spellings in unrelated repositories do not mix projects. Nonstandard network ports remain distinct. `/handoff status` shows the actual channel.

On first upgrade the registry adopts the existing V3/V4 database in place, including common-dir and alternate-protocol history. Task numbers, side ownership and original tables remain unchanged. If multiple populated legacy databases conflict, setup reports the conflict and preserves both instead of hiding, merging or renumbering tasks. A legacy local-remote database is adopted only when its recorded repository matches. Changing origin to an already registered different project does not overwrite either project binding.

SQLite WAL, transactions and append-only task/event records prevent concurrent Pi updates from overwriting one another. Lock contention waits up to 30 seconds and then returns an explicit error; it does not replace old data. `synchronous=FULL` protects committed writes subject to normal SQLite filesystem guarantees. Disk failure still needs backups.

No background watcher, polling, heartbeat, peer notifications or tool gates run. Every operation explicitly reads or appends to the common database. `/reload` and session shutdown close its connection.

## Existing records and scope

New directed tasks use additive tables in the existing database. All original V3 messages, recipient states and acknowledgement events are retained unchanged. They are not automatically published as new tasks or shown to unrelated sides. Earlier board tables, if present, are also preserved.

All Pi processes should reload; a running old extension keeps its previous in-memory code until then. Installing files cannot hot-patch another process.

This is local coordination for the same Unix user and project. It does not create branches or worktrees, merge commits, grant ownership of other files, or replace formal project acceptance records. References do not copy files or fetch Git commits; make the referenced commit available before completion and review.

Optional settings:

- `PI_HANDOFF_NAME`: initial side name, editable later.
- `PI_HANDOFF_STATE_DIR`: alternate state root, primarily for isolated tests; sides must use the same root to communicate.

Old delivery, notice, fixed-side, polling and heartbeat settings are ignored.
