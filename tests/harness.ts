/**
 * pi-checklist — minimal zero-dependency test harness.
 *
 * Owns the registry, assertions, scratch root (under ~/tmp), and the fake pi
 * surface: a session log, event dispatch, tools, commands, and boundary drafts.
 * Run from the repo root with:
 *
 *   node --experimental-strip-types --experimental-transform-types tests/run.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
	ChecklistContract,
	SCHEMA,
	type BranchEntry,
	type ChecklistState,
	type StateEvent,
} from "../src/checklist-contract.ts";

export type TestFn = () => void | Promise<void>;

class TestRegistry {
	private readonly cases: Array<{ name: string; fn: TestFn }> = [];
	private passed = 0;
	private readonly failures: string[] = [];

	register(name: string, fn: TestFn): void {
		this.cases.push({ name, fn });
	}

	async runAll(): Promise<void> {
		for (const testCase of this.cases) {
			const started = Date.now();
			try {
				await testCase.fn();
				this.passed += 1;
				console.log(`  ok   ${testCase.name} (${Date.now() - started}ms)`);
			} catch (error) {
				this.failures.push(testCase.name);
				console.error(`  FAIL ${testCase.name}`);
				console.error(`       ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
			}
		}
		console.log(`\n${this.passed}/${this.cases.length} passed`);
		if (this.failures.length > 0) console.error(`Failed: ${this.failures.join(", ")}`);
	}

	get failed(): number {
		return this.failures.length;
	}
}

export const registry = new TestRegistry();

export function test(name: string, fn: TestFn): void {
	registry.register(name, fn);
}

export function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

export function assertEq<T>(actual: T, expected: T, message?: string): void {
	if (actual !== expected) {
		throw new Error(`${message ?? "assertEq"} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	}
}

export function assertIncludes(haystack: string, needle: string, message?: string): void {
	if (!haystack.includes(needle)) throw new Error(`${message ?? "assertIncludes"} — ${JSON.stringify(haystack)} lacks ${needle}`);
}

export function assertNotIncludes(haystack: string, needle: string, message?: string): void {
	if (haystack.includes(needle)) throw new Error(`${message ?? "assertNotIncludes"} — ${JSON.stringify(haystack)} has ${needle}`);
}

let scratchRoot: string | undefined;

export function scratchDir(): string {
	if (scratchRoot === undefined) scratchRoot = mkdtempSync(join(homedir(), "tmp", "pi-checklist-tests-"));
	return scratchRoot;
}

export function cleanupScratch(): void {
	if (scratchRoot !== undefined) {
		rmSync(scratchRoot, { recursive: true, force: true });
		scratchRoot = undefined;
	}
}

/** A session log: whole-session entries and, optionally, a distinct branch. */
export class FakeSession {
	entries: BranchEntry[] = [];
	branch: BranchEntry[] | null = null;
	private next = 1;

	getEntries(): BranchEntry[] {
		return this.entries;
	}

	getBranch(): BranchEntry[] {
		return this.branch ?? this.entries;
	}

	setBranch(branch: BranchEntry[], entries?: BranchEntry[]): void {
		this.branch = branch;
		this.entries = entries ?? branch;
	}

	append(customType: string, data?: unknown): BranchEntry {
		const entry: BranchEntry = { type: "custom", id: `auto-${this.next++}`, customType, data };
		this.entries.push(entry);
		if (this.branch && this.branch !== this.entries) this.branch.push(entry);
		return entry;
	}

	add(...entries: BranchEntry[]): void {
		this.entries.push(...entries);
		if (this.branch && this.branch !== this.entries) this.branch.push(...entries);
	}
}

/** A minimal stand-in for pi's ExtensionAPI. */
export class FakePi {
	readonly tools = new Map<string, Record<string, unknown>>();
	readonly handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	readonly commands = new Map<string, Record<string, unknown>>();
	readonly messages: Array<{ message: unknown; options?: unknown }> = [];

	constructor(readonly session: FakeSession) {}

	registerTool(definition: Record<string, unknown> & { name: string }): void {
		this.tools.set(definition.name, definition);
	}

	on(event: string, handler: (event: unknown, ctx: unknown) => unknown): () => void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
		return () => undefined;
	}

	registerCommand(name: string, options: Record<string, unknown>): void {
		this.commands.set(name, options);
	}

	appendEntry(customType: string, data?: unknown): void {
		this.session.append(customType, data);
	}

	sendMessage(message: unknown, options?: unknown): void {
		this.messages.push({ message, options });
	}

	async fire(event: string, payload: unknown, ctx: FakeContext): Promise<unknown[]> {
		const results: unknown[] = [];
		for (const handler of this.handlers.get(event) ?? []) {
			results.push(await handler(payload, ctx));
		}
		return results;
	}

	async tool<T = Record<string, unknown>>(
		name: string,
		args: Record<string, unknown>,
		ctx: FakeContext,
		toolCallId = "call-1",
	): Promise<T> {
		const definition = this.tools.get(name);
		if (!definition) throw new Error(`unknown tool: ${name}`);
		const execute = definition.execute as (...params: unknown[]) => Promise<T>;
		return execute(toolCallId, args, undefined, undefined, ctx);
	}

	async command(name: string, args: string, ctx: FakeContext): Promise<void> {
		const definition = this.commands.get(name);
		if (!definition) throw new Error(`unknown command: ${name}`);
		const handler = definition.handler as (args: string, ctx: FakeContext) => Promise<void>;
		await handler(args, ctx);
	}
}

/** A minimal stand-in for pi's ExtensionContext. */
export class FakeContext {
	readonly notifyCalls: Array<{ message: string; type?: string }> = [];
	readonly ui = {
		notify: (message: string, type?: string): void => {
			this.notifyCalls.push({ message, type });
		},
	};
	readonly sessionManager: {
		getEntries: () => BranchEntry[];
		getBranch: () => BranchEntry[];
		getSessionId: () => string;
	};

	constructor(readonly session: FakeSession, readonly hasUI = true) {
		this.sessionManager = {
			getEntries: () => session.getEntries(),
			getBranch: () => session.getBranch(),
			getSessionId: () => "session-test",
		};
	}
}

/** Build a user message. */
export function userEntry(id: string, text = "do the work"): BranchEntry {
	return { type: "message", id, message: { role: "user", content: [{ type: "text", text }] } };
}

/** Build an assistant message issuing the given tool calls. */
export function assistantEntry(
	id: string,
	calls: ReadonlyArray<{ id: string; name: string }>,
	text = "working",
): BranchEntry {
	return {
		type: "message",
		id,
		message: {
			role: "assistant",
			content: [
				{ type: "text", text },
				...calls.map((call) => ({ type: "toolCall", ...call, arguments: {} })),
			],
		},
	};
}

/** Build a tool result. */
export function toolEntry(
	id: string,
	toolName: string,
	details: unknown,
	options: { toolCallId?: string; isError?: boolean } = {},
): BranchEntry {
	return {
		type: "message",
		id,
		message: {
			role: "toolResult",
			toolName,
			toolCallId: options.toolCallId ?? "call-1",
			details,
			isError: options.isError ?? false,
		},
	};
}

/** Build a successful pre_checklist receipt. */
export function preEntry(id: string, receiptId = `pre-${id}`): BranchEntry {
	return toolEntry(id, "pre_checklist", {
		schema: SCHEMA,
		kind: "pre",
		receiptId,
		contractVersion: 1,
	});
}

/** Build a state snapshot for direct ledger tests. */
export function makeState(overrides: Partial<ChecklistState> = {}): ChecklistState {
	return {
		checklistId: "list-1",
		revision: 1,
		title: "Work",
		phase: "open",
		tasks: [
			{ taskId: "task-1", title: "first", status: "pending", note: null },
			{ taskId: "task-2", title: "second", status: "pending", note: null },
		],
		holdReason: null,
		...overrides,
	};
}

/** Build a canonical state transition. */
export function stateEvent(
	id: string,
	operation: StateEvent["operation"],
	previous: ChecklistState | null,
	state: ChecklistState,
	extra: Partial<StateEvent> = {},
): BranchEntry {
	const event: StateEvent = {
		schema: SCHEMA,
		eventId: id,
		operation,
		actor: operation === "complete" ? "gate" : operation === "create" || operation === "add" || operation === "update" ? "model" : "user",
		previousRevision: previous ? previous.revision : null,
		reason: null,
		preReceiptId: operation === "create" ? "pre-pre-1" : null,
		ackReceiptEntryId: operation === "complete" ? "ack-1" : null,
		state,
		...extra,
	};
	return { type: "custom", id, customType: ChecklistContract.STATE_TYPE, data: event };
}

/** Build a successful acknowledgement receipt with its sole-call assistant. */
export function ackPair(
	branch: BranchEntry[],
	checklistId: string,
	revision: number,
	index: number,
	summary = "reviewed",
): void {
	const assistantId = `ack-assistant-${index}`;
	const resultId = `ack-receipt-${index}`;
	const callId = `ack-call-${index}`;
	branch.push(assistantEntry(assistantId, [{ id: callId, name: "checklist" }]));
	branch.push(
		toolEntry(
			resultId,
			"checklist",
			{ schema: SCHEMA, kind: "ack", checklistId, revision, summary },
			{ toolCallId: callId },
		),
	);
}

/** Build a settle audit custom entry. */
export function settleEntry(
	id: string,
	anchorId: string | null,
	checklistId: string,
	revision: number,
	decision: "continue" | "unresolved",
	reason = "unfinished",
): BranchEntry {
	return {
		type: "custom",
		id,
		customType: ChecklistContract.SETTLE_TYPE,
		data: { schema: SCHEMA, eventId: id, anchorId, checklistId, revision, decision, reason },
	};
}

/** Build a boundary event for the settle gate. */
export function boundary(
	outcome: "completed" | "aborted" | "error" = "completed",
	options: { continue?: boolean; canContinue?: boolean; entries?: unknown[] } = {},
): Record<string, unknown> {
	return {
		type: "agent_before_settle",
		entries: options.entries ?? [],
		continue: options.continue ?? false,
		outcome,
		context: { canContinue: options.canContinue ?? false },
	};
}
