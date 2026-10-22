/**
 * pi-checklist — contract text, persisted record types, and shared limits.
 *
 * One contract owner: the catalogue the agent acknowledges, the prompt
 * guidelines, the custom entry names, and the view/record shapes that the
 * ledger and the tools exchange. Rendering state is a method here so every
 * surface describes the same list the same way.
 */

export const CONTRACT_VERSION = 1;
export const SCHEMA = 1;
export const MAX_TASKS = 10;
export const MAX_CONTINUATIONS_PER_ANCHOR = 3;
export const MAX_CONTINUATIONS_PER_REVISION = 5;

export type TaskStatus = "pending" | "in_progress" | "done" | "dismissed";
export type ChecklistPhase = "open" | "held" | "completed" | "dismissed";
export type ChecklistOperation =
	| "create"
	| "add"
	| "update"
	| "hold"
	| "release"
	| "dismiss_task"
	| "dismiss_list"
	| "complete";
export type ChecklistActor = "model" | "user" | "gate";
export type SettleReason =
	| "unfinished"
	| "missing_ack"
	| "attempt_cap"
	| "cannot_continue"
	| "state_fault";

export interface ChecklistTask {
	taskId: string;
	title: string;
	status: TaskStatus;
	note: string | null;
}

export interface ChecklistState {
	checklistId: string;
	revision: number;
	title: string;
	phase: ChecklistPhase;
	tasks: ChecklistTask[];
	holdReason: string | null;
}

/** A canonical, append-only snapshot transition. */
export interface StateEvent {
	schema: typeof SCHEMA;
	eventId: string;
	operation: ChecklistOperation;
	actor: ChecklistActor;
	previousRevision: number | null;
	reason: string | null;
	preReceiptId: string | null;
	ackReceiptEntryId: string | null;
	state: ChecklistState;
}

/** A settlement decision, persisted so continuation budgets survive reloads. */
export interface SettleEvent {
	schema: typeof SCHEMA;
	eventId: string;
	anchorId: string | null;
	checklistId: string;
	revision: number;
	decision: "continue" | "unresolved";
	reason: SettleReason;
}

export interface PreDetails {
	schema: typeof SCHEMA;
	kind: "pre";
	receiptId: string;
	contractVersion: number;
}

export interface MutationDetails {
	schema: typeof SCHEMA;
	kind: "mutation";
	action: "create" | "add" | "update";
	eventId: string;
	checklistId: string;
	revision: number;
}

export interface AckDetails {
	schema: typeof SCHEMA;
	kind: "ack";
	checklistId: string;
	revision: number;
	summary: string;
}

export interface ViewDetails {
	schema: typeof SCHEMA;
	kind: "view";
	state: ChecklistState | null;
	acknowledged: boolean;
	needsAck: boolean;
	fault: string | null;
}

export interface ErrorDetails {
	schema: typeof SCHEMA;
	kind: "error";
	code: string;
	message: string;
	checklistId: string | null;
	revision: number | null;
}

export type ChecklistDetails =
	| PreDetails
	| MutationDetails
	| AckDetails
	| ViewDetails
	| ErrorDetails;

export interface NoticeDetails {
	schema: typeof SCHEMA;
	kind: "notice";
	anchorId: string | null;
	checklistId: string | null;
	revision: number | null;
	reason: string;
}

/** The structural subset of a pi session entry this extension reads. */
export interface BranchEntry {
	type: string;
	id: string;
	parentId?: string | null;
	customType?: string;
	data?: unknown;
	message?: {
		role?: string;
		toolName?: string;
		toolCallId?: string;
		isError?: boolean;
		details?: unknown;
		content?: unknown;
	};
	details?: unknown;
	content?: unknown;
	display?: boolean;
}

/** One recorded acknowledgement, valid or not. */
export interface Acknowledgement {
	receiptEntryId: string;
	checklistId: string;
	revision: number;
	summary: string;
	valid: boolean;
	reason: string | null;
}

/** The derived, immutable view of one branch. */
export interface ChecklistView {
	acknowledged: boolean;
	state: ChecklistState | null;
	fault: string | null;
	preReceiptIds: string[];
	branchPreReceiptIds: string[];
	usedPreReceiptIds: string[];
	events: StateEvent[];
	ack: Acknowledgement | null;
	ackValid: boolean;
	anchorId: string | null;
	continuationsForAnchor: number;
	continuationsForRevision: number;
	notices: NoticeDetails[];
}

export interface TransitionResult {
	ok: boolean;
	details: ChecklistDetails;
	state?: ChecklistState;
}

export class ChecklistContract {
	static readonly STATE_TYPE = "pi-checklist-state";
	static readonly SETTLE_TYPE = "pi-checklist-settle";
	static readonly NOTICE_TYPE = "pi-checklist-notice";

	/** The model-facing catalogue returned by `pre_checklist`. */
	catalogue(state: ChecklistState | null = null): string {
		return [
			`pi-checklist contract v${CONTRACT_VERSION}.`,
			"",
			"Use a checklist whenever a task has multiple steps. Call pre_checklist at the",
			"start of each new checklist, then create one list of one to ten coherent",
			"tasks. A list holds at most ten task records in total; an eleventh is rejected.",
			"",
			"Mark a task done only with a completion note that names the evidence. At",
			"the end of every task or turn,",
			"review the results and acknowledge the refreshed list: call checklist with",
			"action ack as the only tool call in its assistant message. Several completed",
			"tasks may share one acknowledgement, but work performed after an",
			"acknowledgement invalidates it.",
			"",
			"The run cannot settle while the list is open with unfinished tasks or a",
			"missing acknowledgement. pi continues the run with a reminder, up to three",
			"times per user turn and five times per list revision; at that limit the list is",
			"reported unresolved and stays open for a later user turn. Only the user can",
			"hold or dismiss a checklist, through /checklist-hold, /checklist-release,",
			"and /checklist-dismiss. Never mark unfinished work done and never claim a",
			"list is complete without acknowledging it.",
			"",
			"Checklist state is stored in the session branch, so compaction, reload,",
			"resume, and /tree navigation preserve the remaining tasks. When pi-consult",
			"is installed, call pre_consult before pre_checklist, and acknowledge the",
			"checklist after the closing consultation result so it covers that work.",
			"",
			state ? `Current list:\n${this.describe(state, false)}` : "No checklist is open on this branch.",
		].join("\n");
	}

	/** Prompt guidelines installed with the tools. */
	guidelines(): string[] {
		return [
			"For any task with multiple steps, call pre_checklist at the start, create a checklist of at most ten coherent tasks, and acknowledge the refreshed list at every task or turn end with checklist action ack as the only tool call in that message.",
			"Keep checklist task statuses current: done only with a completion note naming the evidence; never mark unfinished work done.",
			"The run cannot settle while the list has unfinished tasks or lacks a current acknowledgement; finish the work and acknowledge it, or ask the user to /checklist-hold or /checklist-dismiss.",
			"Checklist state lives in the session branch and survives compaction, reload, resume, and /tree navigation; when pi-consult is installed, acknowledge after the closing consultation result.",
		];
	}

	/** The full state, or a clear empty-line. */
	describe(state: ChecklistState | null, ackValid: boolean): string {
		if (!state) return "No checklist is open on this branch.";
		const lines = [
			`Checklist ${state.checklistId} — revision ${state.revision} — ${state.phase} — ${state.title}`,
		];
		for (const task of state.tasks) {
			const note = task.note ? ` — ${task.note}` : "";
			lines.push(`- [${task.status}] #${task.taskId} ${task.title}${note}`);
		}
		if (state.holdReason) lines.push(`Hold: ${state.holdReason}`);
		lines.push(ackValid ? "Acknowledgement: current." : "Acknowledgement: required.");
		return lines.join("\n");
	}

	/** Short one-line status used by notices and commands. */
	brief(state: ChecklistState): string {
		const pending = state.tasks.filter((task) => task.status !== "done" && task.status !== "dismissed");
		const remaining = pending.length === 0 ? "none" : pending.map((task) => `#${task.taskId} ${task.title}`).join("; ");
		return `Checklist ${state.checklistId} revision ${state.revision} remains ${state.phase}; remaining: ${remaining}.`;
	}

	/** Denial text for the pre-acknowledgement checklist gate. */
	ackDenial(): string {
		return "Call pre_checklist (acknowledge: true) once in this session before creating or changing a checklist.";
	}

	/** Reminder the settle gate appends when the run must continue. */
	continuationNotice(state: ChecklistState, ackValid: boolean): string {
		const remaining = state.tasks
			.filter((task) => task.status !== "done" && task.status !== "dismissed")
			.map((task) => `#${task.taskId} ${task.title} [${task.status}]`)
			.join("; ");
		return [
			`Checklist ${state.checklistId} revision ${state.revision} is still open.`,
			`Remaining tasks: ${remaining || "none"}.`,
			`Acknowledgement: ${ackValid ? "current" : "missing"}.`,
			"Complete the remaining work, then call checklist with action ack as the only",
			"tool call in its message after reviewing the results. Do not mark unfinished",
			"work done. Only the user can hold or dismiss the list.",
		].join(" ");
	}

	/** Visible text when the continuation budget is exhausted. */
	unresolvedNotice(state: ChecklistState, reason: SettleReason, ackValid: boolean): string {
		const missing = reason === "missing_ack" || !ackValid ? "missing acknowledgement" : "remaining tasks";
		return [
			"Checklist unresolved: automatic continuation limit reached.",
			`${this.brief(state)} Missing: ${missing}.`,
			"The list remains open. Continue in a new user turn, or use /checklist-hold",
			"or /checklist-dismiss.",
		].join(" ");
	}

	/** Validation failure text. */
	error(code: string, message: string): string {
		return `${message} (${code})`;
	}
}
