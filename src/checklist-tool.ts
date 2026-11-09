/**
 * pi-checklist — the `checklist` tool.
 *
 * One action tool owns create/add/update/ack/list so revision validation and
 * persistence stay under one surface. Mutations delegate to the ledger; the
 * acknowledgement is validated against the working branch before the tool
 * result exists. List reads and acknowledgement are allowed before the
 * catalog is acknowledged; every other action is refused.
 */

import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import {
	ChecklistContract,
	SCHEMA,
	type AckDetails,
	type ChecklistDetails,
	type ChecklistState,
	type ErrorDetails,
	type MutationDetails,
	type ViewDetails,
} from "./checklist-contract.ts";
import { ChecklistParameters } from "./checklist-parameters.ts";
import type { ReceiptLedger, TransitionCommand } from "./receipt-ledger.ts";

export class ChecklistTool {
	private readonly ledger: ReceiptLedger;
	private readonly contract: ChecklistContract;
	private readonly parameters = new ChecklistParameters();
	private pi!: ExtensionAPI;

	constructor(ledger: ReceiptLedger, contract: ChecklistContract) {
		this.ledger = ledger;
		this.contract = contract;
	}

	register(pi: ExtensionAPI): void {
		this.pi = pi;
		pi.registerTool({
			name: "checklist",
			label: "checklist",
			description:
				"Manage the branch's task checklist. Each action takes only its own fields. " +
				"create: title, tasks[1-10]. add: checklistId, revision, title. update: " +
				"checklistId, revision, taskId, status, note. remove: checklistId, revision, " +
				"taskId of a done task, freeing its place in the list; dismiss: checklistId, revision, " +
				"reason, anchorId, optional taskId; omit taskId to dismiss the whole list. " +
				"replace: checklistId, revision, reason, anchorId, title, tasks[1-10]. ack: " +
				"checklistId, revision, summary; sole tool call in its message. list: no other " +
				"field. A model dismissal or replacement needs the anchorId of a user message " +
				"after the current revision, appends a visible notice, and a replacement " +
				"consumes a fresh pre_checklist receipt. Only the user holds or releases a list. " +
				"A list left open at the end of a turn is reported and stays open; no " +
				"continuation is forced.",
			parameters: this.parameters.schema,
			exposure: "model-only",
			executionMode: "sequential",
			execute: async (
				toolCallId: string,
				params: Record<string, unknown>,
				_signal: AbortSignal | undefined,
				_onUpdate: AgentToolUpdateCallback<ChecklistDetails> | undefined,
				ctx: ExtensionToolContext,
			): Promise<AgentToolResult<ChecklistDetails>> => {
				if (toolCallId.includes("/")) {
					return this.error("NESTED_CALL", "checklist cannot be called through another tool.");
				}
				const action = String(params.action ?? "");
				const schema = this.parameters.schemaFor(action);
				if (!schema) return this.error("UNKNOWN_ACTION", `Unknown action: ${action}`);
				const invalid = this.parameters.invalid(action, schema, params);
				if (invalid) return this.error("INVALID_ARGS", invalid);
				const view = this.ledger.fromContext(ctx);
				if (action === "list") {
					const needsAck = view.state !== null &&
						(view.state.phase === "open" || view.state.phase === "held") &&
						!view.ackValid;
					const details: ViewDetails = {
						schema: SCHEMA,
						kind: "view",
						state: view.state,
						acknowledged: view.acknowledged,
						needsAck,
						fault: view.fault,
					};
					return this.success(this.describe(view.state, view.ackValid, view.fault), details);
				}
				if (!view.acknowledged) {
					return this.error("PRE_REQUIRED", this.contract.ackDenial());
				}
				if (view.fault) return this.error("STATE_FAULT", view.fault);
				if (action === "ack") {
					const result = this.ledger.acknowledge(
						this.identifier(params.checklistId),
						Number(params.revision ?? 0),
						String(params.summary ?? ""),
						toolCallId,
						ctx,
					);
					if (!result.ok || result.details.kind !== "ack") return this.fromFailure(result.details);
					const ack = result.details as AckDetails;
					return this.success(
						`Acknowledged ${ack.checklistId} revision ${ack.revision}: ${ack.summary}`,
						ack,
					);
				}
				const command = this.command(action, params);
				if (!command) return this.error("UNKNOWN_ACTION", `Unknown action: ${action}`);
				const result = this.ledger.transition(command, ctx);
				if (!result.ok) return this.fromFailure(result.details);
				if (command.kind === "replace" || command.kind === "dismissTask" || command.kind === "dismissList") {
					this.announce(this.transitionNotice(command, result.state ?? null), result.state ?? null, command.anchorId);
				}
				const details = result.details as MutationDetails;
				const state = result.state;
				const text = state
					? `Checklist ${state.checklistId} revision ${state.revision} updated.\n` +
						this.contract.describe(state, false)
					: `Checklist updated: ${details.checklistId} revision ${details.revision}.`;
				return this.success(text, details);
			},
		});
	}

	private command(action: string, params: Record<string, unknown>): TransitionCommand | null {
		if (action === "create") {
			return {
				kind: "create",
				title: String(params.title ?? ""),
				tasks: Array.isArray(params.tasks) ? params.tasks.map(String) : [],
				actor: "model",
			};
		}
		if (action === "add") {
			return {
				kind: "add",
				checklistId: this.identifier(params.checklistId),
				revision: Number(params.revision ?? 0),
				title: String(params.title ?? ""),
				actor: "model",
			};
		}
		if (action === "update") {
			return {
				kind: "update",
				checklistId: this.identifier(params.checklistId),
				revision: Number(params.revision ?? 0),
				taskId: this.identifier(params.taskId),
				status: String(params.status ?? "pending") as "pending" | "in_progress" | "done",
				note: typeof params.note === "string" ? params.note : undefined,
				actor: "model",
			};
		}
		if (action === "remove") {
			return {
				kind: "removeTask",
				checklistId: this.identifier(params.checklistId),
				revision: Number(params.revision ?? 0),
				taskId: this.identifier(params.taskId),
				actor: "model",
			};
		}
		if (action === "dismiss") {
			const common = {
				checklistId: this.identifier(params.checklistId),
				revision: Number(params.revision ?? 0),
				reason: String(params.reason ?? ""),
				anchorId: String(params.anchorId ?? ""),
				actor: "model" as const,
			};
			return params.taskId === undefined
				? { kind: "dismissList", ...common }
				: { kind: "dismissTask", taskId: this.identifier(params.taskId), ...common };
		}
		if (action === "replace") {
			return {
				kind: "replace",
				checklistId: this.identifier(params.checklistId),
				revision: Number(params.revision ?? 0),
				title: String(params.title ?? ""),
				tasks: Array.isArray(params.tasks) ? params.tasks.map(String) : [],
				reason: String(params.reason ?? ""),
				anchorId: String(params.anchorId ?? ""),
				actor: "model",
			};
		}
		return null;
	}

	/** The user-visible account of a model dismissal or replacement. */
	private transitionNotice(command: TransitionCommand, state: ChecklistState | null): string {
		if (command.kind === "replace") {
			const created = state ? ` with checklist ${state.checklistId} revision ${state.revision}` : "";
			return `Model replaced checklist ${command.checklistId} revision ${command.revision}${created} following user message ${command.anchorId}. Reason: ${command.reason}`;
		}
		if (command.kind === "dismissTask") {
			return `Model dismissed task ${command.taskId} of checklist ${command.checklistId} revision ${command.revision} following user message ${command.anchorId}. Reason: ${command.reason}`;
		}
		if (command.kind === "dismissList") {
			return `Model dismissed checklist ${command.checklistId} revision ${command.revision} following user message ${command.anchorId}. Reason: ${command.reason}`;
		}
		return "";
	}

	private announce(text: string, state: ChecklistState | null, anchorId: string): void {
		if (!text) return;
		this.pi.sendMessage(
			{
				customType: ChecklistContract.NOTICE_TYPE,
				content: text,
				display: true,
				details: {
					schema: SCHEMA,
					kind: "notice",
					anchorId,
					checklistId: state?.checklistId ?? null,
					revision: state?.revision ?? null,
					reason: "model-transition",
				},
			},
			{ triggerTurn: false },
		);
	}

	/** An id as the model meant it; tool-call arguments can wrap it in one pair of quotes. */
	private identifier(value: unknown): string {
		const text = String(value ?? "").trim();
		const quoted = text.length >= 2 && (text[0] === '"' || text[0] === "'") && text.at(-1) === text[0];
		return quoted ? text.slice(1, -1) : text;
	}

	private describe(state: ChecklistState | null, ackValid: boolean, fault: string | null): string {
		const body = this.contract.describe(state, ackValid);
		return fault ? `${body}\nState fault: ${fault}` : body;
	}

	private success(text: string, details: ChecklistDetails): AgentToolResult<ChecklistDetails> {
		return { content: [{ type: "text", text }], details };
	}

	private error(code: string, message: string): AgentToolResult<ChecklistDetails> {
		const details: ErrorDetails = {
			schema: SCHEMA,
			kind: "error",
			code,
			message,
			checklistId: null,
			revision: null,
		};
		return { content: [{ type: "text", text: this.contract.error(code, message) }], details, isError: true };
	}

	private fromFailure(details: ChecklistDetails): AgentToolResult<ChecklistDetails> {
		const failure = details.kind === "error" ? details : undefined;
		const text = failure
			? this.contract.error(failure.code, failure.message)
			: "Checklist action failed.";
		return { content: [{ type: "text", text }], details, isError: true };
	}
}
