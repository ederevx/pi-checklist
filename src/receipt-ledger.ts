/**
 * pi-checklist — reconstruction, validation, and persistence of checklist state.
 *
 * The single owner of checklist truth. State is never held in a cache: every
 * call derives the branch view from session entries, so compaction, reload,
 * resume, and /tree navigation are correct by construction. Custom entries are
 * authoritative for transitions; tool receipts are authoritative for the
 * catalogue acknowledgement and for the model's acknowledgement of the list.
 */

import { randomUUID } from "node:crypto";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	ChecklistContract,
	CONTRACT_VERSION,
	MAX_CONTINUATIONS_PER_ANCHOR,
	MAX_CONTINUATIONS_PER_REVISION,
	MAX_TASKS,
	SCHEMA,
	type Acknowledgement,
	type BranchEntry,
	type ChecklistDetails,
	type ChecklistState,
	type ChecklistView,
	type NoticeDetails,
	type SettleEvent,
	type StateEvent,
	type TaskStatus,
	type TransitionResult,
} from "./checklist-contract.ts";

export type TransitionCommand =
	| { kind: "create"; title: string; tasks: string[]; actor: "model" }
	| { kind: "add"; checklistId: string; revision: number; title: string; actor: "model" }
	| {
			kind: "update";
			checklistId: string;
			revision: number;
			taskId: string;
			status: TaskStatus;
			note?: string;
			actor: "model";
	  }
	| { kind: "hold"; reason: string; actor: "user" }
	| { kind: "release"; actor: "user" }
	| { kind: "dismissTask"; taskId: string; reason: string; actor: "user" }
	| { kind: "dismissList"; reason: string; actor: "user" };

interface NextTransition {
	details: ChecklistDetails;
	event?: StateEvent;
	state?: ChecklistState;
}

export class ReceiptLedger {
	private readonly pi: ExtensionAPI;
	private readonly contract = new ChecklistContract();

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	/** Rebuild the branch view. Drafts are boundary entries proposed in this dispatch. */
	view(
		sessionEntries: readonly BranchEntry[],
		branchEntries: readonly BranchEntry[],
		drafts: readonly unknown[] = [],
	): ChecklistView {
		const branch: BranchEntry[] = [
			...branchEntries,
			...drafts.map((draft, index) => this.draftEntry(draft, index)),
		];
		const preReceiptIds = this.preReceipts(sessionEntries);
		const usedPreReceiptIds: string[] = [];
		const events: StateEvent[] = [];
		let state: ChecklistState | null = null;
		let fault: string | null = null;
		let stateIndex = -1;

		for (let index = 0; index < branch.length; index += 1) {
			const entry = branch[index];
			if (entry.type !== "custom" || entry.customType !== ChecklistContract.STATE_TYPE) continue;
			if (fault !== null) break;
			const read = this.stateEvent(entry);
			if (read.fault) {
				fault = read.fault;
				break;
			}
			const event = read.event;
			if (!event) continue;
			const issue = this.transitionIssue(state, event);
			if (issue) {
				fault = issue;
				break;
			}
			if (event.operation === "create" && event.preReceiptId) usedPreReceiptIds.push(event.preReceiptId);
			state = event.state;
			events.push(event);
			stateIndex = index;
		}

		const anchorIndex = this.lastIndex(branch, (entry) => this.isUser(entry));
		const anchorId = anchorIndex >= 0 ? branch[anchorIndex].id : null;
		const latestWorkIndex = this.latestWorkIndex(branch, anchorIndex);
		const acks = this.acknowledgements(branch, state, stateIndex, anchorIndex, latestWorkIndex);
		const validAck = acks.find((ack) => ack.valid);
		const ack = validAck ?? acks[acks.length - 1] ?? null;
		const active = state !== null && (state.phase === "open" || state.phase === "held");
		const ackValid = active && validAck !== undefined;

		let continuationsForAnchor = 0;
		let continuationsForRevision = 0;
		for (const entry of branch) {
			const settle = this.settleEvent(entry);
			if (!settle || settle.decision !== "continue" || settle.anchorId !== anchorId) continue;
			continuationsForAnchor += 1;
			if (state && settle.checklistId === state.checklistId && settle.revision === state.revision) {
				continuationsForRevision += 1;
			}
		}

		return {
			acknowledged: preReceiptIds.length > 0,
			state,
			fault,
			preReceiptIds,
			usedPreReceiptIds,
			events,
			ack,
			ackValid,
			anchorId,
			continuationsForAnchor,
			continuationsForRevision,
			notices: this.notices(branch),
		};
	}

	/** Rebuild from a context, without boundary drafts. */
	fromContext(ctx: ExtensionContext): ChecklistView {
		return this.view(
			ctx.sessionManager.getEntries() as unknown as BranchEntry[],
			ctx.sessionManager.getBranch() as unknown as BranchEntry[],
		);
	}

	/** Apply one model or user command, persisting a canonical transition. */
	transition(command: TransitionCommand, ctx: ExtensionContext): TransitionResult {
		const view = this.fromContext(ctx);
		const next = this.next(command, view);
		if (next.event) this.pi.appendEntry(ChecklistContract.STATE_TYPE, next.event);
		return { ok: next.details.kind !== "error", details: next.details, state: next.state };
	}

	/** Validate and describe one model acknowledgement. */
	acknowledge(
		checklistId: string,
		revision: number,
		summary: string,
		toolCallId: string,
		ctx: ExtensionContext,
	): TransitionResult {
		const branch = ctx.sessionManager.getBranch() as unknown as BranchEntry[];
		const view = this.view(ctx.sessionManager.getEntries() as unknown as BranchEntry[], branch);
		if (!view.acknowledged) return this.failure("PRE_REQUIRED", this.contract.ackDenial());
		if (!view.state) return this.failure("NO_CHECKLIST", "No checklist is open on this branch.");
		if (view.state.checklistId !== checklistId || view.state.revision !== revision) {
			return this.failure(
				"STALE_REVISION",
				`Expected ${view.state.checklistId} revision ${view.state.revision}.`,
				view.state.checklistId,
				view.state.revision,
			);
		}
		if (view.state.phase !== "open" && view.state.phase !== "held") {
			return this.failure("NOT_OPEN", `Checklist is ${view.state.phase}.`, checklistId, revision);
		}
		const text = summary.trim();
		if (!text) return this.failure("SUMMARY_REQUIRED", "An acknowledgement needs a non-empty summary.", checklistId, revision);
		if (!this.soleCall(branch, toolCallId)) {
			return this.failure(
				"NOT_SOLE_CALL",
				"checklist ack must be the only tool call in its assistant message.",
				checklistId,
				revision,
			);
		}
		if (!this.acknowledgesCurrentWork(branch, view, toolCallId)) {
			return this.failure(
				"STALE_ACK",
				"Review the newest results first; an acknowledgement must follow the latest work and list change.",
				checklistId,
				revision,
			);
		}
		return {
			ok: true,
			details: { schema: SCHEMA, kind: "ack", checklistId, revision, summary: text },
		};
	}

	/** The completion transition the settle gate appends. */
	completionDraft(view: ChecklistView): { draft: unknown; state: ChecklistState } | undefined {
		const state = view.state;
		const ack = view.ack;
		if (!state || !ack || !view.ackValid) return undefined;
		const next: ChecklistState = { ...state, revision: state.revision + 1, phase: "completed" };
		const event: StateEvent = {
			schema: SCHEMA,
			eventId: randomUUID(),
			operation: "complete",
			actor: "gate",
			previousRevision: state.revision,
			reason: null,
			preReceiptId: null,
			ackReceiptEntryId: ack.receiptEntryId,
			state: next,
		};
		return { draft: { type: "custom", customType: ChecklistContract.STATE_TYPE, data: event }, state: next };
	}

	/** The canonical event for one well-formed state entry, or a fault. */
	private stateEvent(entry: BranchEntry): { event?: StateEvent; fault?: string } {
		const data = this.record(entry.data);
		if (!data || data.schema !== SCHEMA) return { fault: "unsupported pi-checklist state record" };
		const state = this.readState(data.state);
		if (!state) return { fault: "malformed pi-checklist state snapshot" };
		if (
			typeof data.eventId !== "string" ||
			typeof data.operation !== "string" ||
			typeof data.actor !== "string"
		) {
			return { fault: "malformed pi-checklist transition record" };
		}
		if (data.previousRevision !== null && typeof data.previousRevision !== "number") {
			return { fault: "malformed pi-checklist revision record" };
		}
		return {
			event: {
				schema: SCHEMA,
				eventId: data.eventId,
				operation: data.operation as StateEvent["operation"],
				actor: data.actor as StateEvent["actor"],
				previousRevision: data.previousRevision as number | null,
				reason: typeof data.reason === "string" ? data.reason : null,
				preReceiptId: typeof data.preReceiptId === "string" ? data.preReceiptId : null,
				ackReceiptEntryId: typeof data.ackReceiptEntryId === "string" ? data.ackReceiptEntryId : null,
				state,
			},
		};
	}

	private readState(value: unknown): ChecklistState | null {
		const state = this.record(value);
		if (!state) return null;
		if (
			typeof state.checklistId !== "string" ||
			typeof state.title !== "string" ||
			typeof state.revision !== "number" ||
			!Number.isInteger(state.revision) ||
			state.revision < 1 ||
			typeof state.phase !== "string" ||
			!Array.isArray(state.tasks)
		) {
			return null;
		}
		if (!["open", "held", "completed", "dismissed"].includes(state.phase)) return null;
		if (state.tasks.length < 1 || state.tasks.length > MAX_TASKS) return null;
		const tasks = [];
		for (const value of state.tasks) {
			const task = this.record(value);
			if (
				!task ||
				typeof task.taskId !== "string" ||
				typeof task.title !== "string" ||
				typeof task.status !== "string" ||
				!["pending", "in_progress", "done", "dismissed"].includes(task.status)
			) {
				return null;
			}
			tasks.push({
				taskId: task.taskId,
				title: task.title,
				status: task.status as TaskStatus,
				note: typeof task.note === "string" ? task.note : null,
			});
		}
		return {
			checklistId: state.checklistId,
			revision: state.revision,
			title: state.title,
			phase: state.phase as ChecklistState["phase"],
			tasks,
			holdReason: typeof state.holdReason === "string" ? state.holdReason : null,
		};
	}

	private transitionIssue(previous: ChecklistState | null, event: StateEvent): string | null {
		const state = event.state;
		if (previous === null) {
			if (event.operation !== "create" || event.actor !== "model") return "first transition is not a model create";
			if (event.previousRevision !== null || state.revision !== 1 || state.phase !== "open") {
				return "malformed create transition";
			}
			if (!event.preReceiptId) return "create transition has no pre_checklist receipt";
			return this.taskSetIssue(state, 1, MAX_TASKS);
		}
		if (state.checklistId !== previous.checklistId) return "checklist identity changed";
		if (event.previousRevision !== previous.revision) return "transition revision does not match the previous state";
		if (state.revision !== previous.revision + 1) return "transition revision does not advance by one";
		if (state.title !== previous.title) return "checklist title changed";
		if (!this.allowedActor(event)) return "transition actor is not allowed";
		const taskIssue = this.taskTransitionIssue(previous, state, event);
		if (taskIssue) return taskIssue;
		if (event.operation === "hold" && (state.phase !== "held" || !state.holdReason)) return "malformed hold transition";
		if (event.operation === "release" && (state.phase !== "open" || state.holdReason !== null)) return "malformed release transition";
		if (event.operation === "dismiss_list" && state.phase !== "dismissed") return "malformed list dismissal";
		if (event.operation === "complete") {
			if (event.actor !== "gate" || state.phase !== "completed" || !event.ackReceiptEntryId) {
				return "malformed completion transition";
			}
			if (state.tasks.some((task) => task.status !== "done" && task.status !== "dismissed")) {
				return "completion with unfinished tasks";
			}
		}
		return null;
	}

	private allowedActor(event: StateEvent): boolean {
		if (event.operation === "create" || event.operation === "add" || event.operation === "update") {
			return event.actor === "model";
		}
		if (event.operation === "complete") return event.actor === "gate";
		return event.actor === "user";
	}

	private taskSetIssue(state: ChecklistState, min: number, max: number): string | null {
		if (state.tasks.length < min || state.tasks.length > max) return "task count is outside the limit";
		if (new Set(state.tasks.map((task) => task.taskId)).size !== state.tasks.length) return "duplicate task identity";
		if (state.tasks.some((task) => !task.title.trim())) return "empty task title";
		return null;
	}

	private taskTransitionIssue(previous: ChecklistState, next: ChecklistState, event: StateEvent): string | null {
		const countIssue = this.taskSetIssue(next, 1, MAX_TASKS);
		if (countIssue) return countIssue;
		if (event.operation === "add") {
			if (next.tasks.length !== previous.tasks.length + 1) return "add did not append exactly one task";
			if (!this.sameTasks(previous.tasks, next.tasks.slice(0, previous.tasks.length))) return "add changed an existing task";
			const added = next.tasks[next.tasks.length - 1];
			if (added.status !== "pending" || added.note !== null) return "added task is not pending and empty";
			return null;
		}
		if (next.tasks.length !== previous.tasks.length) return "transition changed the task count";
		if (!this.sameIdentities(previous.tasks, next.tasks)) return "transition changed task identities";
		const changed = next.tasks.filter((task, index) => JSON.stringify(task) !== JSON.stringify(previous.tasks[index]));
		if (event.operation === "update") {
			if (changed.length > 1) return "update changed more than one task";
			return null;
		}
		if (event.operation === "dismiss_task") {
			if (changed.length !== 1) return "task dismissal must change exactly one task";
			const index = next.tasks.findIndex((task) => task.status === "dismissed");
			if (index < 0 || previous.tasks[index].status === "dismissed") return "task dismissal is malformed";
			return null;
		}
		if (changed.length !== 0) return "transition changed tasks it does not own";
		return null;
	}

	private sameIdentities(left: ChecklistState["tasks"], right: ChecklistState["tasks"]): boolean {
		return left.every((task, index) => task.taskId === right[index].taskId && task.title === right[index].title);
	}

	private sameTasks(left: ChecklistState["tasks"], right: ChecklistState["tasks"]): boolean {
		return JSON.stringify(left) === JSON.stringify(right);
	}

	private next(command: TransitionCommand, view: ChecklistView): NextTransition {
		if (view.fault) return this.nextFailure("STATE_FAULT", view.fault);
		if (command.kind === "create") return this.create(command, view);
		const state = view.state;
		if (!state) return this.nextFailure("NO_CHECKLIST", "No checklist is open on this branch.");
		if (command.kind === "hold") return this.hold(command, state);
		if (command.kind === "release") return this.release(command, state);
		if (command.kind === "dismissTask") return this.dismissTask(command, state);
		if (command.kind === "dismissList") return this.dismissList(command, state);
		if (state.phase !== "open") return this.nextFailure("NOT_OPEN", `Checklist is ${state.phase}.`);
		if (state.checklistId !== command.checklistId || state.revision !== command.revision) {
			return this.nextFailure(
				"STALE_REVISION",
				`Expected ${state.checklistId} revision ${state.revision}.`,
			);
		}
		if (command.kind === "add") return this.add(command, state);
		return this.update(command, state);
	}

	private create(command: Extract<TransitionCommand, { kind: "create" }>, view: ChecklistView): NextTransition {
		if (view.state && (view.state.phase === "open" || view.state.phase === "held")) {
			return this.nextFailure("ALREADY_OPEN", "A checklist is already open on this branch.");
		}
		if (!view.acknowledged) return this.nextFailure("PRE_REQUIRED", this.contract.ackDenial());
		const titles = command.tasks.map((title) => title.trim()).filter(Boolean);
		if (titles.length < 1 || titles.length > MAX_TASKS) {
			return this.nextFailure("TASK_LIMIT", `A checklist needs one to ${MAX_TASKS} non-empty tasks.`);
		}
		const preReceiptId = [...view.preReceiptIds].reverse().find((id) => !view.usedPreReceiptIds.includes(id));
		if (!preReceiptId) {
			return this.nextFailure("PRE_REQUIRED", "Call pre_checklist again before starting this checklist.");
		}
		const state: ChecklistState = {
			checklistId: randomUUID(),
			revision: 1,
			title: command.title.trim(),
			phase: "open",
			tasks: titles.map((title) => ({ taskId: randomUUID(), title, status: "pending", note: null })),
			holdReason: null,
		};
		if (!state.title) return this.nextFailure("TITLE_REQUIRED", "A checklist needs a non-empty title.");
		const event = this.event("create", "model", null, state, preReceiptId);
		return this.mutation(event);
	}

	private add(command: Extract<TransitionCommand, { kind: "add" }>, state: ChecklistState): NextTransition {
		if (state.tasks.length >= MAX_TASKS) {
			return this.nextFailure("TASK_LIMIT", `A checklist holds at most ${MAX_TASKS} tasks.`);
		}
		const title = command.title.trim();
		if (!title) return this.nextFailure("TITLE_REQUIRED", "A task needs a non-empty title.");
		const next: ChecklistState = {
			...state,
			revision: state.revision + 1,
			tasks: [...state.tasks, { taskId: randomUUID(), title, status: "pending", note: null }],
		};
		return this.mutation(this.event("add", "model", state, next, null));
	}

	private update(command: Extract<TransitionCommand, { kind: "update" }>, state: ChecklistState): NextTransition {
		const index = state.tasks.findIndex((task) => task.taskId === command.taskId);
		if (index < 0) return this.nextFailure("UNKNOWN_TASK", "No such task in this checklist.");
		const task = state.tasks[index];
		if (task.status === "dismissed") return this.nextFailure("TASK_DISMISSED", "The user dismissed this task.");
		const note = command.note === undefined ? task.note : command.note.trim() || null;
		if (command.status === "done" && !note) {
			return this.nextFailure("NOTE_REQUIRED", "Marking a task done requires a completion note.");
		}
		if (command.status === task.status && note === task.note) {
			return {
				details: {
					schema: SCHEMA,
					kind: "mutation",
					action: "update",
					eventId: `revision-${state.checklistId}-${state.revision}`,
					checklistId: state.checklistId,
					revision: state.revision,
				},
				state,
			};
		}
		const tasks = state.tasks.map((candidate, position) =>
			position === index ? { ...candidate, status: command.status, note } : candidate,
		);
		const next: ChecklistState = { ...state, revision: state.revision + 1, tasks };
		return this.mutation(this.event("update", "model", state, next, null));
	}

	private hold(command: Extract<TransitionCommand, { kind: "hold" }>, state: ChecklistState): NextTransition {
		if (state.phase !== "open") return this.nextFailure("NOT_OPEN", `Checklist is ${state.phase}.`);
		const reason = command.reason.trim();
		if (!reason) return this.nextFailure("REASON_REQUIRED", "A hold needs a reason.");
		const next: ChecklistState = { ...state, revision: state.revision + 1, phase: "held", holdReason: reason };
		return this.mutation(this.event("hold", "user", state, next, null, reason));
	}

	private release(command: Extract<TransitionCommand, { kind: "release" }>, state: ChecklistState): NextTransition {
		if (state.phase !== "held") return this.nextFailure("NOT_HELD", "The checklist is not held.");
		const next: ChecklistState = { ...state, revision: state.revision + 1, phase: "open", holdReason: null };
		return this.mutation(this.event("release", command.actor, state, next, null));
	}

	private dismissTask(
		command: Extract<TransitionCommand, { kind: "dismissTask" }>,
		state: ChecklistState,
	): NextTransition {
		if (state.phase !== "open" && state.phase !== "held") {
			return this.nextFailure("NOT_OPEN", `Checklist is ${state.phase}.`);
		}
		const index = state.tasks.findIndex((task) => task.taskId === command.taskId);
		if (index < 0) return this.nextFailure("UNKNOWN_TASK", "No such task in this checklist.");
		if (state.tasks[index].status === "dismissed") {
			return this.nextFailure("TASK_DISMISSED", "The task is already dismissed.");
		}
		const reason = command.reason.trim();
		if (!reason) return this.nextFailure("REASON_REQUIRED", "A dismissal needs a reason.");
		const tasks = state.tasks.map((task, position) =>
			position === index ? { ...task, status: "dismissed" as TaskStatus, note: reason } : task,
		);
		const next: ChecklistState = { ...state, revision: state.revision + 1, tasks };
		return this.mutation(this.event("dismiss_task", "user", state, next, null, reason));
	}

	private dismissList(
		command: Extract<TransitionCommand, { kind: "dismissList" }>,
		state: ChecklistState,
	): NextTransition {
		if (state.phase !== "open" && state.phase !== "held") {
			return this.nextFailure("NOT_OPEN", `Checklist is ${state.phase}.`);
		}
		const reason = command.reason.trim();
		if (!reason) return this.nextFailure("REASON_REQUIRED", "A dismissal needs a reason.");
		const next: ChecklistState = { ...state, revision: state.revision + 1, phase: "dismissed", holdReason: reason };
		return this.mutation(this.event("dismiss_list", "user", state, next, null, reason));
	}

	private event(
		operation: StateEvent["operation"],
		actor: StateEvent["actor"],
		previous: ChecklistState | null,
		state: ChecklistState,
		preReceiptId: string | null,
		reason: string | null = null,
		ackReceiptEntryId: string | null = null,
	): StateEvent {
		return {
			schema: SCHEMA,
			eventId: randomUUID(),
			operation,
			actor,
			previousRevision: previous ? previous.revision : null,
			reason,
			preReceiptId,
			ackReceiptEntryId,
			state,
		};
	}

	private mutation(event: StateEvent): NextTransition {
		const operation = event.operation === "create" || event.operation === "add" || event.operation === "update"
			? event.operation
			: "update";
		return {
			event,
			details: {
				schema: SCHEMA,
				kind: "mutation",
				action: operation,
				eventId: event.eventId,
				checklistId: event.state.checklistId,
				revision: event.state.revision,
			},
			state: event.state,
		};
	}

	private nextFailure(code: string, message: string): NextTransition {
		return {
			details: {
				schema: SCHEMA,
				kind: "error",
				code,
				message,
				checklistId: null,
				revision: null,
			},
		};
	}

	private failure(code: string, message: string, checklistId: string | null = null, revision: number | null = null): TransitionResult {
		return {
			ok: false,
			details: { schema: SCHEMA, kind: "error", code, message, checklistId, revision },
		};
	}

	private draftEntry(draft: unknown, index: number): BranchEntry {
		const value = this.record(draft) ?? {};
		const type = typeof value.type === "string" ? value.type : "custom";
		return {
			type,
			id: `draft-${index}`,
			customType: typeof value.customType === "string" ? value.customType : undefined,
			data: value.data,
			details: value.details,
			content: value.content,
			display: typeof value.display === "boolean" ? value.display : undefined,
			message: undefined,
		};
	}

	private preReceipts(entries: readonly BranchEntry[]): string[] {
		const ids: string[] = [];
		for (const entry of entries) {
			if (!this.isToolResult(entry) || entry.message?.toolName !== "pre_checklist" || entry.message.isError) {
				continue;
			}
			const details = this.record(entry.message.details);
			if (
				details?.schema === SCHEMA &&
				details.kind === "pre" &&
				details.contractVersion === CONTRACT_VERSION &&
				typeof details.receiptId === "string" &&
				!ids.includes(details.receiptId)
			) {
				ids.push(details.receiptId);
			}
		}
		return ids;
	}

	private acknowledgements(
		branch: readonly BranchEntry[],
		state: ChecklistState | null,
		stateIndex: number,
		anchorIndex: number,
		latestWorkIndex: number,
	): Acknowledgement[] {
		const acks: Acknowledgement[] = [];
		for (let index = 0; index < branch.length; index += 1) {
			const entry = branch[index];
			if (!this.isToolResult(entry) || entry.message?.toolName !== "checklist" || entry.message.isError) continue;
			const details = this.record(entry.message.details);
			if (details?.schema !== SCHEMA || details.kind !== "ack") continue;
			if (typeof details.checklistId !== "string" || typeof details.revision !== "number") continue;
			const assistantIndex = this.assistantIndex(branch, entry);
			const sole = assistantIndex >= 0 && this.soleCallAt(branch, assistantIndex);
			const afterAnchor = anchorIndex < 0 || assistantIndex > anchorIndex;
			const afterWork = assistantIndex > latestWorkIndex && index > latestWorkIndex;
			const afterState = index > stateIndex;
			const matches = state !== null && state.checklistId === details.checklistId && state.revision === details.revision;
			const open = state !== null && (state.phase === "open" || state.phase === "held");
			const reason = !matches
				? "revision"
				: !open
					? "phase"
					: !sole
						? "not_sole_call"
						: !afterAnchor
							? "before_user"
							: !afterWork
								? "before_work"
								: !afterState
									? "before_state"
									: null;
			acks.push({
				receiptEntryId: entry.id,
				checklistId: details.checklistId,
				revision: details.revision,
				summary: typeof details.summary === "string" ? details.summary : "",
				valid: reason === null,
				reason,
			});
		}
		return acks;
	}

	private acknowledgesCurrentWork(branch: readonly BranchEntry[], view: ChecklistView, toolCallId: string): boolean {
		const stateIndex = this.lastIndex(branch, (entry) => {
			if (entry.type !== "custom" || entry.customType !== ChecklistContract.STATE_TYPE) return false;
			const event = this.stateEvent(entry).event;
			return event?.state.checklistId === view.state?.checklistId && event?.state.revision === view.state?.revision;
		});
		const assistantIndex = this.lastIndex(branch, (entry) => this.assistantHasCall(entry, toolCallId));
		if (assistantIndex < 0) return false;
		const anchorIndex = this.lastIndex(branch, (entry) => this.isUser(entry));
		const workIndex = this.latestWorkIndex(branch, anchorIndex);
		if (stateIndex >= 0 && assistantIndex <= stateIndex) return false;
		if (anchorIndex >= 0 && assistantIndex <= anchorIndex) return false;
		if (assistantIndex <= workIndex) return false;
		return true;
	}

	private soleCall(branch: readonly BranchEntry[], toolCallId: string): boolean {
		const index = this.lastIndex(branch, (entry) => this.assistantHasCall(entry, toolCallId));
		return index >= 0 && this.soleCallAt(branch, index);
	}

	private soleCallAt(branch: readonly BranchEntry[], index: number): boolean {
		const content = this.assistantContent(branch[index]);
		const calls = content.filter((part) => part.type === "toolCall");
		return calls.length === 1 && calls[0].name === "checklist";
	}

	private assistantHasCall(entry: BranchEntry, toolCallId: string): boolean {
		return this.assistantContent(entry).some((part) => part.type === "toolCall" && part.id === toolCallId);
	}

	private assistantContent(entry: BranchEntry): Array<Record<string, unknown>> {
		if (entry.type !== "message" || entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) {
			return [];
		}
		return entry.message.content.filter((part): part is Record<string, unknown> => this.record(part) !== undefined);
	}

	private assistantIndex(branch: readonly BranchEntry[], entry: BranchEntry): number {
		const toolCallId = entry.message?.toolCallId;
		if (typeof toolCallId !== "string") return -1;
		return this.lastIndex(branch, (candidate) => this.assistantHasCall(candidate, toolCallId));
	}

	private latestWorkIndex(branch: readonly BranchEntry[], anchorIndex: number): number {
		let latest = -1;
		for (let index = anchorIndex + 1; index < branch.length; index += 1) {
			const entry = branch[index];
			if (this.isToolResult(entry) && entry.message?.toolName !== "checklist" && entry.message?.toolName !== "pre_checklist") {
				latest = index;
			}
			if (entry.type === "custom_message" && entry.customType !== ChecklistContract.NOTICE_TYPE) {
				latest = index;
			}
		}
		return latest;
	}

	private settleEvent(entry: BranchEntry): SettleEvent | null {
		if (entry.type !== "custom" || entry.customType !== ChecklistContract.SETTLE_TYPE) return null;
		const data = this.record(entry.data);
		if (
			!data ||
			data.schema !== SCHEMA ||
			typeof data.eventId !== "string" ||
			typeof data.checklistId !== "string" ||
			typeof data.revision !== "number" ||
			(data.decision !== "continue" && data.decision !== "unresolved") ||
			typeof data.reason !== "string"
		) {
			return null;
		}
		return {
			schema: SCHEMA,
			eventId: data.eventId,
			anchorId: typeof data.anchorId === "string" ? data.anchorId : null,
			checklistId: data.checklistId,
			revision: data.revision,
			decision: data.decision as SettleEvent["decision"],
			reason: data.reason as SettleEvent["reason"],
		};
	}

	private notices(branch: readonly BranchEntry[]): NoticeDetails[] {
		const notices: NoticeDetails[] = [];
		for (const entry of branch) {
			if (entry.type !== "custom_message" || entry.customType !== ChecklistContract.NOTICE_TYPE) continue;
			const details = this.record(entry.details);
			if (details?.schema !== SCHEMA || details.kind !== "notice") continue;
			notices.push({
				schema: SCHEMA,
				kind: "notice",
				checklistId: typeof details.checklistId === "string" ? details.checklistId : null,
				revision: typeof details.revision === "number" ? details.revision : null,
				reason: typeof details.reason === "string" ? details.reason : "unknown",
			});
		}
		return notices;
	}

	private isToolResult(entry: BranchEntry): boolean {
		return entry.type === "message" && entry.message?.role === "toolResult";
	}

	private isUser(entry: BranchEntry): boolean {
		return entry.type === "message" && entry.message?.role === "user";
	}

	private lastIndex(entries: readonly BranchEntry[], predicate: (entry: BranchEntry) => boolean): number {
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			if (predicate(entries[index])) return index;
		}
		return -1;
	}

	private record(value: unknown): Record<string, unknown> | undefined {
		if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
		return value as Record<string, unknown>;
	}
}
