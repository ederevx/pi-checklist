import { SCHEMA, type BranchEntry } from "../src/checklist-contract.ts";
import { ReceiptLedger } from "../src/receipt-ledger.ts";
import {
	FakeContext,
	FakePi,
	FakeSession,
	ackPair,
	assistantEntry,
	assert,
	assertEq,
	preEntry,
	stateEvent,
	test,
	toolEntry,
	userEntry,
} from "./harness.ts";

function setup(): { session: FakeSession; ledger: ReceiptLedger; branch: BranchEntry[] } {
	const session = new FakeSession();
	const pi = new FakePi(session);
	return { session, ledger: new ReceiptLedger(pi as never), branch: session.entries };
}

function openList(branch: BranchEntry[]): void {
	branch.push(
		userEntry("u1"),
		preEntry("pre-1"),
		stateEvent("e1", "create", null, {
			checklistId: "list-1",
			revision: 1,
			title: "Work",
			phase: "open",
			tasks: [{ taskId: "t1", title: "one", status: "pending", note: null }],
			holdReason: null,
		}),
	);
}

test("a sole acknowledgement after the latest work is valid", () => {
	const { session, ledger, branch } = setup();
	openList(branch);
	branch.push(assistantEntry("w1", [{ id: "work-1", name: "bash" }]));
	branch.push(toolEntry("work-result", "bash", {}, { toolCallId: "work-1" }));
	ackPair(branch, "list-1", 1, 1);
	const view = ledger.fromContext(new FakeContext(session) as never);
	assertEq(view.ackValid, true);
	assertEq(view.ack?.receiptEntryId, "ack-receipt-1");
});

test("work after the acknowledgement invalidates it", () => {
	const { session, ledger, branch } = setup();
	openList(branch);
	ackPair(branch, "list-1", 1, 1);
	branch.push(toolEntry("work-result", "bash", {}, { toolCallId: "late" }));
	const view = ledger.fromContext(new FakeContext(session) as never);
	assertEq(view.ackValid, false);
	assertEq(view.ack?.reason, "before_work");
});

test("an acknowledgement before the latest user message is invalid", () => {
	const { session, ledger, branch } = setup();
	openList(branch);
	ackPair(branch, "list-1", 1, 1);
	branch.push(userEntry("u2"));
	const view = ledger.fromContext(new FakeContext(session) as never);
	assertEq(view.ackValid, false);
	assertEq(view.ack?.reason, "before_user");
});

test("an acknowledgement before the state transition is invalid", () => {
	const { session, ledger, branch } = setup();
	branch.push(userEntry("u1"), preEntry("pre-1"));
	ackPair(branch, "list-1", 1, 1);
	branch.push(stateEvent("e1", "create", null, {
		checklistId: "list-1",
		revision: 1,
		title: "Work",
		phase: "open",
		tasks: [{ taskId: "t1", title: "one", status: "pending", note: null }],
		holdReason: null,
	}));
	const view = ledger.fromContext(new FakeContext(session) as never);
	assertEq(view.ackValid, false);
	assertEq(view.ack?.reason, "before_state");
});

test("a stale revision is not valid", () => {
	const { session, ledger, branch } = setup();
	openList(branch);
	ackPair(branch, "list-1", 4, 1);
	const view = ledger.fromContext(new FakeContext(session) as never);
	assertEq(view.ackValid, false);
	assertEq(view.ack?.reason, "revision");
});

test("a multi-call message is not a valid acknowledgement", () => {
	const { session, ledger, branch } = setup();
	openList(branch);
	branch.push(assistantEntry("a1", [
		{ id: "ack-call", name: "checklist" },
		{ id: "other", name: "bash" },
	]));
	branch.push(toolEntry("ack-receipt", "checklist", {
		schema: SCHEMA,
		kind: "ack",
		checklistId: "list-1",
		revision: 1,
		summary: "reviewed",
	}, { toolCallId: "ack-call" }));
	const view = ledger.fromContext(new FakeContext(session) as never);
	assertEq(view.ackValid, false);
	assertEq(view.ack?.reason, "not_sole_call");
});

test("a later consultation delivery invalidates the acknowledgement", () => {
	const { session, ledger, branch } = setup();
	openList(branch);
	ackPair(branch, "list-1", 1, 1);
	branch.push({
		type: "custom_message",
		id: "consult-result",
		customType: "pi-consult-result",
		content: "answer",
		display: false,
	});
	const view = ledger.fromContext(new FakeContext(session) as never);
	assertEq(view.ackValid, false);
	assert(view.ack?.reason === "before_work", "expected before_work");
});

test("the extension's own notices do not invalidate an acknowledgement", () => {
	const { session, ledger, branch } = setup();
	openList(branch);
	ackPair(branch, "list-1", 1, 1);
	branch.push({
		type: "custom_message",
		id: "notice",
		customType: "pi-checklist-notice",
		content: "reminder",
		display: false,
		details: { schema: SCHEMA, kind: "notice", checklistId: "list-1", revision: 1, reason: "unfinished" },
	});
	const view = ledger.fromContext(new FakeContext(session) as never);
	assertEq(view.ackValid, true);
});

test("a failed tool result still counts as work", () => {
	const { session, ledger, branch } = setup();
	openList(branch);
	ackPair(branch, "list-1", 1, 1);
	branch.push(toolEntry("failed", "bash", {}, { toolCallId: "failed", isError: true }));
	const view = ledger.fromContext(new FakeContext(session) as never);
	assertEq(view.ackValid, false);
});

test("hold and dismiss phases make acknowledgement irrelevant", () => {
	const { session, ledger, branch } = setup();
	openList(branch);
	ackPair(branch, "list-1", 1, 1);
	branch.push(stateEvent("e2", "hold", {
		checklistId: "list-1",
		revision: 1,
		title: "Work",
		phase: "open",
		tasks: [{ taskId: "t1", title: "one", status: "pending", note: null }],
		holdReason: null,
	}, {
		checklistId: "list-1",
		revision: 2,
		title: "Work",
		phase: "held",
		tasks: [{ taskId: "t1", title: "one", status: "pending", note: null }],
		holdReason: "user",
	}, { reason: "user" }));
	const view = ledger.fromContext(new FakeContext(session) as never);
	assertEq(view.ackValid, false);
	assertEq(view.state?.phase, "held");
});
