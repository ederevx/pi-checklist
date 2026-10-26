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

	constructor(ledger: ReceiptLedger, contract: ChecklistContract) {
		this.ledger = ledger;
		this.contract = contract;
	}

	register(pi: ExtensionAPI): void {
		pi.registerTool({
			name: "checklist",
			label: "checklist",
			description:
				"Manage the branch's task checklist. Each action takes only its own fields. " +
				"create: title, tasks[1-10]. add: checklistId, revision, title. update: " +
				"checklistId, revision, taskId, status, note. ack: checklistId, revision, " +
				"summary; sole tool call in its message. list: no other field. A list holds " +
				"at most ten tasks. The run cannot settle while tasks are unfinished or the " +
				"current revision is unacknowledged.",
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
				const invalid = this.parameters.invalid(schema, params);
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
		return null;
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
