/**
 * pi-checklist — extension entry point.
 *
 * Composition only: constructs one instance of each owner and wires the
 * handlers. State is derived from the session branch on every call, so no
 * process, timer, cache, or external file starts here.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { ChecklistCommands } from "./checklist-commands.ts";
import { ChecklistContract } from "./checklist-contract.ts";
import { ChecklistGate } from "./checklist-gate.ts";
import { ChecklistTool } from "./checklist-tool.ts";
import { PreChecklistTool } from "./pre-checklist-tool.ts";
import { ReceiptLedger } from "./receipt-ledger.ts";
import { SessionLifecycle } from "./session-lifecycle.ts";
import { SettleGate } from "./settle-gate.ts";

export class ChecklistExtension {
	register(pi: ExtensionAPI): void {
		const contract = new ChecklistContract();
		const ledger = new ReceiptLedger(pi);
		new PreChecklistTool(ledger, contract).register(pi);
		new ChecklistTool(ledger, contract).register(pi);
		new ChecklistGate(ledger, contract).register(pi);
		new SettleGate(ledger, contract).register(pi);
		new SessionLifecycle(pi, ledger, contract).register();
		new ChecklistCommands(pi, ledger, contract).register();
	}
}

export default function (pi: ExtensionAPI): void {
	new ChecklistExtension().register(pi);
}
