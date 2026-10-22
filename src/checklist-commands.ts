/**
 * pi-checklist — user-only control commands.
 *
 * Hold, release, and dismissal are user authority: no model tool can invoke
 * them, and natural-language requests are not parsed into authority. Commands
 * operate on the branch's latest revision and never start a model turn.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { ChecklistContract, ChecklistDetails } from "./checklist-contract.ts";
import type { ReceiptLedger } from "./receipt-ledger.ts";

export class ChecklistCommands {
	private readonly pi: ExtensionAPI;
	private readonly ledger: ReceiptLedger;
	private readonly contract: ChecklistContract;

	constructor(pi: ExtensionAPI, ledger: ReceiptLedger, contract: ChecklistContract) {
		this.pi = pi;
		this.ledger = ledger;
		this.contract = contract;
	}

	register(): void {
		this.pi.registerCommand("checklist", {
			description: "Show the active checklist, its revision, and acknowledgement state.",
			handler: async (_args: string, ctx: ExtensionCommandContext) => {
				const view = this.ledger.fromContext(ctx);
				const body = view.fault
					? `pi-checklist state fault: ${view.fault}`
					: this.contract.describe(view.state, view.ackValid);
				this.notify(ctx, body, view.fault ? "error" : "info");
			},
		});
		this.pi.registerCommand("checklist-hold", {
			description: "Hold the active checklist until explicitly released.",
			handler: async (args: string, ctx: ExtensionCommandContext) => {
				const reason = args.trim();
				if (!reason) return this.notify(ctx, "Usage: /checklist-hold <reason>", "error");
				const result = this.ledger.transition({ kind: "hold", reason, actor: "user" }, ctx);
				this.report(ctx, result.ok, result.details, "Checklist held.");
			},
		});
		this.pi.registerCommand("checklist-release", {
			description: "Release a held checklist; a fresh acknowledgement is required.",
			handler: async (_args: string, ctx: ExtensionCommandContext) => {
				const result = this.ledger.transition({ kind: "release", actor: "user" }, ctx);
				this.report(ctx, result.ok, result.details, "Checklist released; acknowledge it again.");
			},
		});
		this.pi.registerCommand("checklist-dismiss", {
			description: "Dismiss one task or the whole checklist: /checklist-dismiss <taskId|all> <reason>",
			handler: async (args: string, ctx: ExtensionCommandContext) => {
				const [target, ...rest] = args.trim().split(/\s+/);
				const reason = rest.join(" ").trim();
				if (!target || !reason) {
					return this.notify(ctx, "Usage: /checklist-dismiss <taskId|all> <reason>", "error");
				}
				const view = this.ledger.fromContext(ctx);
				const state = view.state;
				const task = state?.tasks.find((candidate) => candidate.taskId === target);
				if (target !== "all" && !task) {
					return this.notify(ctx, `No task ${target} in the active checklist.`, "error");
				}
				const result = target === "all"
					? this.ledger.transition({ kind: "dismissList", reason, actor: "user" }, ctx)
					: this.ledger.transition({ kind: "dismissTask", taskId: target, reason, actor: "user" }, ctx);
				this.report(
					ctx,
					result.ok,
					result.details,
					target === "all" ? "Checklist dismissed." : `Task ${target} dismissed.`,
				);
			},
		});
	}

	private report(
		ctx: ExtensionCommandContext,
		ok: boolean,
		details: ChecklistDetails,
		success: string,
	): void {
		const failure = details.kind === "error" ? details.message : "Checklist action failed.";
		this.notify(ctx, ok ? success : failure, ok ? "info" : "error");
	}

	private notify(ctx: ExtensionCommandContext, message: string, type: "info" | "error"): void {
		if (ctx.hasUI) ctx.ui.notify(message, type);
	}
}
