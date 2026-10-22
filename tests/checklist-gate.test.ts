import { ChecklistContract } from "../src/checklist-contract.ts";
import { ChecklistGate } from "../src/checklist-gate.ts";
import { ReceiptLedger } from "../src/receipt-ledger.ts";
import {
	FakeContext,
	FakePi,
	FakeSession,
	assertEq,
	preEntry,
	test,
} from "./harness.ts";

function decide(session: FakeSession, toolName: string, input: Record<string, unknown>, toolCallId = "call-1") {
	const pi = new FakePi(session);
	const gate = new ChecklistGate(new ReceiptLedger(pi as never), new ChecklistContract());
	return gate.decide(
		{ type: "tool_call", toolName, toolCallId, input } as never,
		new FakeContext(session) as never,
	);
}

test("unrelated tools always pass", () => {
	const session = new FakeSession();
	assertEq(decide(session, "bash", { command: "true" }), undefined);
	assertEq(decide(session, "edit", { path: "x" }), undefined);
});

test("pre_checklist and checklist list pass before acknowledgement", () => {
	const session = new FakeSession();
	assertEq(decide(session, "pre_checklist", { acknowledge: true }), undefined);
	assertEq(decide(session, "checklist", { action: "list" }), undefined);
});

test("checklist mutations are blocked before acknowledgement", () => {
	const session = new FakeSession();
	const result = decide(session, "checklist", { action: "create" });
	assertEq((result as { block: boolean }).block, true);
	const ack = decide(session, "checklist", { action: "ack" });
	assertEq((ack as { block: boolean }).block, true);
});

test("checklist mutations pass after a pre receipt", () => {
	const session = new FakeSession();
	session.add(preEntry("pre-1"));
	assertEq(decide(session, "checklist", { action: "create" }), undefined);
});

test("nested calls are blocked for both tools", () => {
	const session = new FakeSession();
	session.add(preEntry("pre-1"));
	for (const name of ["checklist", "pre_checklist"]) {
		const result = decide(session, name, { action: "list" }, "parent/nested");
		assertEq((result as { block: boolean }).block, true);
	}
});
