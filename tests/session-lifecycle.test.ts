import { ChecklistExtension } from "../src/index.ts";
import {
	FakeContext,
	FakePi,
	FakeSession,
	assertEq,
	assertIncludes,
	preEntry,
	stateEvent,
	test,
	userEntry,
} from "./harness.ts";
import { makeState } from "./harness.ts";

function setup(): { pi: FakePi; ctx: FakeContext; session: FakeSession } {
	const session = new FakeSession();
	const pi = new FakePi(session);
	new ChecklistExtension().register(pi as never);
	return { pi, ctx: new FakeContext(session), session };
}

test("compaction re-injects the active list into model context", async () => {
	const { pi, ctx, session } = setup();
	session.add(userEntry("u1"), preEntry("pre-1"), stateEvent("e1", "create", null, makeState()));
	await pi.fire("session_compact", { type: "session_compact" }, ctx);
	assertEq(pi.messages.length, 1);
	const message = pi.messages[0].message as { content: string; display: boolean; customType: string };
	assertEq(message.display, false);
	assertEq(message.customType, "pi-checklist-notice");
	assertIncludes(message.content, "task-1");
});

test("compaction is silent without an active list", async () => {
	const { pi, ctx, session } = setup();
	session.add(userEntry("u1"), preEntry("pre-1"), stateEvent("e1", "create", null, makeState({ phase: "completed" })));
	await pi.fire("session_compact", { type: "session_compact" }, ctx);
	assertEq(pi.messages.length, 0);
});

test("reload surfaces an unreadable state record", async () => {
	const { pi, ctx, session } = setup();
	session.add({ type: "custom", id: "bad", customType: "pi-checklist-state", data: { schema: 99 } });
	await pi.fire("session_start", { type: "session_start", reason: "reload" }, ctx);
	assertEq(ctx.notifyCalls[0].type, "error");
	assertIncludes(ctx.notifyCalls[0].message, "unreadable");
});

test("/tree rebuilds from the selected branch", async () => {
	const { ctx, session } = setup();
	const base = [userEntry("u1"), preEntry("pre-1"), stateEvent("e1", "create", null, makeState())];
	session.setBranch(base, [...base]);
	await ctx.sessionManager.getBranch();
	assertEq(ctx.sessionManager.getBranch().length, 3);
});
