# pi-checklist

Branch-persistent task checklists for the [pi](https://pi.dev) coding agent. A
multi-step user request is kept on a list of at most ten tasks; the agent
acknowledges the refreshed list at every task or turn end, and a list left
open at the end of a turn is reported as unresolved and stays open for a later
turn. Settlement is never forced: the agent decides when to continue. The user
holds, releases, or dismisses a list; the model may dismiss or replace one when
a later user instruction changes priorities. An addition must cite the latest
user prompt, so the list cannot grow on the model's own initiative.

The state lives in the session branch, so compaction, reload, resume, and
`/tree` navigation preserve the remaining tasks.

## Install

```bash
pi install git:github.com/ederevx/pi-checklist
```

The package has no runtime dependencies; it uses the host-provided
`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`.

## Basic workflow

1. `pre_checklist` once at the start of each new checklist. It returns the
   contract and records the session acknowledgement.
2. `checklist` with action `create` — the `anchorId` of the latest user
   prompt, a title, and one to ten task titles. That prompt must follow the
   latest checklist revision, and every task must be necessary to complete it:
   batch the whole initial set in this one call, because another addition needs
   another user prompt.
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
| `checklist create` | Start a list with 1–10 tasks, citing the latest user prompt as `anchorId`. Refused while another list is open or held; use `replace`. |
| `checklist add` | Append one task, citing a user prompt that follows the latest revision. Ten task records are the hard maximum, including done and dismissed tasks; `remove` frees a place. |
| `checklist update` | Set a task's status and note. `done` requires a note. |
| `checklist remove` | Drop a completed task's record to make room for another; an unfinished task is refused, and a list keeps at least one task. |
| `checklist dismiss` | Dismiss one task (`taskId`) or the whole list, citing a reason and the `anchorId` of the user message that changed priorities. |
| `checklist replace` | Replace an open or held list with a new one atomically, citing the latest user prompt; consumes a fresh `pre_checklist` receipt. |
| `checklist ack` | Acknowledge the current revision after reviewing the latest results. Sole tool call in its message. |
| `checklist list` | Read the branch's current list. |

Mutations of an existing checklist carry `checklistId` and the expected
`revision`; a stale revision is refused and must be re-read with `list`. A field
an action does not carry is refused by name. Dismissed tasks cannot be
changed by the model, and no model action can force a list complete.

`create`, `add`, and `replace` require an `anchorId` naming the latest user
message on the branch, and that message must follow the most recent checklist
transition — including the last event of a completed or dismissed list. Each
new task records that message as its immutable `sourceAnchorId`, which a later
snapshot cannot rewrite. Because every mutation consumes the opportunity, a
second addition under the same prompt is refused (`NEW_USER_PROMPT_REQUIRED`),
as is a stale or non-user anchor (`ANCHOR_STALE`, `ANCHOR_INVALID`) and a branch
with no user prompt at all (`USER_PROMPT_REQUIRED`). This ordering rule cannot
judge whether the task text serves the cited prompt; a task attributed to a
valid prompt but unrelated to it remains a contract violation, not something
the extension can detect.

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
that explains how that instruction changes priorities. A replacement obeys the
addition policy as well: its anchor must be the latest user prompt, and every
task it introduces is sourced from it. The event records the model actor and
cited message, and a visible notice reports the change. This
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
acknowledgement appends a visible notice naming what is left. Settlement is
never forced: the run ends, and the list stays open for a later turn. Continue
in a turn whenever the remaining work is yours to do, and end the turn when the
rest needs a user decision. Aborts and errors pass through untouched, and a
hold or dismissal waives the report immediately.

## Persistence

Canonical state transitions are custom session entries; the catalogue
acknowledgement and the model's acknowledgements are tool receipts. The view is
rebuilt from the active branch on every call, never from a compaction summary.
A transition written before the addition policy carries no policy version and
its tasks no source; they render `[source: legacy]`, stay editable and
completable, and keep that absent source through later snapshots, but they can
never authorize a new task. A historical transition after a current one is a
state fault, and so is a current snapshot whose task omits its source.
Compaction re-injects the current list into model context, and `/tree` restores
the selected branch's tasks and holds.

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
