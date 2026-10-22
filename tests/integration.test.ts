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
	await pi.tool("checklist", { action: "create", title: "Ship", tasks: ["build", "test"] }, ctx);
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

test("an unfinished activity cannot outrun the continuation budget", async () => {
	const { pi, ctx, session } = setup();
	session.add(userEntry("u1"), preEntry("pre-1"));
	await pi.tool("checklist", { action: "create", title: "Ship", tasks: ["build"] }, ctx);
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const result = (await pi.fire("agent_before_settle", boundary(), ctx))[0] as {
			entries: unknown[];
			continue?: boolean;
		};
		if (attempt < 3) assertEq(result.continue, true);
		else assertEq(result?.continue, undefined);
		appendDrafts(session, result?.entries ?? []);
	}
});

test("a checklist change forces a fresh acknowledgement", async () => {
	const { pi, ctx, session } = setup();
	session.add(userEntry("u1"), preEntry("pre-1"));
	await pi.tool("checklist", { action: "create", title: "Ship", tasks: ["build"] }, ctx);
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
				tasks: [{ taskId: state.tasks[0].taskId, title: "build", status: "done", note: "ok" }],
				holdReason: null,
			},
		},
	});
	view = (await pi.tool("checklist", { action: "list" }, ctx)) as typeof view;
	const result = (await pi.fire("agent_before_settle", boundary(), ctx))[0] as { continue?: boolean };
	assertEq(result.continue, true);
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
