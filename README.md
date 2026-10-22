# pi-checklist

Branch-persistent task checklists for the [pi](https://pi.dev) coding agent, with
bounded settlement enforcement. A multi-step activity is kept on a list of at
most ten tasks; the agent acknowledges the refreshed list at every task or
turn end, and the run cannot settle while work remains or the current revision
is unacknowledged. Only the user can hold or dismiss a list.

The state lives in the session branch, so compaction, reload, resume, and
`/tree` navigation preserve the remaining tasks.

## Install

```bash
pi install git:github.com/ederevx/pi-checklist@v0.2.1
```

The package has no runtime dependencies; it uses the host-provided
`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`.

## Basic workflow

1. `pre_checklist` once at the start of each new checklist. It returns the
   contract and records the session acknowledgement.
2. `checklist` with action `create` — a title and one to ten task titles.
3. Work through the tasks with `update` (`pending`, `in_progress`, `done`).
   Marking a task done requires a completion note naming the evidence.
4. After reviewing the results, call `checklist` with action `ack` as the only
   tool call in its assistant message. Work performed after an acknowledgement
   invalidates it.
5. When every task is done or user-dismissed and the acknowledgement is current,
   the run completes the list and settles.

With pi-consult installed, call `pre_consult` first, and acknowledge the
checklist after the closing consultation result so the acknowledgement covers
that work.

## Tools

| Tool | Purpose |
|---|---|
| `pre_checklist` | Acknowledge the contract for the session and return the catalogue; refuses nested calls. |
| `checklist create` | Start a list with 1–3 tasks. Refused while another list is open or held. |
| `checklist add` | Append one task. Three task records are the hard maximum. |
| `checklist update` | Set a task's status and note. `done` requires a note. |
| `checklist ack` | Acknowledge the current revision after reviewing the latest results. Sole tool call in its message. |
| `checklist list` | Read the branch's current list. |

Mutation parameters carry `checklistId` and the expected `revision`; a stale
revision is refused and must be re-read with `list`. Dismissed tasks cannot be
changed by the model, and no model action can force a list complete.

## User controls

| Command | Behavior |
|---|---|
| `/checklist` | Show the active list, revision, and acknowledgement state. |
| `/checklist-hold <reason>` | Hold the list; settlement enforcement stops until released. |
| `/checklist-release` | Release a hold; a fresh acknowledgement is required. |
| `/checklist-dismiss <taskId\|all> <reason>` | Dismiss one task or the whole list. |

Reasons are required. Commands never start a model turn, and natural-language
requests are not parsed into authority.

## Acknowledgement and settlement

A valid acknowledgement matches the current list and revision, comes from an
assistant message containing only that `checklist ack` call, follows the latest
user message, and follows every non-checklist tool result and list change. A
delivered consultation result counts as later work; acknowledge after it.

At `agent_before_settle`, an open list with unfinished tasks or a missing
acknowledgement appends a hidden reminder and requests one more model turn.
The budget is three continuations per user turn and five per list revision. At
the limit the list is reported unresolved and stays open for a later user turn.
Aborts and errors never consume the budget, and a hold or dismissal waives
settlement enforcement immediately.

## Persistence

Canonical state transitions are custom session entries; the catalogue
acknowledgement and the model's acknowledgements are tool receipts. The view is
rebuilt from the active branch on every call, never from a compaction summary.
Compaction re-injects the current list into model context, and `/tree` restores
the selected branch's tasks, holds, and remaining continuation budget.

A malformed or unsupported canonical record is surfaced as a state fault rather
than silently treated as an empty list.

## Non-interactive modes

The tools and settlement hook work in every mode. Hold and dismissal are
commands, so a non-interactive session leaves an unresolved list open until it
is resumed interactively; nothing infers a hold from inactivity.

## Development

```bash
npm test
```

The suite runs a static OOP/format lint, then the ledger, tool, gate,
acknowledgement, settlement, command, lifecycle, and integration tests. The
tested API baseline is pi 1.3.0.

## License

MIT
