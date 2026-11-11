/**
 * pi-checklist — contract text, persisted record types, and shared limits.
 *
 * One contract owner: the catalogue the agent acknowledges, the prompt
 * guidelines, the custom entry names, and the view/record shapes that the
 * ledger and the tools exchange. Rendering state is a method here so every
 * surface describes the same list the same way.
 */

export const CONTRACT_VERSION = 2;
export const SCHEMA = 1;
export const MAX_TASKS = 10;

export type TaskStatus = "pending" | "in_progress" | "done" | "dismissed";
export type ChecklistPhase = "open" | "held" | "completed" | "dismissed";
export type ChecklistOperation =
	| "create"
	| "replace"
	| "add"
	| "update"
	| "remove_task"
	| "hold"
	| "release"
	| "dismiss_task"
	| "dismiss_list"
	| "complete";
export type ChecklistActor = "model" | "user" | "gate";
export type SettleReason =
	| "unfinished"
	| "missing_ack"
	| "cannot_continue"
	| "state_fault";

export interface ChecklistTask {
	taskId: string;
	title: string;
	status: TaskStatus;
	note: string | null;
	/** Immutable originating user-message entry; null only for historical tasks. */
	sourceAnchorId: string | null;
}

export interface ChecklistState {
	checklistId: string;
	revision: number;
	title: string;
	phase: ChecklistPhase;
	tasks: ChecklistTask[];
	holdReason: string | null;
}

/** The list a replacement displaced, kept readable in the event that replaced it. */
export interface ReplacedChecklist {
	checklistId: string;
	revision: number;
	title: string;
	phase: "open" | "held";
	holdReason: string | null;
}

/** A canonical, append-only snapshot transition. */
export interface StateEvent {
	schema: typeof SCHEMA;
	/** The addition policy this transition was written under; absent means historical. */
	policyVersion?: 1 | 2;
	eventId: string;
	operation: ChecklistOperation;
	actor: ChecklistActor;
	previousRevision: number | null;
	reason: string | null;
	preReceiptId: string | null;
	ackReceiptEntryId: string | null;
	/** The user message a model addition, dismissal, or replacement cites as its basis. */
	anchorId?: string | null;
	replacedChecklist?: ReplacedChecklist | null;
	state: ChecklistState;
}

/** A settlement decision, persisted so the report of it survives reloads. */
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
	anchorId: string | null;
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
	/** The latest user prompt on the branch, which an addition must cite. */
	anchorId: string | null;
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
	stateEntryId: string | null;
	fault: string | null;
	preReceiptIds: string[];
	branchPreReceiptIds: string[];
	usedPreReceiptIds: string[];
	events: StateEvent[];
	ack: Acknowledgement | null;
	ackValid: boolean;
	anchorId: string | null;
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
	static readonly OPERATIONS: readonly ChecklistOperation[] = [
		"create",
		"replace",
		"add",
		"update",
		"remove_task",
		"hold",
		"release",
		"dismiss_task",
		"dismiss_list",
		"complete",
	];

	/** The model-facing catalogue returned by `pre_checklist`. */
	catalogue(state: ChecklistState | null = null): string {
		return [
			`pi-checklist contract v${CONTRACT_VERSION}.`,
			"",
			"Use a checklist for a user request with multiple steps. Call pre_checklist",
			"before starting a new list. Create, add, and replace require anchorId naming",
			"the latest user prompt on this branch, and that prompt must follow the latest",
			"checklist revision. Put all initially required tasks in one create call:",
			"another addition requires another user prompt. Every new task must be",
			"necessary to complete the cited request; never add self-appointed scope or",
			"treat a tool, daemon, or consultation result as user authorization. A list",
			"holds at most ten task records in total; an eleventh is rejected.",
			"A completed task can be removed by taskId to free a place. Removal does not",
			"authorize a replacement task; a subsequent addition still requires a new user",
			"prompt after the removal revision.",
			"",
			"Mark a task done only with a completion note that names the evidence. At",
			"the end of every task or turn,",
			"review the results and acknowledge the refreshed list: call checklist with",
			"action ack as the only tool call in its assistant message. Several completed",
			"tasks may share one acknowledgement, but work performed after an",
			"acknowledgement invalidates it.",
			"",
			"Settlement is never forced. If a turn ends while the list is open with",
			"unfinished tasks or a missing acknowledgement, the run settles and a visible",
			"notice reports what is left; the list stays open for a later turn. Continue in",
			"a turn whenever the remaining work is yours to do, and end it when the rest",
			"needs a user decision. The user holds,",
			"releases, and dismisses through /checklist-hold, /checklist-release, and",
			"/checklist-dismiss. When a later user message changes priorities, dismiss or",
			"replace the list yourself: pass a reason, the checklistId and revision you",
			"read, and that message's anchorId, which must follow the current revision on",
			"this branch. Either action appends a visible notice; a dismissal never means",
			"the abandoned work was completed. Never mark unfinished work done and never",
			"claim a list is complete without acknowledging it.",
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
			"For a user request with multiple steps, call pre_checklist at the start and create the whole list in one call, citing as anchorId the latest user prompt, which must follow the latest checklist revision; another addition needs another user prompt, and every task must be necessary to complete the request that prompt states, never self-appointed scope. Acknowledge the refreshed list at every task or turn end with checklist action ack as the only tool call in that message.",
			"Keep checklist task statuses current: done only with a completion note naming the evidence; never mark unfinished work done.",
			"Leave a list open only deliberately: an unfinished list at the end of a turn is reported unresolved and stays open for a later turn, because settlement is never forced - continue on your own judgement and stop when the rest needs a user decision; use dismiss or replace when a later user message changes priorities, naming its anchorId and a reason.",
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
			const source = task.sourceAnchorId ? ` [source: ${task.sourceAnchorId}]` : " [source: legacy]";
			const note = task.note ? ` — ${task.note}` : "";
			lines.push(`- [${task.status}] #${task.taskId} ${task.title}${source}${note}`);
		}
		if (state.holdReason) {
			lines.push(state.phase === "dismissed" ? `Dismissed: ${state.holdReason}` : `Hold: ${state.holdReason}`);
		}
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

	/** Visible text when a run settles with its list still open. */
	unresolvedNotice(state: ChecklistState, reason: SettleReason, ackValid: boolean): string {
		const missing = reason === "missing_ack" || !ackValid ? "missing acknowledgement" : "remaining tasks";
		return [
			"Checklist unresolved: the run settled with this list still open.",
			`${this.brief(state)} Missing: ${missing}.`,
			"The list remains open for a later turn. Resume it, or ask the user to use",
			"/checklist-hold or /checklist-dismiss; a later user message that changes",
			"priorities may justify dismiss or replace with its anchorId and a reason.",
		].join(" ");
	}

	/** Validation failure text. */
	error(code: string, message: string): string {
		return `${message} (${code})`;
	}
}
