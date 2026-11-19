import { Value } from "typebox/value";

import { ChecklistContract } from "../src/checklist-contract.ts";
import { ChecklistParameters } from "../src/checklist-parameters.ts";
import { ChecklistTool } from "../src/checklist-tool.ts";
import { PreChecklistTool } from "../src/pre-checklist-tool.ts";
import { ReceiptLedger } from "../src/receipt-ledger.ts";
import {
	FakeContext,
	FakePi,
	FakeSession,
	assistantEntry,
	assert,
	assertEq,
	assertIncludes,
	preEntry,
	test,
	userEntry,
} from "./harness.ts";

function setup(): { pi: FakePi; ctx: FakeContext; session: FakeSession } {
	const session = new FakeSession();
	session.add(userEntry("u1"));
	session.add(preEntry("pre-1"));
	const pi = new FakePi(session);
	const ledger = new ReceiptLedger(pi as never);
	const contract = new ChecklistContract();
	new PreChecklistTool(ledger, contract).register(pi as never);
	new ChecklistTool(ledger, contract).register(pi as never);
	return { pi, ctx: new FakeContext(session), session };
}

test("list works before the catalogue acknowledgement", async () => {
	const session = new FakeSession();
	const pi = new FakePi(session);
	const ledger = new ReceiptLedger(pi as never);
	new ChecklistTool(ledger, new ChecklistContract()).register(pi as never);
	const result = (await pi.tool("checklist", { action: "list" }, new FakeContext(session))) as {
		details: { kind: string; acknowledged: boolean };
	};
	assertEq(result.details.kind, "view");
	assertEq(result.details.acknowledged, false);
});

test("create returns the new list and rejects an eleventh task", async () => {
	const { pi, ctx } = setup();
	const created = (await pi.tool("checklist", {
		action: "create",
		anchorId: "u1",
		title: "Work",
		tasks: ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"],
	}, ctx)) as { details: { kind: string; revision: number }; content: Array<{ text: string }> };
	assertEq(created.details.kind, "mutation");
	assertEq(created.details.revision, 1);
	assertIncludes(created.content[0].text, "revision 1");
	const state = (await pi.tool("checklist", { action: "list" }, ctx)) as {
		details: { state: { checklistId: string; revision: number; tasks: Array<{ taskId: string }> } };
	};
	const list = state.details.state;
	const add = (await pi.tool("checklist", {
		action: "add",
		checklistId: list.checklistId,
		revision: list.revision,
		anchorId: "u1",
		title: "eleven",
	}, ctx)) as { details: { kind: string; code?: string } };
	assertEq(add.details.kind, "error");
	assertEq(add.details.code, "TASK_LIMIT");
});

test("update requires a completion note and advances revision", async () => {
	const { pi, ctx } = setup();
	await pi.tool("checklist", { action: "create", anchorId: "u1", title: "Work", tasks: ["one"] }, ctx);
	const state = ((await pi.tool("checklist", { action: "list" }, ctx)) as {
		details: { state: { checklistId: string; revision: number; tasks: Array<{ taskId: string }> } };
	}).details.state;
	const refused = (await pi.tool("checklist", {
		action: "update",
		checklistId: state.checklistId,
		revision: state.revision,
		taskId: state.tasks[0].taskId,
		status: "done",
	}, ctx)) as { details: { kind: string; code?: string } };
	assertEq(refused.details.code, "NOTE_REQUIRED");
	const done = (await pi.tool("checklist", {
		action: "update",
		checklistId: state.checklistId,
		revision: state.revision,
		taskId: state.tasks[0].taskId,
		status: "done",
		note: "verified",
	}, ctx)) as { details: { kind: string; revision: number } };
	assertEq(done.details.kind, "mutation");
	assertEq(done.details.revision, 2);
});

test("an acknowledgement is refused for a shared message, a foreign id, or a mismatched quote", async () => {
	const rows: Array<[
		string,
		Array<{ id: string; name: string }>,
		(state: { checklistId: string }) => string,
		string,
		((result: { details: { checklistId?: string | null }; content: Array<{ text: string }>; isError?: boolean }, context: { label: string; received: string; state: { checklistId: string } }) => void)?,
	]> = [
		[
			"a shared message",
			[{ id: "ack-call", name: "checklist" }, { id: "other-call", name: "bash" }],
			(state) => state.checklistId,
			"NOT_SOLE_CALL",
			(result, { label }) => assertEq(result.isError, true, `${label}: a shared message is an error result`),
		],
		[
			"a foreign checklist id",
			[{ id: "ack-call", name: "checklist" }],
			() => "other-checklist",
			"UNKNOWN_CHECKLIST",
			(result, { label, received, state }) => {
				assertEq(result.details.checklistId, state.checklistId, `${label}: the refusal names the current list`);
				assertIncludes(result.content[0].text, JSON.stringify(received), `${label}: the refusal quotes the id it received`);
				assertIncludes(result.content[0].text, "(UNKNOWN_CHECKLIST)", `${label}: the refusal names its code`);
			},
		],
		[
			"a mismatched quote",
			[{ id: "ack-call", name: "checklist" }],
			(state) => `"${state.checklistId}'`,
			"UNKNOWN_CHECKLIST",
			(result, { label, received, state }) => {
				assertEq(result.details.checklistId, state.checklistId, `${label}: the refusal names the current list`);
				assertIncludes(result.content[0].text, JSON.stringify(received), `${label}: the refusal quotes the id it received`);
			},
		],
	];
	for (const [label, calls, id, code, check] of rows) {
		const { pi, ctx, session } = setup();
		await pi.tool("checklist", { action: "create", anchorId: "u1", title: "Work", tasks: ["one"] }, ctx);
		const state = await list(pi, ctx);
		session.add(assistantEntry("a1", calls));
		const received = id(state);
		const result = (await pi.tool(
			"checklist",
			{ action: "ack", checklistId: received, revision: state.revision, summary: "reviewed" },
			ctx,
			"ack-call",
		)) as { details: { kind: string; code?: string; checklistId?: string | null }; content: Array<{ text: string }>; isError?: boolean };
		assertEq(result.details.kind, "error", label);
		assertEq(result.details.code, code, label);
		check?.(result, { label, received, state });
	}
});

test("an acknowledgement of the current list, quoted or not, succeeds", async () => {
	const rows: Array<[string, (state: { checklistId: string }) => string]> = [
		["a plain id", (state) => state.checklistId],
		["a quoted id", (state) => ` "${state.checklistId}" `],
	];
	for (const [label, id] of rows) {
		const { pi, ctx, session } = setup();
		await pi.tool("checklist", { action: "create", anchorId: "u1", title: "Work", tasks: ["one"] }, ctx);
		const state = await list(pi, ctx);
		session.add(assistantEntry("a1", [{ id: "ack-call", name: "checklist" }]));
		const result = (await pi.tool(
			"checklist",
			{ action: "ack", checklistId: id(state), revision: state.revision, summary: "reviewed" },
			ctx,
			"ack-call",
		)) as { details: { kind: string; checklistId?: string }; isError?: boolean };
		assertEq(result.details.kind, "ack", label);
		assertEq(result.details.checklistId, state.checklistId, label);
		assertEq(result.isError, undefined, label);
	}
});

test("add and update accept quoted checklist and task ids", async () => {
	const { pi, ctx, session } = setup();
	await pi.tool("checklist", { action: "create", anchorId: "u1", title: "Work", tasks: ["one"] }, ctx);
	const state = ((await pi.tool("checklist", { action: "list" }, ctx)) as {
		details: { state: { checklistId: string; revision: number; tasks: Array<{ taskId: string }> } };
	}).details.state;
	const updated = (await pi.tool("checklist", {
		action: "update",
		checklistId: `'${state.checklistId}'`,
		revision: state.revision,
		taskId: `"${state.tasks[0].taskId}"`,
		status: "done",
		note: "verified",
	}, ctx)) as { details: { kind: string; checklistId: string; revision: number } };
	assertEq(updated.details.kind, "mutation");
	assertEq(updated.details.checklistId, state.checklistId);
	assertEq(updated.details.revision, 2);
	session.add(userEntry("u2", "one more"));
	const added = (await pi.tool("checklist", {
		action: "add",
		checklistId: `"${state.checklistId}"`,
		revision: 2,
		anchorId: "u2",
		title: "two",
	}, ctx)) as { details: { kind: string; revision: number } };
	assertEq(added.details.kind, "mutation");
	assertEq(added.details.revision, 3);
});

test("a checklist mutation is refused with the ledger's code", async () => {
	const rows: Array<[string, () => Promise<{ code?: string }>, string]> = [
		[
			"a held list",
			async () => {
				const { pi, ctx } = setup();
				await pi.tool("checklist", { action: "create", anchorId: "u1", title: "Work", tasks: ["one"] }, ctx);
				new ReceiptLedger(pi as never).transition({ kind: "hold", reason: "user", actor: "user" }, ctx as never);
				const state = await list(pi, ctx);
				return (await pi.tool("checklist", {
					action: "add",
					checklistId: state.checklistId,
					revision: state.revision,
					anchorId: "u1",
					title: "two",
				}, ctx)).details;
			},
			"NOT_OPEN",
		],
		[
			"no pre_checklist receipt",
			async () => {
				const session = new FakeSession();
				const pi = new FakePi(session);
				new ChecklistTool(new ReceiptLedger(pi as never), new ChecklistContract()).register(pi as never);
				return (await pi.tool(
					"checklist",
					{ action: "create", anchorId: "u1", title: "Work", tasks: ["one"] },
					new FakeContext(session),
				)).details;
			},
			"PRE_REQUIRED",
		],
		[
			"a second addition without a new prompt",
			async () => {
				const { pi, ctx } = setup();
				await pi.tool("checklist", { action: "create", anchorId: "u1", title: "Work", tasks: ["one"] }, ctx);
				const state = await list(pi, ctx);
				return (await pi.tool("checklist", {
					action: "add",
					checklistId: state.checklistId,
					revision: state.revision,
					anchorId: "u1",
					title: "two",
				}, ctx)).details;
			},
			"NEW_USER_PROMPT_REQUIRED",
		],
	];
	for (const [label, run, code] of rows) assertEq((await run()).code, code, label);
});

test("nested checklist calls are refused", async () => {
	const { pi, ctx } = setup();
	const result = (await pi.tool("checklist", { action: "list" }, ctx, "parent/call")) as {
		details: { code?: string };
	};
	assertEq(result.details.code, "NESTED_CALL");
});

test("the registered create schema accepts ten tasks and rejects eleven", () => {
	const { pi } = setup();
	const definition = (pi as unknown as { tools: Map<string, { parameters: unknown }> }).tools.get("checklist");
	assert(definition !== undefined, "checklist must be registered");
	const parameters = definition.parameters as {
		type?: string;
		anyOf?: unknown;
		oneOf?: unknown;
		properties?: Record<string, { type?: string }>;
	};
	assertEq(parameters.type, "object");
	assert(parameters.anyOf === undefined, "the schema must not be a root union");
	assert(parameters.oneOf === undefined, "the schema must not be a root union");
	assertEq(parameters.properties?.tasks?.type, "array");
	const ten = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
	const eleven = [...ten, "k"];
	assert(Value.Check(definition.parameters as never, { action: "create", anchorId: "u1", title: "Work", tasks: ten }));
	assert(!Value.Check(definition.parameters as never, { action: "create", anchorId: "u1", title: "Work", tasks: eleven }));
});

test("invalid arguments are refused before any state or receipt exists", async () => {
	const rows: Array<[string, (label: string) => Promise<{ code?: string }>]> = [
		[
			"a field the action does not declare",
			async (label) => {
				const { pi, ctx } = setup();
				const result = (await pi.tool("checklist", {
					action: "add",
					checklistId: "cl-1",
					revision: 1,
					title: "T",
					tasks: ["x"],
				}, ctx)) as { details: { kind: string; code?: string; message?: string } };
				assertEq(result.details.kind, "error", label);
				assertIncludes(result.details.message ?? "", '"tasks"', `${label}: the message names the field`);
				assertIncludes(result.details.message ?? "", 'action "add"', `${label}: the message names the action`);
				return result.details;
			},
		],
		[
			"a create without tasks",
			async (label) => {
				const { pi, ctx } = setup();
				const result = (await pi.tool("checklist", { action: "create", anchorId: "u1", title: "Work" }, ctx)) as {
					details: { kind: string; code?: string };
				};
				assertEq(result.details.kind, "error", label);
				const state = ((await pi.tool("checklist", { action: "list" }, ctx)) as {
					details: { state: unknown };
				}).details.state;
				assertEq(state, null, `${label}: a refused create leaves no state`);
				return result.details;
			},
		],
		[
			"a create without a title",
			async (label) => {
				const { pi, ctx } = setup();
				const result = (await pi.tool("checklist", { action: "create", tasks: ["one"] }, ctx)) as {
					details: { kind: string; code?: string };
				};
				assertEq(result.details.kind, "error", label);
				return result.details;
			},
		],
		[
			"a stringified task array",
			async () => {
				const { pi, ctx } = setup();
				return ((await pi.tool("checklist", { action: "create", anchorId: "u1", title: "Work", tasks: '["one","two"]' }, ctx)) as {
					details: { code?: string };
				}).details;
			},
		],
		[
			"a field another action declares",
			async (label) => {
				const { pi, ctx } = setup();
				const result = (await pi.tool("checklist", { action: "list", title: "Work" }, ctx)) as {
					details: { kind: string; code?: string };
				};
				assertEq(result.details.kind, "error", label);
				return result.details;
			},
		],
		[
			"invalid arguments before an unacknowledged receipt",
			async () => {
				const session = new FakeSession();
				const pi = new FakePi(session);
				new ChecklistTool(new ReceiptLedger(pi as never), new ChecklistContract()).register(pi as never);
				return ((await pi.tool(
					"checklist",
					{ action: "create", anchorId: "u1", title: "Work" },
					new FakeContext(session),
				)) as { details: { code?: string } }).details;
			},
		],
		[
			"a dismiss without a reason",
			async (label) => {
				const { pi, ctx } = setup();
				await pi.tool("checklist", { action: "create", anchorId: "u1", title: "Work", tasks: ["one"] }, ctx);
				const state = await list(pi, ctx);
				const result = (await pi.tool("checklist", {
					action: "dismiss",
					checklistId: state.checklistId,
					revision: state.revision,
					anchorId: "u2",
				}, ctx)) as { details: { code?: string } };
				assertEq(pi.messages.length, 0, `${label}: a refusal is never announced`);
				return result.details;
			},
		],
		[
			"a replace without an anchor",
			async (label) => {
				const { pi, ctx } = setup();
				await pi.tool("checklist", { action: "create", anchorId: "u1", title: "Work", tasks: ["one"] }, ctx);
				const state = await list(pi, ctx);
				const result = (await pi.tool("checklist", {
					action: "replace",
					checklistId: state.checklistId,
					revision: state.revision,
					title: "Next",
					tasks: ["read"],
					reason: "changed",
				}, ctx)) as { details: { code?: string } };
				assertEq(pi.messages.length, 0, `${label}: a refusal is never announced`);
				return result.details;
			},
		],
		[
			"a replace field the action does not declare",
			async () => {
				const { pi, ctx } = setup();
				await pi.tool("checklist", { action: "create", anchorId: "u1", title: "Work", tasks: ["one"] }, ctx);
				const state = await list(pi, ctx);
				return ((await pi.tool("checklist", {
					action: "replace",
					checklistId: state.checklistId,
					revision: state.revision,
					title: "Next",
					tasks: ["read"],
					reason: "changed",
					anchorId: "u2",
					taskId: state.tasks[0].taskId,
				}, ctx)) as { details: { code?: string } }).details;
			},
		],
		[
			"an addition without an anchor",
			async () => {
				const { pi, ctx } = setup();
				return ((await pi.tool("checklist", { action: "create", title: "Work", tasks: ["one"] }, ctx)) as {
					details: { code?: string };
				}).details;
			},
		],
	];
	for (const [label, run] of rows) assertEq((await run(label)).code, "INVALID_ARGS", label);
});

test("a completed task is removed to free a place; an unfinished one is refused", async () => {
	const { pi, ctx, session } = setup();
	await pi.tool("checklist", {
		action: "create",
		anchorId: "u1",
		title: "Work",
		tasks: ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"],
	}, ctx);
	const state = ((await pi.tool("checklist", { action: "list" }, ctx)) as {
		details: { state: { checklistId: string; revision: number; tasks: Array<{ taskId: string }> } };
	}).details.state;
	const unfinished = (await pi.tool("checklist", {
		action: "remove",
		checklistId: state.checklistId,
		revision: state.revision,
		taskId: state.tasks[0].taskId,
	}, ctx)) as { details: { kind: string; code?: string } };
	assertEq(unfinished.details.kind, "error");
	assertEq(unfinished.details.code, "TASK_NOT_DONE");
	await pi.tool("checklist", {
		action: "update",
		checklistId: state.checklistId,
		revision: state.revision,
		taskId: state.tasks[0].taskId,
		status: "done",
		note: "ran the suite",
	}, ctx);
	const done = ((await pi.tool("checklist", { action: "list" }, ctx)) as {
		details: { state: { checklistId: string; revision: number; tasks: Array<{ taskId: string }> } };
	}).details.state;
	const removed = (await pi.tool("checklist", {
		action: "remove",
		checklistId: done.checklistId,
		revision: done.revision,
		taskId: done.tasks[0].taskId,
	}, ctx)) as { details: { kind: string; revision: number }; content: Array<{ text: string }> };
	assertEq(removed.details.kind, "mutation");
	assertEq(removed.details.revision, done.revision + 1);
	assertIncludes(removed.content[0].text, "Acknowledgement: required.");
	const after = ((await pi.tool("checklist", { action: "list" }, ctx)) as {
		details: { state: { revision: number; tasks: Array<{ taskId: string }> } };
	}).details.state;
	assertEq(after.tasks.length, 9);
	assert(!after.tasks.some((task) => task.taskId === done.tasks[0].taskId), "the removed record is gone");
	session.add(userEntry("u2", "add one back"));
	const readded = (await pi.tool("checklist", {
		action: "add",
		checklistId: done.checklistId,
		revision: after.revision,
		anchorId: "u2",
		title: "eleven",
	}, ctx)) as { details: { kind: string } };
	assertEq(readded.details.kind, "mutation");
});

test("an action name outside the declared set has no schema", () => {
	const parameters = new ChecklistParameters();
	assert(parameters.schemaFor("create") !== null, "a declared action must resolve");
	assertEq(parameters.schemaFor("constructor"), null);
	assertEq(parameters.schemaFor("toString"), null);
});

/** Read the current list as the tool reports it. */
async function list(pi: FakePi, ctx: FakeContext): Promise<{
	checklistId: string;
	revision: number;
	phase: string;
	tasks: Array<{ taskId: string; status: string }>;
}> {
	const state = (await pi.tool("checklist", { action: "list" }, ctx)) as {
		details: { state: { checklistId: string; revision: number; phase: string; tasks: Array<{ taskId: string; status: string }> } };
	};
	return state.details.state;
}

test("dismiss with a taskId dismisses one task and announces it", async () => {
	const { pi, ctx, session } = setup();
	await pi.tool("checklist", { action: "create", anchorId: "u1", title: "Work", tasks: ["one", "two"] }, ctx);
	const state = await list(pi, ctx);
	session.add(userEntry("u2", "priorities changed"));
	const result = (await pi.tool("checklist", {
		action: "dismiss",
		checklistId: state.checklistId,
		revision: state.revision,
		taskId: state.tasks[0].taskId,
		reason: "no longer wanted",
		anchorId: "u2",
	}, ctx)) as { details: { kind: string; revision: number } };
	assertEq(result.details.kind, "mutation");
	assertEq(result.details.revision, 2);
	const after = await list(pi, ctx);
	assertEq(after.tasks[0].status, "dismissed");
	assertEq(pi.messages.length, 1, "one visible notice");
	const sent = pi.messages[0].message as { content: string; display: boolean; details: { reason: string } };
	assertIncludes(sent.content, "Model dismissed task");
	assertEq(sent.details.reason, "model-transition");
	assertEq(sent.display, true);
	assertEq((pi.messages[0].options as { triggerTurn?: boolean }).triggerTurn, false);
});

test("dismiss without a taskId dismisses the whole list", async () => {
	const { pi, ctx, session } = setup();
	await pi.tool("checklist", { action: "create", anchorId: "u1", title: "Work", tasks: ["one"] }, ctx);
	const state = await list(pi, ctx);
	session.add(userEntry("u2", "drop it"));
	const result = (await pi.tool("checklist", {
		action: "dismiss",
		checklistId: state.checklistId,
		revision: state.revision,
		reason: "superseded",
		anchorId: "u2",
	}, ctx)) as { details: { kind: string } };
	assertEq(result.details.kind, "mutation");
	assertEq((await list(pi, ctx)).phase, "dismissed");
	const sent = pi.messages[0].message as { content: string };
	assertIncludes(sent.content, "Model dismissed checklist");
});

test("a blank taskId is a task dismissal, not a list dismissal", async () => {
	const { pi, ctx, session } = setup();
	await pi.tool("checklist", { action: "create", anchorId: "u1", title: "Work", tasks: ["one"] }, ctx);
	const state = await list(pi, ctx);
	session.add(userEntry("u2", "drop one"));
	const result = (await pi.tool("checklist", {
		action: "dismiss",
		checklistId: state.checklistId,
		revision: state.revision,
		taskId: " ",
		reason: "obsolete",
		anchorId: "u2",
	}, ctx)) as { details: { code?: string } };
	assertEq(result.details.code, "UNKNOWN_TASK");
	assertEq((await list(pi, ctx)).phase, "open");
});

test("replace needs a fresh receipt and reports both lists", async () => {
	const { pi, ctx, session } = setup();
	await pi.tool("checklist", { action: "create", anchorId: "u1", title: "Work", tasks: ["one"] }, ctx);
	const state = await list(pi, ctx);
	session.add(userEntry("u2", "do the other thing"));
	const refused = (await pi.tool("checklist", {
		action: "replace",
		checklistId: state.checklistId,
		revision: state.revision,
		title: "Next",
		tasks: ["read"],
		reason: "priorities changed",
		anchorId: "u2",
	}, ctx)) as { details: { code?: string } };
	assertEq(refused.details.code, "PRE_REQUIRED");
	session.add(preEntry("pre-2"));
	const result = (await pi.tool("checklist", {
		action: "replace",
		checklistId: state.checklistId,
		revision: state.revision,
		title: "Next",
		tasks: ["read"],
		reason: "priorities changed",
		anchorId: "u2",
	}, ctx)) as { details: { kind: string; checklistId: string; revision: number } };
	assertEq(result.details.kind, "mutation");
	assertEq(result.details.revision, 1);
	assert(result.details.checklistId !== state.checklistId, "expected a new list");
	const sent = pi.messages[0].message as { content: string };
	assertIncludes(sent.content, "Model replaced checklist");
	assertIncludes(sent.content, "following user message u2");
});

test("list exposes the latest user anchor and each task's source", async () => {
	const { pi, ctx } = setup();
	await pi.tool("checklist", { action: "create", anchorId: "u1", title: "Work", tasks: ["one"] }, ctx);
	const view = (await pi.tool("checklist", { action: "list" }, ctx)) as {
		details: { anchorId: string; state: { tasks: Array<{ sourceAnchorId: string }> } };
		content: Array<{ text: string }>;
	};
	assertEq(view.details.anchorId, "u1");
	assertEq(view.details.state.tasks[0].sourceAnchorId, "u1");
	assertIncludes(view.content[0].text, "Latest user message anchorId: u1");
	assertIncludes(view.content[0].text, "[source: u1]");
});
