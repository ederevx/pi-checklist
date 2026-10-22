import { ChecklistExtension } from "../src/index.ts";
import {
	FakeContext,
	FakePi,
	FakeSession,
	assert,
	assertEq,
	assertIncludes,
	preEntry,
	test,
	userEntry,
} from "./harness.ts";

function setup(): { pi: FakePi; ctx: FakeContext; session: FakeSession } {
	const session = new FakeSession();
	session.add(userEntry("u1"), preEntry("pre-1"));
	const pi = new FakePi(session);
	new ChecklistExtension().register(pi as never);
	return { pi, ctx: new FakeContext(session), session };
}

async function openList(pi: FakePi, ctx: FakeContext): Promise<string> {
	await pi.tool("checklist", { action: "create", title: "Work", tasks: ["one", "two"] }, ctx);
	const view = (await pi.tool("checklist", { action: "list" }, ctx)) as {
		details: { state: { checklistId: string; tasks: Array<{ taskId: string }> } };
	};
	return view.details.state.checklistId;
}

test("/checklist reports the active list", async () => {
	const { pi, ctx } = setup();
	await openList(pi, ctx);
	await pi.command("checklist", "", ctx);
	assertEq(ctx.notifyCalls.length, 1);
	assertIncludes(ctx.notifyCalls[0].message, "revision 1");
});

test("hold requires a reason and holds the list", async () => {
	const { pi, ctx } = setup();
	await openList(pi, ctx);
	await pi.command("checklist-hold", "", ctx);
	assertEq(ctx.notifyCalls[0].type, "error");
	await pi.command("checklist-hold", "waiting on user", ctx);
	const view = (await pi.tool("checklist", { action: "list" }, ctx)) as { details: { state: { phase: string } } };
	assertEq(view.details.state.phase, "held");
});

test("release returns a held list to open", async () => {
	const { pi, ctx } = setup();
	await openList(pi, ctx);
	await pi.command("checklist-hold", "user", ctx);
	await pi.command("checklist-release", "", ctx);
	const view = (await pi.tool("checklist", { action: "list" }, ctx)) as { details: { state: { phase: string } } };
	assertEq(view.details.state.phase, "open");
});

test("dismiss all and a single task require a reason and update state", async () => {
	const { pi, ctx } = setup();
	await openList(pi, ctx);
	await pi.command("checklist-dismiss", "all", ctx);
	assertEq(ctx.notifyCalls[0].type, "error");
	await pi.command("checklist-dismiss", "all not needed", ctx);
	const view = (await pi.tool("checklist", { action: "list" }, ctx)) as { details: { state: { phase: string } } };
	assertEq(view.details.state.phase, "dismissed");
});

test("dismissing an unknown task is refused", async () => {
	const { pi, ctx } = setup();
	await openList(pi, ctx);
	await pi.command("checklist-dismiss", "missing because", ctx);
	assertEq(ctx.notifyCalls[0].type, "error");
	assertIncludes(ctx.notifyCalls[0].message, "No task");
});

test("commands do not start a model turn", async () => {
	const { pi, ctx } = setup();
	await openList(pi, ctx);
	await pi.command("checklist-hold", "user", ctx);
	assertEq(pi.messages.length, 0);
});
