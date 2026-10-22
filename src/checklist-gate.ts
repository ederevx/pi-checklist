/**
 * pi-checklist — the catalogue acknowledgement gate.
 *
 * One `tool_call` handler: unrelated tools always pass, `pre_checklist` and
 * `checklist` list/ack are always available, and only the mutating checklist
 * actions wait for `pre_checklist`. Nothing else is gated, so pi-consult's own
 * gate and this one compose in either registration order.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

import type { ChecklistContract } from "./checklist-contract.ts";
import type { ReceiptLedger } from "./receipt-ledger.ts";

export class ChecklistGate {
	private readonly ledger: ReceiptLedger;
	private readonly contract: ChecklistContract;

	constructor(ledger: ReceiptLedger, contract: ChecklistContract) {
		this.ledger = ledger;
		this.contract = contract;
	}

	register(pi: ExtensionAPI): void {
		pi.on("tool_call", (event: ToolCallEvent, ctx: ExtensionContext) =>
			this.decide(event, ctx),
		);
	}

	decide(event: ToolCallEvent, ctx: ExtensionContext): ToolCallEventResult | undefined {
		if (event.toolName !== "checklist" && event.toolName !== "pre_checklist") return undefined;
		if (event.toolCallId.includes("/")) {
			return { block: true, reason: `${event.toolName} must be called directly, not through another tool.` };
		}
		if (event.toolName === "pre_checklist") return undefined;
		const action = String((event.input as Record<string, unknown>).action ?? "");
		if (action === "list") return undefined;
		const view = this.ledger.fromContext(ctx);
		if (view.acknowledged) return undefined;
		return { block: true, reason: this.contract.ackDenial() };
	}
}
