/**
 * pi-checklist — settlement enforcement.
 *
 * One `agent_before_settle` handler owns the decision to continue, complete, or
 * report the list unresolved. Continuations are bounded per user anchor and
 * per revision, so an unfinished checklist is forced forward without letting a
 * model loop forever. Aborts and errors never consume the budget.
 */

import { randomUUID } from "node:crypto";

import type {
	AgentBeforeSettleEvent,
	BoundaryResult,
	ExtensionAPI,
	ExtensionContext,
	SessionBoundaryDraft,
} from "@earendil-works/pi-coding-agent";

import {
	ChecklistContract,
	MAX_CONTINUATIONS_PER_ANCHOR,
	MAX_CONTINUATIONS_PER_REVISION,
	SCHEMA,
	type ChecklistState,
	type ChecklistView,
	type SettleEvent,
	type SettleReason,
} from "./checklist-contract.ts";
import type { ReceiptLedger } from "./receipt-ledger.ts";

export class SettleGate {
	private readonly ledger: ReceiptLedger;
	private readonly contract: ChecklistContract;

	constructor(ledger: ReceiptLedger, contract: ChecklistContract) {
		this.ledger = ledger;
		this.contract = contract;
	}

	register(pi: ExtensionAPI): void {
		pi.on("agent_before_settle", (event: AgentBeforeSettleEvent, ctx: ExtensionContext) =>
			this.decide(event, ctx),
		);
	}

	decide(event: AgentBeforeSettleEvent, ctx: ExtensionContext): BoundaryResult | undefined {
		if (event.outcome === "aborted" || event.outcome === "error") return undefined;
		const view = this.ledger.view(
			ctx.sessionManager.getEntries() as never,
			ctx.sessionManager.getBranch() as never,
			event.entries,
		);
		const state = view.state;
		if (view.fault) return this.unresolved(event, view, state, "state_fault");
		if (!state || state.phase !== "open") return undefined;
		const allTerminal = state.tasks.every(
			(task) => task.status === "done" || task.status === "dismissed",
		);
		if (allTerminal && view.ackValid) {
			const completion = this.ledger.completionDraft(view);
			if (!completion) return undefined;
			return { entries: [...event.entries, completion.draft as SessionBoundaryDraft] };
		}
		// Another extension already owns a continuation for this boundary; do not
		// charge this checklist and let the next boundary decide.
		if (event.continue) return undefined;
		const overBudget =
			view.continuationsForAnchor >= MAX_CONTINUATIONS_PER_ANCHOR ||
			view.continuationsForRevision >= MAX_CONTINUATIONS_PER_REVISION;
		if (overBudget) return this.unresolved(event, view, state, "attempt_cap");
		const reason: SettleReason = allTerminal ? "missing_ack" : "unfinished";
		return this.continuation(event, view, state, reason);
	}

	private continuation(
		event: AgentBeforeSettleEvent,
		view: ChecklistView,
		state: ChecklistState,
		reason: SettleReason,
	): BoundaryResult {
		const audit = this.audit(view, state, "continue", reason);
		const notice: SessionBoundaryDraft = {
			type: "custom_message",
			customType: ChecklistContract.NOTICE_TYPE,
			content: this.contract.continuationNotice(state, view.ackValid),
			display: false,
			details: {
				schema: SCHEMA,
				kind: "notice",
				anchorId: view.anchorId,
				checklistId: state.checklistId,
				revision: state.revision,
				reason,
			},
		};
		return {
			entries: [...event.entries, audit, notice],
			continue: true,
		};
	}

	private unresolved(
		event: AgentBeforeSettleEvent,
		view: ChecklistView,
		state: ChecklistState | null,
		reason: SettleReason,
	): BoundaryResult | undefined {
		const duplicate = view.notices.some(
			(notice) =>
				notice.anchorId === view.anchorId &&
				notice.checklistId === (state?.checklistId ?? null) &&
				notice.revision === (state?.revision ?? null) &&
				notice.reason === reason,
		);
		if (duplicate) return undefined;
		const text = !state
			? `Checklist unresolved: ${view.fault ?? "the checklist state is unreadable"}.`
			: reason === "state_fault"
				? `Checklist unresolved: ${view.fault}. ${this.contract.brief(state)}`
				: reason === "cannot_continue"
					? `Checklist unresolved: the host cannot continue this run automatically. ${this.contract.brief(state)}`
					: this.contract.unresolvedNotice(state, reason, view.ackValid);
		const entries: SessionBoundaryDraft[] = [];
		if (state) entries.push(this.audit(view, state, "unresolved", reason));
		entries.push({
			type: "custom_message",
			customType: ChecklistContract.NOTICE_TYPE,
			content: text,
			display: true,
			details: {
				schema: SCHEMA,
				kind: "notice",
				anchorId: view.anchorId,
				checklistId: state?.checklistId ?? null,
				revision: state?.revision ?? null,
				reason,
			},
		});
		return { entries: [...event.entries, ...entries] };
	}

	private audit(
		view: ChecklistView,
		state: ChecklistState,
		decision: SettleEvent["decision"],
		reason: SettleReason,
	): SessionBoundaryDraft {
		const event: SettleEvent = {
			schema: SCHEMA,
			eventId: randomUUID(),
			anchorId: view.anchorId,
			checklistId: state.checklistId,
			revision: state.revision,
			decision,
			reason,
		};
		return {
			type: "custom",
			customType: ChecklistContract.SETTLE_TYPE,
			data: event,
		};
	}
}
