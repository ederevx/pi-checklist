/**
 * pi-checklist — session and compaction lifecycle.
 *
 * The ledger is stateless, so reload, resume, and /tree need no cache repair;
 * this owner only surfaces an unreadable canonical record and re-injects the
 * current list after compaction, when the summary has replaced the earlier
 * conversation in model context.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { ChecklistContract, SCHEMA } from "./checklist-contract.ts";
import type { ReceiptLedger } from "./receipt-ledger.ts";

export class SessionLifecycle {
	private readonly pi: ExtensionAPI;
	private readonly ledger: ReceiptLedger;
	private readonly contract: ChecklistContract;

	constructor(pi: ExtensionAPI, ledger: ReceiptLedger, contract: ChecklistContract) {
		this.pi = pi;
		this.ledger = ledger;
		this.contract = contract;
	}

	register(): void {
		this.pi.on("session_start", (_event, ctx) => this.refresh(ctx));
		this.pi.on("session_tree", (_event, ctx) => this.refresh(ctx));
		this.pi.on("session_compact", (_event, ctx) => this.compacted(ctx));
	}

	private refresh(ctx: ExtensionContext): void {
		const view = this.ledger.fromContext(ctx);
		if (view.fault && ctx.hasUI) {
			ctx.ui.notify(`pi-checklist state is unreadable: ${view.fault}`, "error");
		}
	}

	private compacted(ctx: ExtensionContext): void {
		const view = this.ledger.fromContext(ctx);
		if (!view.state || (view.state.phase !== "open" && view.state.phase !== "held")) return;
		const text = `${this.contract.describe(view.state, view.ackValid)}\n${this.contract.brief(view.state)}`;
		this.pi.sendMessage(
			{
				customType: ChecklistContract.NOTICE_TYPE,
				content: text,
				display: false,
				details: {
					schema: SCHEMA,
					kind: "notice",
					anchorId: view.anchorId,
					checklistId: view.state.checklistId,
					revision: view.state.revision,
					reason: "compaction",
				},
			},
			{},
		);
	}
}
