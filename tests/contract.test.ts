import { ChecklistContract } from "../src/checklist-contract.ts";
import { assert, assertIncludes, assertNotIncludes, makeState, test } from "./harness.ts";

const contract = new ChecklistContract();

test("contract catalogue names the tools, limits, and user authority", () => {
	const text = contract.catalogue(null);
	assertIncludes(text, "pre_checklist");
	assertIncludes(text, "one to three");
	assertIncludes(text, "action ack");
	assertIncludes(text, "/checklist-hold");
	assertIncludes(text, "compaction");
	assertNotIncludes(text, "Current list");
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
	assertIncludes(contract.unresolvedNotice(state, "attempt_cap", false), "limit reached");
	assertIncludes(contract.unresolvedNotice(state, "attempt_cap", false), "missing acknowledgement");
	assertIncludes(contract.unresolvedNotice(state, "unfinished", true), "remaining tasks");
});
