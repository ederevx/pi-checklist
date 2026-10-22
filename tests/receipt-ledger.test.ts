import type { ChecklistDetails, ChecklistState } from "../src/checklist-contract.ts";
import { ReceiptLedger } from "../src/receipt-ledger.ts";
import {
	FakeContext,
	FakePi,
	FakeSession,
	ackPair,
	assert,
	assertEq,
	makeState,
	preEntry,
	stateEvent,
	test,
	userEntry,
} from "./harness.ts";

function setup(withPre = true): { session: FakeSession; ledger: ReceiptLedger; ctx: FakeContext } {
	const session = new FakeSession();
	if (withPre) session.add(preEntry("pre-1"));
	const pi = new FakePi(session);
	return { session, ledger: new ReceiptLedger(pi as never), ctx: new FakeContext(session) };
}

function create(ledger: ReceiptLedger, ctx: FakeContext, tasks = ["one", "two"]): ChecklistDetails {
	const result = ledger.transition({ kind: "create", title: "Work", tasks, actor: "model" }, ctx as never);
	return result.details;
}

test("create requires a pre_checklist receipt", () => {
	const { ledger, ctx } = setup(false);
	const details = create(ledger, ctx);
	assertEq(details.kind, "error");
	if (details.kind === "error") assertEq(details.code, "PRE_REQUIRED");
});

test("create builds revision 1 with the requested tasks", () => {
	const { ledger, ctx, session } = setup();
	const details = create(ledger, ctx);
	assertEq(details.kind, "mutation");
	const view = ledger.fromContext(ctx as never);
	assertEq(view.state?.revision, 1);
	assertEq(view.state?.tasks.length, 2);
	assertEq(view.state?.phase, "open");
	assertEq(session.entries.length, 2, "pre receipt plus one state entry");
});

test("a second create is refused while the list is open", () => {
	const { ledger, ctx } = setup();
	create(ledger, ctx);
	const details = create(ledger, ctx);
	if (details.kind === "error") assertEq(details.code, "ALREADY_OPEN");
	else throw new Error("expected a refusal");
});

test("create refuses zero or four tasks", () => {
	const { ledger, ctx } = setup();
	const empty = create(ledger, ctx, []);
	const four = create(ledger, ctx, ["a", "b", "c", "d"]);
	if (empty.kind !== "error" || four.kind !== "error") throw new Error("expected task-limit refusals");
	assertEq(empty.code, "TASK_LIMIT");
	assertEq(four.code, "TASK_LIMIT");
});

test("add appends one pending task and advances the revision", () => {
	const { ledger, ctx } = setup();
	create(ledger, ctx);
	const state = ledger.fromContext(ctx as never).state as ChecklistState;
	const result = ledger.transition(
		{ kind: "add", checklistId: state.checklistId, revision: state.revision, title: "third", actor: "model" },
		ctx as never,
	);
	assert(result.ok, "add should succeed");
	const next = ledger.fromContext(ctx as never).state as ChecklistState;
	assertEq(next.tasks.length, 3);
	assertEq(next.tasks[2].status, "pending");
	assertEq(next.revision, 2);
});

test("a fourth task is refused", () => {
	const { ledger, ctx } = setup();
	create(ledger, ctx, ["a", "b", "c"]);
	const state = ledger.fromContext(ctx as never).state as ChecklistState;
	const result = ledger.transition(
		{ kind: "add", checklistId: state.checklistId, revision: state.revision, title: "d", actor: "model" },
		ctx as never,
	);
	if (result.details.kind === "error") assertEq(result.details.code, "TASK_LIMIT");
	else throw new Error("expected refusal");
});

test("done requires a note; a noted completion advances the revision", () => {
	const { ledger, ctx } = setup();
	create(ledger, ctx);
	const state = ledger.fromContext(ctx as never).state as ChecklistState;
	const missing = ledger.transition(
		{
			kind: "update",
			checklistId: state.checklistId,
			revision: state.revision,
			taskId: state.tasks[0].taskId,
			status: "done",
			actor: "model",
		},
		ctx as never,
	);
	if (missing.details.kind === "error") assertEq(missing.details.code, "NOTE_REQUIRED");
	else throw new Error("expected note refusal");
	const ok = ledger.transition(
		{
			kind: "update",
			checklistId: state.checklistId,
			revision: state.revision,
			taskId: state.tasks[0].taskId,
			status: "done",
			note: "tests pass",
			actor: "model",
		},
		ctx as never,
	);
	assert(ok.ok, "noted completion should succeed");
	const next = ledger.fromContext(ctx as never).state as ChecklistState;
	assertEq(next.tasks[0].status, "done");
	assertEq(next.tasks[0].note, "tests pass");
	assertEq(next.revision, 2);
});

test("an unchanged update returns the current revision without a new event", () => {
	const { ledger, ctx, session } = setup();
	create(ledger, ctx);
	const state = ledger.fromContext(ctx as never).state as ChecklistState;
	const before = session.entries.length;
	const result = ledger.transition(
		{
			kind: "update",
			checklistId: state.checklistId,
			revision: state.revision,
			taskId: state.tasks[0].taskId,
			status: "pending",
			actor: "model",
		},
		ctx as never,
	);
	assert(result.ok, "no-op update should not fail");
	assertEq(session.entries.length, before);
	assertEq(result.state?.revision, 1);
});

test("stale revisions and unknown tasks are refused", () => {
	const { ledger, ctx } = setup();
	create(ledger, ctx);
	const state = ledger.fromContext(ctx as never).state as ChecklistState;
	const stale = ledger.transition(
		{ kind: "add", checklistId: state.checklistId, revision: 99, title: "x", actor: "model" },
		ctx as never,
	);
	if (stale.details.kind === "error") assertEq(stale.details.code, "STALE_REVISION");
	else throw new Error("expected stale refusal");
	const unknown = ledger.transition(
		{ kind: "update", checklistId: state.checklistId, revision: 1, taskId: "nope", status: "pending", actor: "model" },
		ctx as never,
	);
	if (unknown.details.kind === "error") assertEq(unknown.details.code, "UNKNOWN_TASK");
	else throw new Error("expected unknown-task refusal");
});

test("hold blocks model mutations until the user releases it", () => {
	const { ledger, ctx } = setup();
	create(ledger, ctx);
	const held = ledger.transition({ kind: "hold", reason: "user asked", actor: "user" }, ctx as never);
	assert(held.ok, "hold should succeed");
	let state = ledger.fromContext(ctx as never).state as ChecklistState;
	assertEq(state.phase, "held");
	const blocked = ledger.transition(
		{ kind: "add", checklistId: state.checklistId, revision: state.revision, title: "x", actor: "model" },
		ctx as never,
	);
	if (blocked.details.kind === "error") assertEq(blocked.details.code, "NOT_OPEN");
	else throw new Error("expected held refusal");
	ledger.transition({ kind: "release", actor: "user" }, ctx as never);
	state = ledger.fromContext(ctx as never).state as ChecklistState;
	assertEq(state.phase, "open");
	assertEq(state.holdReason, null);
});

test("user dismissal marks a task and the whole list", () => {
	const { ledger, ctx } = setup();
	create(ledger, ctx);
	let state = ledger.fromContext(ctx as never).state as ChecklistState;
	const task = ledger.transition(
		{ kind: "dismissTask", taskId: state.tasks[0].taskId, reason: "not needed", actor: "user" },
		ctx as never,
	);
	assert(task.ok, "task dismissal should succeed");
	state = ledger.fromContext(ctx as never).state as ChecklistState;
	assertEq(state.tasks[0].status, "dismissed");
	const list = ledger.transition({ kind: "dismissList", reason: "abandoned", actor: "user" }, ctx as never);
	assert(list.ok, "list dismissal should succeed");
	state = ledger.fromContext(ctx as never).state as ChecklistState;
	assertEq(state.phase, "dismissed");
});

test("a malformed canonical record is a visible fault, never an empty list", () => {
	const { session, ledger, ctx } = setup();
	session.add({ type: "custom", id: "bad", customType: "pi-checklist-state", data: { schema: 99 } });
	const view = ledger.fromContext(ctx as never);
	assert(view.fault !== null, "expected a fault");
	const result = ledger.transition(
		{ kind: "create", title: "Work", tasks: ["one"], actor: "model" },
		ctx as never,
	);
	if (result.details.kind === "error") assertEq(result.details.code, "STATE_FAULT");
	else throw new Error("expected state-fault refusal");
});

test("an event that does not advance its previous revision is a fault", () => {
	const session = new FakeSession();
	session.add(preEntry("pre-1"));
	session.add(stateEvent("e1", "create", null, makeState()));
	session.add(stateEvent("e2", "add", makeState(), makeState({ revision: 3 })));
	const ledger = new ReceiptLedger(new FakePi(session) as never);
	const view = ledger.fromContext(new FakeContext(session) as never);
	assert(view.fault !== null, "expected revision fault");
});

test("branch state does not leak across /tree branches", () => {
	const session = new FakeSession();
	const base = [preEntry("pre-1"), stateEvent("e1", "create", null, makeState())];
	const branchA = [...base, stateEvent("a2", "add", makeState(), makeState({
		revision: 2,
		tasks: [...makeState().tasks, { taskId: "task-3", title: "third", status: "pending", note: null }],
	}))];
	const branchB = [...base];
	session.setBranch(branchA, [...base]);
	const ledger = new ReceiptLedger(new FakePi(session) as never);
	const viewA = ledger.fromContext(new FakeContext(session) as never);
	session.setBranch(branchB, [...base]);
	const viewB = ledger.fromContext(new FakeContext(session) as never);
	assertEq(viewA.state?.tasks.length, 3);
	assertEq(viewB.state?.tasks.length, 2);
});

test("a completion draft is only offered with a valid acknowledgement", () => {
	const session = new FakeSession();
	session.add(preEntry("pre-1"));
	session.add(stateEvent("e1", "create", null, makeState({
		revision: 2,
		tasks: [
			{ taskId: "task-1", title: "first", status: "done", note: "ok" },
			{ taskId: "task-2", title: "second", status: "dismissed", note: "user" },
		],
	})));
	const ledger = new ReceiptLedger(new FakePi(session) as never);
	const view = ledger.fromContext(new FakeContext(session) as never);
	assertEq(ledger.completionDraft(view), undefined, "no acknowledgement, no completion");
});

test("a completed list can be replaced by a fresh checklist", () => {
	const { ledger, ctx, session } = setup();
	create(ledger, ctx, ["one"]);
	let state = ledger.fromContext(ctx as never).state as ChecklistState;
	ledger.transition(
		{ kind: "update", checklistId: state.checklistId, revision: state.revision, taskId: state.tasks[0].taskId, status: "done", note: "ok", actor: "model" },
		ctx as never,
	);
	state = ledger.fromContext(ctx as never).state as ChecklistState;
	ackPair(session.entries, state.checklistId, state.revision, 1);
	const view = ledger.fromContext(ctx as never);
	const completion = ledger.completionDraft(view);
	assert(completion !== undefined, "expected a completion draft");
	session.add({ type: "custom", id: "complete-1", customType: "pi-checklist-state", data: (completion.draft as { data: unknown }).data });
	session.add(preEntry("pre-2"));
	const second = create(ledger, ctx, ["next"]);
	assert(second.kind === "mutation", "a completed predecessor should allow a new list");
	const after = ledger.fromContext(ctx as never);
	assertEq(after.fault, null);
	assertEq(after.state?.phase, "open");
	assertEq(after.state?.revision, 1);
});

test("a dismissed list can be replaced by a fresh checklist", () => {
	const { ledger, ctx, session } = setup();
	create(ledger, ctx, ["one"]);
	ledger.transition({ kind: "dismissList", reason: "abandoned", actor: "user" }, ctx as never);
	session.add(preEntry("pre-2"));
	const second = create(ledger, ctx, ["next"]);
	assert(second.kind === "mutation", "a dismissed predecessor should allow a new list");
	assertEq(ledger.fromContext(ctx as never).fault, null);
});

test("sequential task dismissals keep reconstructing cleanly", () => {
	const { ledger, ctx } = setup();
	create(ledger, ctx, ["a", "b", "c"]);
	let state = ledger.fromContext(ctx as never).state as ChecklistState;
	ledger.transition({ kind: "dismissTask", taskId: state.tasks[0].taskId, reason: "one", actor: "user" }, ctx as never);
	state = ledger.fromContext(ctx as never).state as ChecklistState;
	assertEq(state.tasks[0].status, "dismissed");
	ledger.transition({ kind: "dismissTask", taskId: state.tasks[1].taskId, reason: "two", actor: "user" }, ctx as never);
	const after = ledger.fromContext(ctx as never);
	assertEq(after.fault, null);
	assertEq(after.state?.tasks[1].status, "dismissed");
	assertEq(after.state?.tasks[0].status, "dismissed");
});

test("a sibling branch's pre receipt cannot start this branch's list", () => {
	const session = new FakeSession();
	const branchA = [userEntry("a1")];
	const branchB = [preEntry("pre-b"), stateEvent("b1", "create", null, makeState({ checklistId: "list-b" }), { preReceiptId: "pre-pre-b" })];
	session.setBranch(branchA, [...branchA, ...branchB]);
	const ledger = new ReceiptLedger(new FakePi(session) as never);
	const ctx = new FakeContext(session);
	assertEq(ledger.fromContext(ctx as never).acknowledged, true);
	const refused = ledger.transition({ kind: "create", title: "Work", tasks: ["one"], actor: "model" }, ctx as never);
	if (refused.details.kind === "error") assertEq(refused.details.code, "PRE_REQUIRED");
	else throw new Error("expected a branch-local pre refusal");
	session.add(preEntry("pre-a2"));
	const created = ledger.transition({ kind: "create", title: "Work", tasks: ["one"], actor: "model" }, ctx as never);
	assert(created.ok, "a branch-local receipt should permit creation");
});

test("blank task titles are refused instead of dropped", () => {
	const { ledger, ctx } = setup();
	const details = create(ledger, ctx, ["one", "   "]);
	if (details.kind === "error") assertEq(details.code, "TITLE_REQUIRED");
	else throw new Error("expected a blank-title refusal");
});

test("a create replayed after its pre receipt is valid, but a later receipt is not", () => {
	const session = new FakeSession();
	session.add(userEntry("u1"));
	session.add(stateEvent("e1", "create", null, makeState()));
	session.add(preEntry("pre-1"));
	const ledger = new ReceiptLedger(new FakePi(session) as never);
	assert(ledger.fromContext(new FakeContext(session) as never).fault !== null, "a later pre receipt is invalid");
});

test("a create that reuses a consumed receipt is invalid", () => {
	const session = new FakeSession();
	session.add(userEntry("u1"), preEntry("pre-1"));
	session.add(stateEvent("e1", "create", null, makeState()));
	session.add(stateEvent("e2", "dismiss_list", makeState(), makeState({ revision: 2, phase: "dismissed", holdReason: "gone" })));
	session.add(stateEvent("e3", "create", null, makeState({ checklistId: "list-2", title: "Next" })));
	const ledger = new ReceiptLedger(new FakePi(session) as never);
	const view = ledger.fromContext(new FakeContext(session) as never);
	assert(view.fault !== null, "a consumed receipt must not be replayed");
	assert(String(view.fault).includes("consumed"));
});

test("a create with terminal or annotated initial tasks is invalid", () => {
	const session = new FakeSession();
	session.add(userEntry("u1"), preEntry("pre-1"));
	session.add(stateEvent("e1", "create", null, makeState({
		tasks: [{ taskId: "t1", title: "one", status: "done", note: "already" }],
	})));
	const ledger = new ReceiptLedger(new FakePi(session) as never);
	const view = ledger.fromContext(new FakeContext(session) as never);
	assert(view.fault !== null, "a create cannot start with done tasks");
});

test("a create with a hold reason is invalid", () => {
	const session = new FakeSession();
	session.add(userEntry("u1"), preEntry("pre-1"));
	session.add(stateEvent("e1", "create", null, makeState({ holdReason: "why" })));
	const ledger = new ReceiptLedger(new FakePi(session) as never);
	assert(ledger.fromContext(new FakeContext(session) as never).fault !== null, "a create cannot start held");
});
