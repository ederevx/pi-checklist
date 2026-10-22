import { Value } from "typebox/value";

import { ChecklistContract } from "../src/checklist-contract.ts";
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
		title: "eleven",
	}, ctx)) as { details: { kind: string; code?: string } };
	assertEq(add.details.kind, "error");
	assertEq(add.details.code, "TASK_LIMIT");
});

test("update requires a completion note and advances revision", async () => {
	const { pi, ctx } = setup();
	await pi.tool("checklist", { action: "create", title: "Work", tasks: ["one"] }, ctx);
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

test("ack must be the sole tool call in its message", async () => {
	const { pi, ctx, session } = setup();
	await pi.tool("checklist", { action: "create", title: "Work", tasks: ["one"] }, ctx);
	const state = ((await pi.tool("checklist", { action: "list" }, ctx)) as {
		details: { state: { checklistId: string; revision: number } };
	}).details.state;
	session.add(assistantEntry("a1", [
		{ id: "ack-call", name: "checklist" },
		{ id: "other-call", name: "bash" },
	]));
	const result = (await pi.tool(
		"checklist",
		{ action: "ack", checklistId: state.checklistId, revision: state.revision, summary: "reviewed" },
		ctx,
		"ack-call",
	)) as { details: { kind: string; code?: string }; isError?: boolean };
	assertEq(result.details.kind, "error");
	assertEq(result.details.code, "NOT_SOLE_CALL");
	assertEq(result.isError, true);
});

test("ack after the work succeeds as a sole call", async () => {
	const { pi, ctx, session } = setup();
	await pi.tool("checklist", { action: "create", title: "Work", tasks: ["one"] }, ctx);
	const state = ((await pi.tool("checklist", { action: "list" }, ctx)) as {
		details: { state: { checklistId: string; revision: number } };
	}).details.state;
	session.add(assistantEntry("a1", [{ id: "ack-call", name: "checklist" }]));
	const result = (await pi.tool(
		"checklist",
		{ action: "ack", checklistId: state.checklistId, revision: state.revision, summary: "reviewed" },
		ctx,
		"ack-call",
	)) as { details: { kind: string }; isError?: boolean };
	assertEq(result.details.kind, "ack");
	assertEq(result.isError, undefined);
});

test("create before pre_checklist is refused by the tool", async () => {
	const session = new FakeSession();
	const pi = new FakePi(session);
	const ledger = new ReceiptLedger(pi as never);
	new ChecklistTool(ledger, new ChecklistContract()).register(pi as never);
	const result = (await pi.tool("checklist", { action: "create", title: "Work", tasks: ["one"] }, new FakeContext(session))) as {
		details: { code?: string };
	};
	assertEq(result.details.code, "PRE_REQUIRED");
});

test("a held list refuses model mutations", async () => {
	const { pi, ctx } = setup();
	await pi.tool("checklist", { action: "create", title: "Work", tasks: ["one"] }, ctx);
	const ledger = new ReceiptLedger(pi as never);
	ledger.transition({ kind: "hold", reason: "user", actor: "user" }, ctx as never);
	const state = ((await pi.tool("checklist", { action: "list" }, ctx)) as {
		details: { state: { checklistId: string; revision: number } };
	}).details.state;
	const result = (await pi.tool("checklist", {
		action: "add",
		checklistId: state.checklistId,
		revision: state.revision,
		title: "two",
	}, ctx)) as { details: { code?: string } };
	assertEq(result.details.code, "NOT_OPEN");
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
	assert(Value.Check(definition.parameters as never, { action: "create", title: "Work", tasks: ten }));
	assert(!Value.Check(definition.parameters as never, { action: "create", title: "Work", tasks: eleven }));
});

test("create without tasks or title is refused before any state exists", async () => {
	const { pi, ctx } = setup();
	const missingTasks = (await pi.tool("checklist", { action: "create", title: "Work" }, ctx)) as {
		details: { kind: string; code?: string };
	};
	assertEq(missingTasks.details.kind, "error");
	assertEq(missingTasks.details.code, "INVALID_ARGS");
	const missingTitle = (await pi.tool("checklist", { action: "create", tasks: ["one"] }, ctx)) as {
		details: { kind: string; code?: string };
	};
	assertEq(missingTitle.details.code, "INVALID_ARGS");
	const state = ((await pi.tool("checklist", { action: "list" }, ctx)) as {
		details: { state: unknown };
	}).details.state;
	assertEq(state, null);
});

test("a stringified task array is refused as invalid arguments", async () => {
	const { pi, ctx } = setup();
	const result = (await pi.tool(
		"checklist",
		{ action: "create", title: "Work", tasks: '["one","two"]' },
		ctx,
	)) as { details: { kind: string; code?: string } };
	assertEq(result.details.code, "INVALID_ARGS");
});

test("an action carrying another action's field is refused", async () => {
	const { pi, ctx } = setup();
	const result = (await pi.tool("checklist", { action: "list", title: "Work" }, ctx)) as {
		details: { kind: string; code?: string };
	};
	assertEq(result.details.kind, "error");
	assertEq(result.details.code, "INVALID_ARGS");
});

test("invalid arguments are refused before the receipt gate", async () => {
	const session = new FakeSession();
	const pi = new FakePi(session);
	const ledger = new ReceiptLedger(pi as never);
	new ChecklistTool(ledger, new ChecklistContract()).register(pi as never);
	const result = (await pi.tool("checklist", { action: "create", title: "Work" }, new FakeContext(session))) as {
		details: { code?: string };
	};
	assertEq(result.details.code, "INVALID_ARGS");
});
