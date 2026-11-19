import type { BranchEntry, ChecklistDetails, ChecklistState } from "../src/checklist-contract.ts";
import { ReceiptLedger } from "../src/receipt-ledger.ts";
import {
	FakeContext,
	FakePi,
	FakeSession,
	ackPair,
	assert,
	assertEq,
	assertIncludes,
	makeState,
	preEntry,
	stateEvent,
	test,
	userEntry,
} from "./harness.ts";

function setup(withPre = true): { session: FakeSession; ledger: ReceiptLedger; ctx: FakeContext } {
	const session = new FakeSession();
	session.add(userEntry("user-1"));
	if (withPre) session.add(preEntry("pre-1"));
	const pi = new FakePi(session);
	return { session, ledger: new ReceiptLedger(pi as never), ctx: new FakeContext(session) };
}

function create(
	ledger: ReceiptLedger,
	ctx: FakeContext,
	tasks = ["one", "two"],
	anchorId = "user-1",
): ChecklistDetails {
	const result = ledger.transition({ kind: "create", title: "Work", tasks, anchorId, actor: "model" }, ctx as never);
	return result.details;
}

test("create is refused without a receipt, an open list, room for a task, or a title", () => {
	const rows: Array<[string, () => ChecklistDetails, string]> = [
		[
			"no pre_checklist receipt",
			() => {
				const { ledger, ctx } = setup(false);
				return create(ledger, ctx);
			},
			"PRE_REQUIRED",
		],
		[
			"a second list while one is open",
			() => {
				const { ledger, ctx } = setup();
				create(ledger, ctx);
				return create(ledger, ctx);
			},
			"ALREADY_OPEN",
		],
		[
			"zero tasks",
			() => {
				const { ledger, ctx } = setup();
				return create(ledger, ctx, []);
			},
			"TASK_LIMIT",
		],
		[
			"eleven tasks",
			() => {
				const { ledger, ctx } = setup();
				return create(ledger, ctx, ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"]);
			},
			"TASK_LIMIT",
		],
		[
			"a blank title",
			() => {
				const { ledger, ctx } = setup();
				return create(ledger, ctx, ["one", "   "]);
			},
			"TITLE_REQUIRED",
		],
	];
	for (const [label, run, code] of rows) {
		const details = run();
		assertEq(details.kind, "error", label);
		if (details.kind === "error") assertEq(details.code, code, label);
	}
});

test("create builds revision 1 with the requested tasks", () => {
	const { ledger, ctx, session } = setup();
	const details = create(ledger, ctx);
	assertEq(details.kind, "mutation");
	const view = ledger.fromContext(ctx as never);
	assertEq(view.state?.revision, 1);
	assertEq(view.state?.tasks.length, 2);
	assertEq(view.state?.phase, "open");
	assertEq(session.entries.length, 3, "user prompt, pre receipt, and one state entry");
});

test("add appends one pending task and advances the revision", () => {
	const { ledger, ctx, session } = setup();
	create(ledger, ctx);
	const state = ledger.fromContext(ctx as never).state as ChecklistState;
	session.add(userEntry("u2", "one more"));
	const result = ledger.transition(
		{ kind: "add", checklistId: state.checklistId, revision: state.revision, title: "third", anchorId: "u2", actor: "model" },
		ctx as never,
	);
	assert(result.ok, "add should succeed");
	const next = ledger.fromContext(ctx as never).state as ChecklistState;
	assertEq(next.tasks.length, 3);
	assertEq(next.tasks[2].status, "pending");
	assertEq(next.revision, 2);
});

test("an eleventh task is refused", () => {
	const { ledger, ctx } = setup();
	const titles = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
	create(ledger, ctx, titles);
	const state = ledger.fromContext(ctx as never).state as ChecklistState;
	const result = ledger.transition(
		{ kind: "add", checklistId: state.checklistId, revision: state.revision, title: "k", anchorId: "user-1", actor: "model" },
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
		{ kind: "add", checklistId: state.checklistId, revision: 99, title: "x", anchorId: "user-1", actor: "model" },
		ctx as never,
	);
	if (stale.details.kind === "error") {
		assertEq(stale.details.code, "STALE_REVISION");
		assertIncludes(stale.details.message, "is at revision 1, not 99");
	} else throw new Error("expected stale refusal");
	const unknown = ledger.transition(
		{ kind: "update", checklistId: state.checklistId, revision: 1, taskId: "nope", status: "pending", actor: "model" },
		ctx as never,
	);
	if (unknown.details.kind === "error") assertEq(unknown.details.code, "UNKNOWN_TASK");
	else throw new Error("expected unknown-task refusal");
});

test("a mismatched checklist id names both ids", () => {
	const { ledger, ctx, session } = setup();
	create(ledger, ctx);
	const state = ledger.fromContext(ctx as never).state as ChecklistState;
	const before = session.entries.length;
	const received = `"${state.checklistId}"`;
	const result = ledger.transition(
		{
			kind: "update",
			checklistId: received,
			revision: state.revision,
			taskId: state.tasks[0].taskId,
			status: "in_progress",
			actor: "model",
		},
		ctx as never,
	);
	if (result.details.kind !== "error") throw new Error("expected unknown-checklist refusal");
	assertEq(result.details.code, "UNKNOWN_CHECKLIST");
	assertIncludes(result.details.message, JSON.stringify(received));
	assertIncludes(result.details.message, `${JSON.stringify(state.checklistId)} revision ${state.revision}`);
	assertEq(session.entries.length, before);
});

test("hold blocks model mutations until the user releases it", () => {
	const { ledger, ctx } = setup();
	create(ledger, ctx);
	const held = ledger.transition({ kind: "hold", reason: "user asked", actor: "user" }, ctx as never);
	assert(held.ok, "hold should succeed");
	let state = ledger.fromContext(ctx as never).state as ChecklistState;
	assertEq(state.phase, "held");
	const blocked = ledger.transition(
		{ kind: "add", checklistId: state.checklistId, revision: state.revision, title: "x", anchorId: "user-1", actor: "model" },
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
		{ kind: "create", title: "Work", tasks: ["one"], anchorId: "user-1", actor: "model" },
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

test("a completed or dismissed list is replaced by a fresh checklist", () => {
	const rows: Array<[string, (branch: ReturnType<typeof setup>) => void]> = [
		[
			"completed",
			(branch) => {
				create(branch.ledger, branch.ctx, ["one"]);
				let state = branch.ledger.fromContext(branch.ctx as never).state as ChecklistState;
				branch.ledger.transition(
					{ kind: "update", checklistId: state.checklistId, revision: state.revision, taskId: state.tasks[0].taskId, status: "done", note: "ok", actor: "model" },
					branch.ctx as never,
				);
				state = branch.ledger.fromContext(branch.ctx as never).state as ChecklistState;
				ackPair(branch.session.entries, state.checklistId, state.revision, 1);
				const completion = branch.ledger.completionDraft(branch.ledger.fromContext(branch.ctx as never));
				assert(completion !== undefined, "completed: expected a completion draft");
				branch.session.add({ type: "custom", id: "complete-1", customType: "pi-checklist-state", data: (completion.draft as { data: unknown }).data });
			},
		],
		[
			"dismissed",
			(branch) => {
				create(branch.ledger, branch.ctx, ["one"]);
				branch.ledger.transition({ kind: "dismissList", reason: "abandoned", actor: "user" }, branch.ctx as never);
			},
		],
	];
	for (const [label, finish] of rows) {
		const branch = setup();
		finish(branch);
		branch.session.add(preEntry("pre-2"));
		branch.session.add(userEntry("u2", "start the next list"));
		const next = create(branch.ledger, branch.ctx, ["next"], "u2");
		assert(next.kind === "mutation", `${label}: the predecessor should allow a new list`);
		const after = branch.ledger.fromContext(branch.ctx as never);
		assertEq(after.fault, null, `${label}: the replacement replays cleanly`);
		assertEq(after.state?.phase, "open", `${label}: the new list is open`);
		assertEq(after.state?.revision, 1, `${label}: the new list starts at revision 1`);
	}
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
	const refused = ledger.transition({ kind: "create", title: "Work", tasks: ["one"], anchorId: "a1", actor: "model" }, ctx as never);
	if (refused.details.kind === "error") assertEq(refused.details.code, "PRE_REQUIRED");
	else throw new Error("expected a branch-local pre refusal");
	session.add(preEntry("pre-a2"));
	const created = ledger.transition({ kind: "create", title: "Work", tasks: ["one"], anchorId: "a1", actor: "model" }, ctx as never);
	assert(created.ok, "a branch-local receipt should permit creation");
});

test("a create replayed after its pre receipt is valid, but a later receipt is not", () => {
	const session = new FakeSession();
	session.add(userEntry("u1"));
	session.add(stateEvent("e1", "create", null, makeState()));
	session.add(preEntry("pre-1"));
	const ledger = new ReceiptLedger(new FakePi(session) as never);
	assert(ledger.fromContext(new FakeContext(session) as never).fault !== null, "a later pre receipt is invalid");
});

test("a replayed create that reuses a receipt or starts terminal or held is a fault", () => {
	const rows: Array<[string, BranchEntry[], string]> = [
		[
			"a consumed receipt",
			[
				stateEvent("e1", "create", null, makeState()),
				stateEvent("e2", "dismiss_list", makeState(), makeState({ revision: 2, phase: "dismissed", holdReason: "gone" }), { reason: "gone" }),
				stateEvent("e3", "create", null, makeState({ checklistId: "list-2", title: "Next" })),
			],
			"consumed",
		],
		[
			"terminal initial tasks",
			[
				stateEvent("e1", "create", null, makeState({
					tasks: [{ taskId: "t1", title: "one", status: "done", note: "already" }],
				})),
			],
			"terminal or annotated",
		],
		[
			"a hold reason",
			[stateEvent("e1", "create", null, makeState({ holdReason: "why" }))],
			"a new list starts with a hold reason",
		],
	];
	for (const [label, entries, message] of rows) {
		const session = new FakeSession();
		session.add(userEntry("u1"), preEntry("pre-1"));
		for (const entry of entries) session.add(entry);
		const view = new ReceiptLedger(new FakePi(session) as never).fromContext(new FakeContext(session) as never);
		assert(view.fault !== null, label);
		assertIncludes(String(view.fault), message, label);
	}
});

/** Read the branch's current list, or fail loudly. */
function current(ledger: ReceiptLedger, ctx: FakeContext): ChecklistState {
	const view = ledger.fromContext(ctx as never);
	assert(view.fault === null, `unexpected fault: ${view.fault}`);
	assert(view.state !== null, "expected a list");
	return view.state;
}

/** A later user message, the anchor a model dismissal must name. */
function laterTurn(session: FakeSession, id: string): string {
	session.add(userEntry(id, "priorities changed: do the other thing"));
	return id;
}

test("a model dismissal names the user message that changed priorities", () => {
	const { ledger, ctx, session } = setup();
	create(ledger, ctx);
	const state = current(ledger, ctx);
	const anchorId = laterTurn(session, "u2");
	const result = ledger.transition(
		{
			kind: "dismissTask",
			checklistId: state.checklistId,
			revision: state.revision,
			taskId: state.tasks[0].taskId,
			reason: "no longer wanted",
			anchorId,
			actor: "model",
		},
		ctx as never,
	);
	assert(result.ok, "a cited later turn should allow the dismissal");
	const after = current(ledger, ctx);
	assertEq(after.tasks[0].status, "dismissed");
	assertEq(after.tasks[0].note, "no longer wanted");
	assertEq(after.phase, "open");
	assertEq(after.revision, 2);
	const event = ledger.fromContext(ctx as never).events.at(-1);
	assertEq(event?.actor, "model");
	assertEq(event?.anchorId, anchorId);
});

test("a model dismissal needs a reason and a resolvable anchor", () => {
	const { ledger, ctx, session } = setup();
	create(ledger, ctx);
	const state = current(ledger, ctx);
	const anchorId = laterTurn(session, "u2");
	const command = (overrides: Record<string, unknown>) =>
		ledger.transition(
			{
				kind: "dismissTask",
				checklistId: state.checklistId,
				revision: state.revision,
				taskId: state.tasks[0].taskId,
				reason: "changed",
				anchorId,
				actor: "model",
				...overrides,
			} as never,
			ctx as never,
		);
	const missingReason = command({ reason: "  " });
	if (missingReason.details.kind === "error") assertEq(missingReason.details.code, "REASON_REQUIRED");
	else throw new Error("expected a reason refusal");
	const missingAnchor = command({ anchorId: "nope" });
	if (missingAnchor.details.kind === "error") assertEq(missingAnchor.details.code, "ANCHOR_INVALID");
	else throw new Error("expected an anchor refusal");
	const blankAnchor = command({ anchorId: "" });
	if (blankAnchor.details.kind === "error") assertEq(blankAnchor.details.code, "ANCHOR_REQUIRED");
	else throw new Error("expected a missing-anchor refusal");
	const notUser = command({ anchorId: "pre-1" });
	if (notUser.details.kind === "error") assertEq(notUser.details.code, "ANCHOR_INVALID");
	else throw new Error("expected a non-user anchor refusal");
});

test("an anchor before the current revision or older than a change is refused", () => {
	const { ledger, ctx, session } = setup();
	session.add(userEntry("u0"));
	create(ledger, ctx, ["one", "two"], "u0");
	const state = current(ledger, ctx);
	const dismiss = (anchorId: string, revision: number) =>
		ledger.transition(
			{
				kind: "dismissTask",
				checklistId: state.checklistId,
				revision,
				taskId: state.tasks[0].taskId,
				reason: "changed",
				anchorId,
				actor: "model",
			},
			ctx as never,
		);
	const older = dismiss("u0", state.revision);
	if (older.details.kind === "error") assertEq(older.details.code, "ANCHOR_INVALID");
	else throw new Error("expected an out-of-order anchor refusal");
	const anchorId = laterTurn(session, "u2");
	ledger.transition(
		{
			kind: "update",
			checklistId: state.checklistId,
			revision: state.revision,
			taskId: state.tasks[1].taskId,
			status: "in_progress",
			actor: "model",
		},
		ctx as never,
	);
	const consumed = dismiss(anchorId, state.revision + 1);
	if (consumed.details.kind === "error") assertEq(consumed.details.code, "ANCHOR_INVALID");
	else throw new Error("a mutation after the anchor must consume the opportunity");
});

test("a model dismissal of a held list keeps the user's hold", () => {
	const { ledger, ctx, session } = setup();
	create(ledger, ctx);
	ledger.transition({ kind: "hold", reason: "user asked", actor: "user" }, ctx as never);
	const held = current(ledger, ctx);
	const anchorId = laterTurn(session, "u2");
	const result = ledger.transition(
		{
			kind: "dismissTask",
			checklistId: held.checklistId,
			revision: held.revision,
			taskId: held.tasks[0].taskId,
			reason: "obsolete",
			anchorId,
			actor: "model",
		},
		ctx as never,
	);
	assert(result.ok, "a held task may be dismissed under the anchor rule");
	const after = current(ledger, ctx);
	assertEq(after.phase, "held");
	assertEq(after.holdReason, "user asked");
	assertEq(after.tasks[0].status, "dismissed");
});

test("a model list dismissal records its reason and closes the list", () => {
	const { ledger, ctx, session } = setup();
	create(ledger, ctx);
	const state = current(ledger, ctx);
	const anchorId = laterTurn(session, "u2");
	const result = ledger.transition(
		{
			kind: "dismissList",
			checklistId: state.checklistId,
			revision: state.revision,
			reason: "superseded by the new request",
			anchorId,
			actor: "model",
		},
		ctx as never,
	);
	assert(result.ok, "a cited list dismissal should succeed");
	const after = current(ledger, ctx);
	assertEq(after.phase, "dismissed");
	assertEq(after.holdReason, "superseded by the new request");
});

test("a model replacement starts a new list and keeps the displaced one readable", () => {
	const { ledger, ctx, session } = setup();
	create(ledger, ctx);
	const displaced = current(ledger, ctx);
	const anchorId = laterTurn(session, "u2");
	session.add(preEntry("pre-2"));
	const result = ledger.transition(
		{
			kind: "replace",
			checklistId: displaced.checklistId,
			revision: displaced.revision,
			title: "Next",
			tasks: ["read", "write"],
			reason: "priorities changed",
			anchorId,
			actor: "model",
		},
		ctx as never,
	);
	assert(result.ok, "a cited replacement with a fresh receipt should succeed");
	const view = ledger.fromContext(ctx as never);
	assertEq(view.fault, null);
	const state = view.state as ChecklistState;
	assertEq(state.phase, "open");
	assertEq(state.revision, 1);
	assertEq(state.title, "Next");
	assert(state.checklistId !== displaced.checklistId, "the replacement needs a new identity");
	const event = view.events.at(-1);
	assertEq(event?.operation, "replace");
	assertEq(event?.replacedChecklist?.checklistId, displaced.checklistId);
	assertEq(event?.replacedChecklist?.revision, displaced.revision);
});

test("a replacement is refused for a superseded or consumed prompt, or without a fresh receipt", () => {
	const rows: Array<[string, (session: FakeSession) => string, string]> = [
		[
			"a superseded prompt",
			(session) => {
				laterTurn(session, "u2");
				laterTurn(session, "u3");
				session.add(preEntry("pre-2"));
				return "u2";
			},
			"ANCHOR_STALE",
		],
		[
			"a prompt the checklist already consumed",
			(session) => {
				session.add(preEntry("pre-2"));
				return "user-1";
			},
			"NEW_USER_PROMPT_REQUIRED",
		],
		["a missing pre_checklist receipt", (session) => laterTurn(session, "u2"), "PRE_REQUIRED"],
	];
	for (const [label, prepare, code] of rows) {
		const { ledger, ctx, session } = setup();
		create(ledger, ctx);
		const state = current(ledger, ctx);
		const anchorId = prepare(session);
		const before = ledger.fromContext(ctx as never).events.length;
		const result = ledger.transition(
			{
				kind: "replace",
				checklistId: state.checklistId,
				revision: state.revision,
				title: "Next",
				tasks: ["read"],
				reason: "priorities changed",
				anchorId,
				actor: "model",
			},
			ctx as never,
		);
		if (result.details.kind !== "error") throw new Error(`${label}: expected a refusal`);
		assertEq(result.details.code, code, label);
		const view = ledger.fromContext(ctx as never);
		assertEq(view.fault, null, `${label}: a refusal cannot write a state replay rejects`);
		assertEq(view.events.length, before, `${label}: a refusal appends no event`);
		assertEq(view.state?.checklistId, state.checklistId, `${label}: the refused replacement leaves the list in place`);
	}
});

test("a model release is not permitted", () => {
	const session = new FakeSession();
	session.add(preEntry("pre-1"));
	session.add(stateEvent("e1", "create", null, makeState()));
	session.add(stateEvent("e2", "hold", makeState(), makeState({ revision: 2, phase: "held", holdReason: "user" })));
	session.add(stateEvent("e3", "release", makeState({ revision: 2, phase: "held", holdReason: "user" }), makeState({ revision: 3 }), { actor: "model" }));
	const ledger = new ReceiptLedger(new FakePi(session) as never);
	const view = ledger.fromContext(new FakeContext(session) as never);
	assert(view.fault !== null, "only the user may release a hold");
});

/** Replay a branch whose trailing transitions are the ones handed in, and report its fault. */
function faultOf(...transitions: Array<BranchEntry | ((previous: ChecklistState) => BranchEntry)>): string | null {
	const session = new FakeSession();
	const first = makeState();
	session.add(userEntry("u1"), preEntry("pre-1"));
	session.add(stateEvent("e1", "create", null, first));
	session.add(userEntry("u2"));
	session.add(preEntry("pre-2"));
	for (const transition of transitions) session.add(typeof transition === "function" ? transition(first) : transition);
	const ledger = new ReceiptLedger(new FakePi(session) as never);
	return ledger.fromContext(new FakeContext(session) as never).fault;
}

/** A replacement event that replays cleanly until the case under test spoils it. */
function replacement(extra: Record<string, unknown> = {}) {
	return (first: ChecklistState): BranchEntry =>
		stateEvent("e2", "replace", first, makeState({ checklistId: "list-2" }), {
			anchorId: "u2",
			reason: "changed",
			preReceiptId: "pre-pre-2",
			replacedChecklist: {
				checklistId: first.checklistId,
				revision: first.revision,
				title: first.title,
				phase: "open",
				holdReason: null,
			},
			...extra,
		});
}

test("a replacement record that starts terminal, reuses an identity, or replays its receipt is a fault", () => {
	const rows: Array<[string, () => string | null, string]> = [
		[
			"starting with a finished task",
			() => faultOf((previous) => stateEvent("e2", "replace", previous, makeState({
				checklistId: "list-2",
				title: "Next",
				tasks: [{ taskId: "t9", title: "one", status: "done", note: "already" }],
			}), {
				anchorId: "u2",
				reason: "changed",
				preReceiptId: "pre-pre-2",
				replacedChecklist: { checklistId: "list-1", revision: 1, title: "Work", phase: "open", holdReason: null },
			})),
			"terminal or annotated",
		],
		[
			"reusing the displaced identity",
			() => faultOf((previous) => stateEvent("e2", "replace", previous, makeState({ title: "Next" }), {
				anchorId: "u2",
				reason: "changed",
				preReceiptId: "pre-pre-2",
				replacedChecklist: { checklistId: "list-1", revision: 1, title: "Work", phase: "open", holdReason: null },
			})),
			"identity",
		],
		[
			"carrying a completion acknowledgement",
			() => faultOf(replacement({ ackReceiptEntryId: "ack-1" })),
			"completion acknowledgement",
		],
		[
			"describing a malformed displaced list",
			() => faultOf(replacement({ replacedChecklist: { checklistId: "list-1", revision: 1, title: "Work", phase: "open", holdReason: 5 } })),
			"does not describe",
		],
		[
			"reusing an earlier checklist identity",
			() => {
				const session = new FakeSession();
				const first = makeState();
				session.add(userEntry("u1"), preEntry("pre-1"));
				session.add(stateEvent("e1", "create", null, first));
				session.add(stateEvent("e2", "dismiss_list", first, makeState({ revision: 2, phase: "dismissed", holdReason: "gone" }), { reason: "gone" }));
				session.add(preEntry("pre-2"));
				session.add(stateEvent("e3", "create", null, makeState({ checklistId: "list-2", title: "Second" }), { preReceiptId: "pre-pre-2" }));
				session.add(userEntry("u2"), preEntry("pre-3"));
				session.add(stateEvent("e4", "replace", makeState({ checklistId: "list-2", title: "Second" }), makeState({ checklistId: "list-1", title: "Third" }), {
					anchorId: "u2",
					reason: "changed",
					preReceiptId: "pre-pre-3",
					replacedChecklist: { checklistId: "list-2", revision: 1, title: "Second", phase: "open", holdReason: null },
				}));
				return new ReceiptLedger(new FakePi(session) as never).fromContext(new FakeContext(session) as never).fault;
			},
			"reused a checklist identity",
		],
		[
			"replaying its receipt in a second replacement",
			() => faultOf(
				replacement(),
				userEntry("u3"),
				stateEvent("e3", "replace", makeState({ checklistId: "list-2" }), makeState({ checklistId: "list-3" }), {
					anchorId: "u3",
					reason: "changed again",
					preReceiptId: "pre-pre-2",
					replacedChecklist: { checklistId: "list-2", revision: 1, title: "Work", phase: "open", holdReason: null },
				}),
			),
			"consumed receipt",
		],
	];
	for (const [label, fault, message] of rows) assertIncludes(String(fault()), message, label);
});

test("a dismissal record carries its reason, its phase, and no foreign metadata", () => {
	const rows: Array<[string, () => string | null, string]> = [
		[
			"a list dismissal whose state names another reason",
			() => faultOf((first) =>
				stateEvent("e2", "dismiss_list", first, makeState({ revision: 2, phase: "dismissed", holdReason: "other" }), {
					reason: "gone",
				}),
			),
			"does not carry its reason",
		],
		[
			"a dismissal carrying a receipt it does not own",
			() => faultOf((first) =>
				stateEvent("e2", "dismiss_list", first, makeState({ revision: 2, phase: "dismissed", holdReason: "gone" }), {
					reason: "gone",
					preReceiptId: "pre-pre-2",
				}),
			),
			"metadata it does not own",
		],
		[
			"a task dismissal that changes the phase",
			() => faultOf((first) =>
				stateEvent(
					"e2",
					"dismiss_task",
					first,
					makeState({
						revision: 2,
						phase: "held",
						tasks: [{ taskId: "task-1", title: "first", status: "dismissed", note: "obsolete" }, first.tasks[1]],
					}),
					{ reason: "obsolete" },
				),
			),
			"changed the phase",
		],
		[
			"a task dismissal whose note is not its reason",
			() => faultOf((first) =>
				stateEvent(
					"e2",
					"dismiss_task",
					first,
					makeState({
						revision: 2,
						tasks: [{ taskId: "task-1", title: "first", status: "dismissed", note: "something else" }, first.tasks[1]],
					}),
					{ reason: "obsolete" },
				),
			),
			"does not carry its reason",
		],
	];
	for (const [label, fault, message] of rows) assertIncludes(String(fault()), message, label);
});

test("a replayed update or add cannot dismiss a task, hold the list, or reopen it", () => {
	const held = makeState({ revision: 2, phase: "held", holdReason: "user asked" });
	const rows: Array<[string, () => string | null, string]> = [
		[
			"an update that dismisses a task",
			() => faultOf((first) =>
				stateEvent("e2", "update", first, makeState({
					revision: 2,
					tasks: [{ taskId: "task-1", title: "first", status: "dismissed", note: "forged" }, first.tasks[1]],
				})),
			),
			"update dismissed a task",
		],
		[
			"an update that holds the list",
			() => faultOf((first) => stateEvent("e2", "update", first, makeState({ revision: 2, phase: "held", holdReason: "forged" }))),
			"requires an open checklist",
		],
		[
			"an update that reopens a held list",
			() => faultOf(
				(first) => stateEvent("e2", "hold", first, held, { reason: "user asked" }),
				() => stateEvent("e3", "update", held, makeState({ revision: 3 }), { preReceiptId: "pre-pre-2" }),
			),
			"requires an open checklist",
		],
		[
			"an add that holds the list",
			() => faultOf((first) =>
				stateEvent("e2", "add", first, makeState({
					revision: 2,
					phase: "held",
					holdReason: "forged",
					tasks: [...first.tasks, { taskId: "task-3", title: "third", status: "pending", note: null }],
				})),
			),
			"requires an open checklist",
		],
	];
	for (const [label, fault, message] of rows) assertIncludes(String(fault()), message, label);
});

test("a replacement replay names a user anchor on this branch that precedes it", () => {
	const rows: Array<[string, () => string | null, string]> = [
		["a non-user anchor", () => faultOf(replacement({ anchorId: "pre-1" })), "does not name a user message"],
		[
			"an anchor from a sibling branch",
			() => {
				const first = makeState();
				const shared = [
					userEntry("u1"),
					preEntry("pre-1"),
					stateEvent("e1", "create", null, first),
					preEntry("pre-2"),
				];
				const branch = [
					...shared,
					stateEvent("e2", "replace", first, makeState({ checklistId: "list-2" }), {
						anchorId: "u2",
						reason: "changed",
						preReceiptId: "pre-pre-2",
						replacedChecklist: { checklistId: "list-1", revision: 1, title: "Work", phase: "open", holdReason: null },
					}),
				];
				const session = new FakeSession();
				session.setBranch(branch, [...shared, userEntry("u2", "from a sibling branch")]);
				return new ReceiptLedger(new FakePi(session) as never).fromContext(new FakeContext(session) as never).fault;
			},
			"names no entry on this branch",
		],
		[
			"an anchor later than the replacement",
			() => faultOf(replacement({ anchorId: "u3" }), userEntry("u3")),
			"does not precede",
		],
	];
	for (const [label, fault, message] of rows) assertIncludes(String(fault()), message, label);
});

test("a model replacement of a held list records the hold it displaced", () => {
	const { ledger, ctx, session } = setup();
	create(ledger, ctx);
	ledger.transition({ kind: "hold", reason: "user asked", actor: "user" }, ctx as never);
	const held = current(ledger, ctx);
	const anchorId = laterTurn(session, "u2");
	session.add(preEntry("pre-2"));
	const result = ledger.transition(
		{
			kind: "replace",
			checklistId: held.checklistId,
			revision: held.revision,
			title: "Next",
			tasks: ["read"],
			reason: "priorities changed",
			anchorId,
			actor: "model",
		},
		ctx as never,
	);
	assert(result.ok, "a cited replacement of a held list should succeed");
	const view = ledger.fromContext(ctx as never);
	assertEq(view.fault, null);
	const state = view.state as ChecklistState;
	assertEq(state.phase, "open");
	assertEq(state.holdReason, null);
	assertEq(view.events.at(-1)?.replacedChecklist?.phase, "held");
	assertEq(view.events.at(-1)?.replacedChecklist?.holdReason, "user asked");
});

test("an addition cites the branch's latest user prompt, consumed at most once", () => {
	const rows: Array<[string, () => ChecklistDetails, string]> = [
		[
			"a blank anchor on a branch with no user prompt",
			() => {
				const session = new FakeSession();
				session.add(preEntry("pre-1"));
				return new ReceiptLedger(new FakePi(session) as never).transition(
					{ kind: "create", title: "Work", tasks: ["one"], anchorId: "  ", actor: "model" },
					new FakeContext(session) as never,
				).details;
			},
			"ANCHOR_REQUIRED",
		],
		[
			"an unknown anchor on a branch with no user prompt",
			() => {
				const session = new FakeSession();
				session.add(preEntry("pre-1"));
				return new ReceiptLedger(new FakePi(session) as never).transition(
					{ kind: "create", title: "Work", tasks: ["one"], anchorId: "nope", actor: "model" },
					new FakeContext(session) as never,
				).details;
			},
			"USER_PROMPT_REQUIRED",
		],
		[
			"an anchor before a later user prompt",
			() => {
				const { ledger, ctx, session } = setup();
				session.add(userEntry("u2", "do it differently"));
				return create(ledger, ctx, ["one"], "user-1");
			},
			"ANCHOR_STALE",
		],
		[
			"an unknown anchor after a later user prompt",
			() => {
				const { ledger, ctx, session } = setup();
				session.add(userEntry("u2", "do it differently"));
				return create(ledger, ctx, ["one"], "missing");
			},
			"ANCHOR_INVALID",
		],
		[
			"a second addition without a new prompt",
			() => {
				const { ledger, ctx } = setup();
				create(ledger, ctx, ["one"]);
				const state = current(ledger, ctx);
				return ledger.transition(
					{
						kind: "add",
						checklistId: state.checklistId,
						revision: state.revision,
						title: "two",
						anchorId: "user-1",
						actor: "model",
					},
					ctx as never,
				).details;
			},
			"NEW_USER_PROMPT_REQUIRED",
		],
	];
	for (const [label, run, code] of rows) {
		const details = run();
		if (details.kind !== "error") throw new Error(`${label}: expected a refusal`);
		assertEq(details.code, code, label);
	}
});

test("a sourced task records the prompt that asked for it", () => {
	const { ledger, ctx } = setup();
	create(ledger, ctx, ["one"]);
	const state = current(ledger, ctx);
	assertEq(state.tasks[0].sourceAnchorId, "user-1");
	assertEq(ledger.fromContext(ctx as never).events.at(-1)?.policyVersion, 2);
});

test("a current record needs a task source, and a downgrade is a fault", () => {
	const sourced = (anchorId: string): ChecklistState =>
		makeState({
			tasks: [{ taskId: "t1", title: "one", status: "pending", note: null, sourceAnchorId: anchorId }],
		});
	const clean = new FakeSession();
	clean.add(userEntry("u1"), preEntry("pre-1"));
	clean.add(stateEvent("e1", "create", null, sourced("u1"), { policyVersion: 2, anchorId: "u1" }));
	const good = new ReceiptLedger(new FakePi(clean) as never);
	assertEq(good.fromContext(new FakeContext(clean) as never).fault, null);
	assertEq(good.fromContext(new FakeContext(clean) as never).state?.tasks[0].sourceAnchorId, "u1");

	const sourceless = new FakeSession();
	sourceless.add(userEntry("u1"), preEntry("pre-1"));
	sourceless.add(
		stateEvent(
			"e1",
			"create",
			null,
			makeState({
				tasks: [{ taskId: "t1", title: "one", status: "pending", note: null } as never],
			}),
			{ policyVersion: 2, anchorId: "u1" },
		),
	);
	const faulted = new ReceiptLedger(new FakePi(sourceless) as never);
	assertIncludes(String(faulted.fromContext(new FakeContext(sourceless) as never).fault), "malformed");

	const downgraded = new FakeSession();
	downgraded.add(userEntry("u1"), preEntry("pre-1"));
	downgraded.add(stateEvent("e1", "create", null, sourced("u1"), { policyVersion: 2, anchorId: "u1" }));
	downgraded.add(userEntry("u2"));
	downgraded.add(
		stateEvent("e2", "update", sourced("u1"), {
			...sourced("u1"),
			revision: 2,
			tasks: [{ taskId: "t1", title: "one", status: "done", note: "ok", sourceAnchorId: "u1" }],
		}),
	);
	const old = new ReceiptLedger(new FakePi(downgraded) as never);
	assertIncludes(String(old.fromContext(new FakeContext(downgraded) as never).fault), "historical transition follows");
});

test("a legacy task stays editable and keeps its absent source", () => {
	const session = new FakeSession();
	session.add(userEntry("u1"), preEntry("pre-1"));
	session.add(stateEvent("e1", "create", null, makeState()));
	const ledger = new ReceiptLedger(new FakePi(session) as never);
	const ctx = new FakeContext(session);
	const before = current(ledger, ctx);
	assertEq(before.tasks[0].sourceAnchorId, null);
	const done = ledger.transition(
		{
			kind: "update",
			checklistId: before.checklistId,
			revision: before.revision,
			taskId: before.tasks[0].taskId,
			status: "done",
			note: "kept",
			actor: "model",
		},
		ctx as never,
	);
	assert(done.ok, "a legacy task keeps being editable");
	const after = current(ledger, ctx);
	assertEq(after.tasks[0].status, "done");
	assertEq(after.tasks[0].sourceAnchorId, null);
});
