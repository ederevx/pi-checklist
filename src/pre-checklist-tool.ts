/**
 * pi-checklist — the `pre_checklist` acknowledgement tool.
 *
 * Returns the contract the agent commits to and records that this session has
 * acknowledged it. The gate reads that receipt; a nested call is refused
 * because it produces no ordinary transcript receipt.
 */

import { randomUUID } from "node:crypto";

import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { ChecklistContract, CONTRACT_VERSION, SCHEMA, type PreDetails } from "./checklist-contract.ts";
import type { ReceiptLedger } from "./receipt-ledger.ts";

export class PreChecklistTool {
	private readonly ledger: ReceiptLedger;
	private readonly contract: ChecklistContract;

	constructor(ledger: ReceiptLedger, contract: ChecklistContract) {
		this.ledger = ledger;
		this.contract = contract;
	}

	register(pi: ExtensionAPI): void {
		pi.registerTool({
			name: "pre_checklist",
			label: "pre_checklist",
			description:
				"Call at the start of every new checklist. Returns the pi-checklist " +
				"contract: one list of at most three coherent tasks, an acknowledgement " +
				"at every task or turn end, and a run that cannot settle while tasks are " +
				"unfinished or unacknowledged. Only the user can hold or dismiss the list.",
			promptGuidelines: this.contract.guidelines(),
			parameters: Type.Object(
				{
					acknowledge: Type.Literal(true, {
						description: "Acknowledge the checklist contract for this session.",
					}),
				},
				{ additionalProperties: false },
			),
			exposure: "model-only",
			execute: async (
				toolCallId: string,
				_params: { acknowledge: true },
				_signal: AbortSignal | undefined,
				_onUpdate: AgentToolUpdateCallback<PreDetails> | undefined,
				ctx: ExtensionToolContext,
			): Promise<AgentToolResult<PreDetails>> => {
				if (toolCallId.includes("/")) {
					throw new Error("pre_checklist must be called directly, not through another tool.");
				}
				const view = this.ledger.fromContext(ctx);
				const details: PreDetails = {
					schema: SCHEMA,
					kind: "pre",
					receiptId: randomUUID(),
					contractVersion: CONTRACT_VERSION,
				};
				return {
					content: [
						{
							type: "text",
							text: this.contract.catalogue(view.state),
						},
					],
					details,
				};
			},
		});
	}
}
