import { ChecklistContract } from "../src/checklist-contract.ts";
import { assert, assertIncludes, assertNotIncludes, makeState, test } from "./harness.ts";

const contract = new ChecklistContract();

test("contract catalogue names the tools, limits, and user authority", () => {
	const text = contract.catalogue(null);
	assertIncludes(text, "pre_checklist");
	assertIncludes(text, "one to ten");
	assertIncludes(text, "action ack");
	assertIncludes(text, "/checklist-hold");
	assertIncludes(text, "dismiss or");
	assertIncludes(text, "anchorId");
	assertIncludes(text, "compaction");
	assertNotIncludes(text, "Current list");
	assertNotIncludes(text, "Only the user can hold or dismiss");
});

test("contract guidelines carry the anchor rule for model dismissals", () => {
	const text = contract.guidelines().join("\n");
	assertIncludes(text, "dismiss or replace");
	assertIncludes(text, "anchorId");
});

test("describe labels a dismissed list's reason", () => {
	const text = contract.describe(makeState({ phase: "dismissed", holdReason: "superseded" }), false);
	assertIncludes(text, "Dismissed: superseded");
	assertNotIncludes(text, "Hold: superseded");
});

test("contract catalogue includes an open list", () => {
	const text = contract.catalogue(makeState());
	assertIncludes(text, "Current list");
	assertIncludes(text, "task-1");
});

test("contract guidelines are model-facing and bounded", () => {
	const guidelines = contract.guidelines();
	assert(guidelines.length >= 3, "expected several guidelines");
	for (const line of guidelines) assert(line.length > 20, "guideline is too short");
});

test("describe renders statuses, notes, holds, and acknowledgement freshness", () => {
	const state = makeState({
		phase: "held",
		holdReason: "waiting on user",
		tasks: [{ taskId: "t", title: "one", status: "done", note: "verified" }],
	});
	const text = contract.describe(state, true);
	assertIncludes(text, "[done] #t one — verified");
	assertIncludes(text, "Hold: waiting on user");
	assertIncludes(text, "Acknowledgement: current.");
});

test("unresolved notice names the missing condition", () => {
	const state = makeState();
	assertIncludes(contract.unresolvedNotice(state, "missing_ack", false), "settled with this list still open");
	assertIncludes(contract.unresolvedNotice(state, "missing_ack", false), "missing acknowledgement");
	assertIncludes(contract.unresolvedNotice(state, "unfinished", true), "remaining tasks");
});
