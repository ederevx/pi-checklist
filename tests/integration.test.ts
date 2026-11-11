import { ChecklistExtension } from "../src/index.ts";
import type { BranchEntry } from "../src/checklist-contract.ts";
import {
	FakeContext,
	FakePi,
	FakeSession,
	ackPair,
	assert,
	assertEq,
	boundary,
	preEntry,
	test,
	userEntry,
} from "./harness.ts";

function setup(): { pi: FakePi; ctx: FakeContext; session: FakeSession } {
	const session = new FakeSession();
	const pi = new FakePi(session);
	new ChecklistExtension().register(pi as never);
	return { pi, ctx: new FakeContext(session), session };
}

function appendDrafts(session: FakeSession, drafts: unknown[]): void {
	for (const draft of drafts) {
		const value = draft as {
			type: string;
			customType?: string;
			data?: unknown;
			content?: unknown;
			display?: boolean;
			details?: unknown;
		};
		session.add({
			type: value.type,
			id: `draft-${session.getEntries().length}`,
			customType: value.customType,
			data: value.data,
			content: value.content,
			display: value.display,
			details: value.details,
		} as BranchEntry);
	}
}

test("one multi-step activity runs from pre_checklist to completion", async () => {
	const { pi, ctx, session } = setup();
	session.add(userEntry("u1"));
	await pi.tool("pre_checklist", { acknowledge: true }, ctx);
	session.add(preEntry("pre-1"));
	await pi.tool("checklist", { action: "create", anchorId: "u1", title: "Ship", tasks: ["build", "test"] }, ctx);
	let view = (await pi.tool("checklist", { action: "list" }, ctx)) as {
		details: { state: { checklistId: string; revision: number; tasks: Array<{ taskId: string }> } };
	};
	const list = view.details.state;
	for (const task of list.tasks) {
		const result = (await pi.tool("checklist", {
			action: "update",
			checklistId: list.checklistId,
			revision: (view.details.state as { revision: number }).revision,
			taskId: task.taskId,
			status: "done",
			note: `verified ${task.taskId}`,
		}, ctx)) as { details: { revision: number } };
		view = (await pi.tool("checklist", { action: "list" }, ctx)) as typeof view;
		assertEq(result.details.revision, view.details.state.revision);
	}
	ackPair(session.entries, list.checklistId, view.details.state.revision, 1);
	const result = (await pi.fire("agent_before_settle", boundary(), ctx))[0] as {
		entries: Array<{ data?: { operation: string; state: { phase: string } } }>;
		continue?: boolean;
	};
	assertEq(result.continue, undefined);
	assertEq(result.entries[0].data?.operation, "complete");
	assertEq(result.entries[0].data?.state.phase, "completed");
});

test("an unfinished activity settles unresolved and keeps the list open", async () => {
	const { pi, ctx, session } = setup();
	session.add(userEntry("u1"), preEntry("pre-1"));
	await pi.tool("checklist", { action: "create", anchorId: "u1", title: "Ship", tasks: ["build"] }, ctx);
	const first = (await pi.fire("agent_before_settle", boundary(), ctx))[0] as {
		entries: unknown[];
		continue?: boolean;
	};
	assertEq(first.continue, undefined);
	appendDrafts(session, first.entries);
	const second = (await pi.fire("agent_before_settle", boundary(), ctx))[0] as {
		entries: Array<{ customType?: string; display?: boolean }>;
		continue?: boolean;
	};
	assertEq(second?.continue, undefined);
	assertEq(second.entries.length, 1, "the open list is still reported");
	assertEq(second.entries[0].display, true);
	const view = (await pi.tool("checklist", { action: "list" }, ctx)) as { details: { state: { phase: string } } };
	assertEq(view.details.state.phase, "open");
});

test("a checklist change forces a fresh acknowledgement", async () => {
	const { pi, ctx, session } = setup();
	session.add(userEntry("u1"), preEntry("pre-1"));
	await pi.tool("checklist", { action: "create", anchorId: "u1", title: "Ship", tasks: ["build"] }, ctx);
	let view = (await pi.tool("checklist", { action: "list" }, ctx)) as {
		details: { state: { checklistId: string; revision: number; tasks: Array<{ taskId: string }> } };
	};
	ackPair(session.entries, view.details.state.checklistId, 1, 1);
	const state = view.details.state;
	session.add({
		type: "custom",
		id: "e2",
		customType: "pi-checklist-state",
		data: {
			schema: 1,
			policyVersion: 2,
			eventId: "e2",
			operation: "update",
			actor: "model",
			previousRevision: 1,
			reason: null,
			preReceiptId: null,
			ackReceiptEntryId: null,
			state: {
				checklistId: state.checklistId,
				revision: 2,
				title: "Ship",
				phase: "open",
				tasks: [{ taskId: state.tasks[0].taskId, title: "build", status: "done", note: "ok", sourceAnchorId: "u1" }],
				holdReason: null,
			},
		},
	});
	view = (await pi.tool("checklist", { action: "list" }, ctx)) as typeof view;
	const result = (await pi.fire("agent_before_settle", boundary(), ctx))[0] as {
		continue?: boolean;
		entries: Array<{ content?: string }>;
	};
	assertEq(result.continue, undefined, "settlement is never forced");
	assert(String(result.entries[1].content).includes("still open"));
});

test("a replacement needs its own acknowledgement before the run can settle", async () => {
	type View = {
		details: { state: { checklistId: string; revision: number; tasks: Array<{ taskId: string }> } };
	};
	const { pi, ctx, session } = setup();
	session.add(userEntry("u1"), preEntry("pre-1"));
	await pi.tool("pre_checklist", { acknowledge: true }, ctx);
	await pi.tool("checklist", { action: "create", anchorId: "u1", title: "Ship", tasks: ["build"] }, ctx);
	let view = (await pi.tool("checklist", { action: "list" }, ctx)) as View;
	await pi.tool("checklist", {
		action: "update",
		checklistId: view.details.state.checklistId,
		revision: view.details.state.revision,
		taskId: view.details.state.tasks[0].taskId,
		status: "done",
		note: "built",
	}, ctx);
	view = (await pi.tool("checklist", { action: "list" }, ctx)) as View;
	ackPair(session.entries, view.details.state.checklistId, view.details.state.revision, 1);
	session.add(userEntry("u2", "priorities changed"), preEntry("pre-2"));
	await pi.tool("checklist", {
		action: "replace",
		checklistId: view.details.state.checklistId,
		revision: view.details.state.revision,
		title: "Next",
		tasks: ["read"],
		reason: "priorities changed",
		anchorId: "u2",
	}, ctx);
	view = (await pi.tool("checklist", { action: "list" }, ctx)) as View;
	await pi.tool("checklist", {
		action: "update",
		checklistId: view.details.state.checklistId,
		revision: view.details.state.revision,
		taskId: view.details.state.tasks[0].taskId,
		status: "done",
		note: "read",
	}, ctx);
	const blocked = (await pi.fire("agent_before_settle", boundary(), ctx))[0] as {
		continue?: boolean;
		entries: Array<{ content?: string }>;
	};
	assertEq(blocked.continue, undefined, "settlement is never forced");
	assert(String(blocked.entries[1].content).includes("missing acknowledgement"));
	view = (await pi.tool("checklist", { action: "list" }, ctx)) as View;
	ackPair(session.entries, view.details.state.checklistId, view.details.state.revision, 2);
	const settled = (await pi.fire("agent_before_settle", boundary(), ctx))[0] as { continue?: boolean };
	assertEq(settled.continue, undefined, "a fresh acknowledgement lets the run settle");
});

test("pi-consult's implementation gate sees these tools as ordinary callables", () => {
	const { pi } = setup();
	const names = [...pi.tools.keys()].sort();
	assertEq(names.join(","), "checklist,pre_checklist");
});

test("the checklist gate composes with a consultant-style implementation gate", async () => {
	for (const order of ["checklist-first", "consult-first"]) {
		const session = new FakeSession();
		const pi = new FakePi(session);
		let consulted = false;
		const consultGate = (event: { toolName?: string }) => {
			if (event.toolName === "pre_consult") {
				consulted = true;
				return undefined;
			}
			return consulted ? undefined : { block: true, reason: "pre_consult required" };
		};
		if (order === "consult-first") pi.on("tool_call", consultGate);
		new ChecklistExtension().register(pi as never);
		if (order === "checklist-first") pi.on("tool_call", consultGate);
		const ctx = new FakeContext(session);
		const blocked = (await pi.fire("tool_call", { type: "tool_call", toolName: "pre_checklist", toolCallId: "c1", input: {} }, ctx)).some(
			(result) => (result as { block?: boolean } | undefined)?.block === true,
		);
		assert(blocked, `${order}: pre_checklist must wait for pre_consult`);
		await pi.fire("tool_call", { type: "tool_call", toolName: "pre_consult", toolCallId: "c2", input: {} }, ctx);
		const allowed = (await pi.fire("tool_call", { type: "tool_call", toolName: "pre_checklist", toolCallId: "c3", input: {} }, ctx)).every(
			(result) => (result as { block?: boolean } | undefined)?.block !== true,
		);
		assert(allowed, `${order}: pre_checklist must pass after pre_consult`);
	}
});
