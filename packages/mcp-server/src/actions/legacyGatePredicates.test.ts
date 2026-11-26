import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateGate, isPendingApproval, setActionApprovalStore } from "@ahkms/core";
import { LEGACY_GATES } from "./legacyGates.js";

async function isGated(actionId: string, input: unknown): Promise<boolean> {
	try {
		await evaluateGate({ actionId, needsApproval: LEGACY_GATES[actionId], input, ctx: { caller: "mcp", requestId: "req-1" } });
		return false;
	} catch (err) {
		if (isPendingApproval(err)) return true;
		throw err;
	}
}

beforeEach(() => {
	setActionApprovalStore({ park: async () => ({ decisionId: "dec-1" }) });
});
afterEach(() => {
	setActionApprovalStore(undefined);
	vi.restoreAllMocks();
});

describe("LEGACY_GATES predicates (#1426)", () => {
	it("1. gmail_send_draft moved onto core action needsApproval (#1578)", () => {
		expect("gmail_send_draft" in LEGACY_GATES).toBe(false);
	});

	it("2. drive_share (#1505) and drive_import_file (#1613) moved to core needsApproval and are absent from LEGACY_GATES", () => {
		expect("drive_import_file" in LEGACY_GATES).toBe(false);
		expect("drive_share" in LEGACY_GATES).toBe(false);
	});

	it("3. calendar_delete_event moved onto core action needsApproval (#1585)", () => {
		expect("calendar_delete_event" in LEGACY_GATES).toBe(false);
	});
});
