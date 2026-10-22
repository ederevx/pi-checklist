/**
 * pi-checklist — test runner entry.
 *
 * Run from the repo root:
 *
 *   node --experimental-strip-types --experimental-transform-types tests/run.ts
 *
 * The OOP/format lint runs first, then the unit suite.
 */

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cleanupScratch, registry } from "./harness.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

try {
	execFileSync("python3", ["tests/oop_lint.py"], { cwd: repoRoot, stdio: "inherit" });
} catch {
	console.error("oop lint: FAILED");
	process.exit(1);
}

import "./contract.test.ts";
import "./receipt-ledger.test.ts";

await registry.runAll();
cleanupScratch();
if (registry.failed > 0) process.exit(1);
