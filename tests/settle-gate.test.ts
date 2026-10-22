import { ChecklistContract, type ChecklistState } from "../src/checklist-contract.ts";
import { ReceiptLedger } from "../src/receipt-ledger.ts";
import { SettleGate } from "../src/settle-gate.ts";
import {
	FakeContext,
	FakePi,
	FakeSession,
	ackPair,
	assert,
	assertEq,
	boundary,
	preEntry,
	settleEntry,
	stateEvent,
	test,
	userEntry,
} from "./harness.ts";

function state(overrides: Partial<ChecklistState> = {}): ChecklistState {
	return {
		checklistId: "list-1",
		revision: 1,
		title: "Work",
		phase: "open",
		tasks: [{ taskId: "t1", title: "one", status: "pending", note: null }],
		holdReason: null,
		...overrides,
	};
}

function setup(): { session: FakeSession; gate: SettleGate; ctx: FakeContext; ledger: ReceiptLedger } {
	const session = new FakeSession();
	const pi = new FakePi(session);
	const ledger = new ReceiptLedger(pi as never);
	return {
		session,
		ledger,
		gate: new SettleGate(ledger, new ChecklistContract()),
		ctx: new FakeContext(session),
	};
}

function open(session: FakeSession, overrides: Partial<ChecklistState> = {}): void {
	session.add(userEntry("u1"), preEntry("pre-1"), stateEvent("e1", "create", null, state(overrides)));
}

test("aborts and errors never continue", () => {
	const { session, gate, ctx } = setup();
	open(session);
	assertEq(gate.decide(boundary("aborted") as never, ctx as never), undefined);
	assertEq(gate.decide(boundary("error") as never, ctx as never), undefined);
});

test("no list or a held/dismissed list never continues", () => {
	const { session, gate, ctx } = setup();
	assertEq(gate.decide(boundary() as never, ctx as never), undefined);
	open(session);
	session.add(stateEvent("e2", "hold", state(), state({ revision: 2, phase: "held", holdReason: "user" }), { reason: "user" }));
	assertEq(gate.decide(boundary() as never, ctx as never), undefined);
});

test("an unfinished list requests one continuation with a hidden notice", () => {
	const { session, gate, ctx } = setup();
	open(session);
	const result = gate.decide(boundary() as never, ctx as never) as {
		continue: boolean;
		entries: Array<{ type: string; customType?: string; display?: boolean }>;
	};
	assertEq(result.continue, true);
	assertEq(result.entries.length, 2);
	assertEq(result.entries[0].customType, "pi-checklist-settle");
	assertEq(result.entries[1].customType, "pi-checklist-notice");
	assertEq(result.entries[1].display, false);
});

test("finished tasks without an acknowledgement continue for the acknowledgement", () => {
	const { session, gate, ctx } = setup();
	open(session, { tasks: [{ taskId: "t1", title: "one", status: "done", note: "ok" }] });
	const result = gate.decide(boundary() as never, ctx as never) as { continue: boolean; entries: Array<{ content?: string }> };
	assertEq(result.continue, true);
	assert(String(result.entries[1].content).includes("Acknowledgement: missing"));
});

test("a finished and acknowledged list completes without continuing", () => {
	const { session, gate, ctx } = setup();
	open(session, { tasks: [{ taskId: "t1", title: "one", status: "done", note: "ok" }] });
	ackPair(session.entries, "list-1", 1, 1);
	const result = gate.decide(boundary() as never, ctx as never) as {
		continue?: boolean;
		entries: Array<{ type: string; customType?: string; data?: { operation: string; state: ChecklistState } }>;
	};
	assertEq(result.continue, undefined);
	assertEq(result.entries[0].customType, "pi-checklist-state");
	assertEq(result.entries[0].data?.operation, "complete");
	assertEq(result.entries[0].data?.state.phase, "completed");
	assertEq(result.entries[0].data?.state.revision, 2);
});

test("another extension's continuation is not charged or duplicated", () => {
	const { session, gate, ctx } = setup();
	open(session);
	assertEq(gate.decide(boundary("completed", { continue: true }) as never, ctx as never), undefined);
});

test("three continuations per anchor exhaust the budget", () => {
	const { session, gate, ctx } = setup();
	open(session);
	for (let index = 1; index <= 3; index += 1) {
		session.add(settleEntry(`s${index}`, "u1", "list-1", 1, "continue"));
	}
	const result = gate.decide(boundary() as never, ctx as never) as {
		continue?: boolean;
		entries: Array<{ display?: boolean; content?: string; customType?: string }>;
	};
	assertEq(result.continue, undefined);
	assertEq(result.entries[1].display, true);
	assert(String(result.entries[1].content).includes("limit reached"));
});

test("two continuations for one revision exhaust it even under the anchor cap", () => {
	const { session, gate, ctx } = setup();
	open(session);
	session.add(settleEntry("s1", "u1", "list-1", 1, "continue"));
	session.add(settleEntry("s2", "u1", "list-1", 1, "continue"));
	const result = gate.decide(boundary() as never, ctx as never) as { continue?: boolean };
	assertEq(result.continue, undefined);
});

test("a new user anchor resets the continuation budget", () => {
	const { session, gate, ctx } = setup();
	open(session);
	for (let index = 1; index <= 3; index += 1) {
		session.add(settleEntry(`s${index}`, "u1", "list-1", 1, "continue"));
	}
	session.add(userEntry("u2"));
	const result = gate.decide(boundary() as never, ctx as never) as { continue?: boolean };
	assertEq(result.continue, true);
});

test("cannot-continue reports unresolved immediately", () => {
	const { session, gate, ctx } = setup();
	open(session);
	const result = gate.decide(boundary("completed", { canContinue: false }) as never, ctx as never) as {
		continue?: boolean;
		entries: Array<{ display?: boolean }>;
	};
	assertEq(result.continue, undefined);
	assertEq(result.entries[1].display, true);
});

test("a duplicate unresolved notice is not appended again", () => {
	const { session, gate, ctx } = setup();
	open(session);
	for (let index = 1; index <= 3; index += 1) {
		session.add(settleEntry(`s${index}`, "u1", "list-1", 1, "continue"));
	}
	const first = gate.decide(boundary() as never, ctx as never) as { entries: Array<{ details?: { reason: string } }> };
	const notice = first.entries[1] as { type: string; customType: string; content: string; display: boolean; details: unknown };
	session.add({
		type: "custom_message",
		id: "notice-1",
		customType: notice.customType,
		content: notice.content,
		display: notice.display,
		details: notice.details,
	});
	assertEq(gate.decide(boundary() as never, ctx as never), undefined);
});

test("a state fault is unresolved and visible", () => {
	const { session, gate, ctx } = setup();
	session.add({ type: "custom", id: "bad", customType: "pi-checklist-state", data: { schema: 99 } });
	const result = gate.decide(boundary() as never, ctx as never) as {
		continue?: boolean;
		entries: Array<{ display?: boolean; content?: string }>;
	};
	assertEq(result.continue, undefined);
	assertEq(result.entries[0].display, true);
	assert(String(result.entries[0].content).includes("unresolved"));
});

test("earlier boundary drafts are preserved", () => {
	const { session, gate, ctx } = setup();
	open(session);
	const draft = { type: "custom", customType: "other", data: { keep: true } };
	const result = gate.decide(boundary("completed", { entries: [draft] }) as never, ctx as never) as {
		entries: Array<{ customType?: string }>;
	};
	assertEq(result.entries[0].customType, "other");
	assertEq(result.entries.length, 3);
});
