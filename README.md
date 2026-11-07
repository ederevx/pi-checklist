# pi-checklist

Branch-persistent task checklists for the [pi](https://pi.dev) coding agent, with
bounded settlement enforcement. A multi-step activity is kept on a list of at
most ten tasks; the agent acknowledges the refreshed list at every task or
turn end, and the run cannot settle while work remains or the current revision
is unacknowledged. The user holds, releases, or dismisses a list; the model
may dismiss or replace one when a later user instruction changes priorities.

The state lives in the session branch, so compaction, reload, resume, and
`/tree` navigation preserve the remaining tasks.

## Install

```bash
pi install git:github.com/ederevx/pi-checklist@v0.3.4
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
5. When every task is done or dismissed and the acknowledgement is current,
   the run completes the list and settles.

With pi-consult installed, call `pre_consult` first, and acknowledge the
checklist after the closing consultation result so the acknowledgement covers
that work.

## Tools

| Tool | Purpose |
|---|---|
| `pre_checklist` | Acknowledge the contract for the session and return the catalogue; refuses nested calls. |
| `checklist create` | Start a list with 1–10 tasks. Refused while another list is open or held; use `replace`. |
| `checklist add` | Append one task. Ten task records are the hard maximum, including done and dismissed tasks. |
| `checklist update` | Set a task's status and note. `done` requires a note. |
| `checklist dismiss` | Dismiss one task (`taskId`) or the whole list, citing a reason and the `anchorId` of the user message that changed priorities. |
| `checklist replace` | Replace an open or held list with a new one atomically; consumes a fresh `pre_checklist` receipt. |
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

## Model dismissals and replacements

A model dismissal or replacement must cite a user message on the current
branch that follows the latest checklist revision, as `anchorId`, and a reason
that explains how that instruction changes priorities. The event records the
model actor and cited message, and a visible notice reports the change. This
ordering rule prevents same-turn abandonment and is consumed by any later list
change; it does not verify the meaning of the user instruction.

A held list may be dismissed or replaced under the same rule, which is how a
later instruction supersedes a hold. Task dismissal leaves the hold in place;
a replacement starts unheld and keeps the displaced list's identity, revision,
and hold reason in its event. Holds and releases remain user-only.

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

The tools and settlement hook work in every mode. Holding and releasing are
commands, so a non-interactive session leaves an unresolved list open until it
is resumed interactively; nothing infers a hold from inactivity. A dismissal
needs either the command or a later user message that the model can cite.

## Development

```bash
npm test
```

The suite runs a static OOP/format lint, then the ledger, tool, gate,
acknowledgement, settlement, command, lifecycle, and integration tests. The
tested API baseline is pi 1.3.0.

## License

MIT
