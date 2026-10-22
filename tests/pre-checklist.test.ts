import { ChecklistContract } from "../src/checklist-contract.ts";
import { PreChecklistTool } from "../src/pre-checklist-tool.ts";
import { ReceiptLedger } from "../src/receipt-ledger.ts";
import {
	FakeContext,
	FakePi,
	FakeSession,
	assert,
	assertEq,
	assertIncludes,
	makeState,
	preEntry,
	stateEvent,
	test,
} from "./harness.ts";

function setup(): { pi: FakePi; ctx: FakeContext } {
	const session = new FakeSession();
	const pi = new FakePi(session);
	const ledger = new ReceiptLedger(pi as never);
	new PreChecklistTool(ledger, new ChecklistContract()).register(pi as never);
	return { pi, ctx: new FakeContext(session) };
}

test("pre_checklist returns the contract and records a pre receipt", async () => {
	const { pi, ctx } = setup();
	const result = (await pi.tool("pre_checklist", { acknowledge: true }, ctx)) as {
		details: { kind: string; receiptId: string; contractVersion: number };
		content: Array<{ text: string }>;
	};
	assertEq(result.details.kind, "pre");
	assertEq(result.details.contractVersion, 1);
	assert(result.details.receiptId.length > 0, "expected a receipt id");
	assertIncludes(result.content[0].text, "pi-checklist contract");
});

test("pre_checklist refuses a nested call", async () => {
	const { pi, ctx } = setup();
	let failed = false;
	try {
		await pi.tool("pre_checklist", { acknowledge: true }, ctx, "parent/call");
	} catch (error) {
		failed = String(error).includes("called directly");
	}
	assert(failed, "nested pre_checklist must throw");
});

test("pre receipt is session-wide while state is branch-scoped", () => {
	const session = new FakeSession();
	const pi = new FakePi(session);
	const ledger = new ReceiptLedger(pi as never);
	const branch = [preEntry("pre-1"), stateEvent("e1", "create", null, makeState())];
	session.setBranch(branch, [preEntry("pre-1"), stateEvent("e1", "create", null, makeState())]);
	const view = ledger.fromContext(new FakeContext(session) as never);
	assert(view.acknowledged, "pre receipt should acknowledge the session");
	assertEq(view.state?.checklistId, "list-1");
});
