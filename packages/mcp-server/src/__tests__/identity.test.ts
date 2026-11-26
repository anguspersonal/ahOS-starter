/**
 * The owner-identity accessor (#503 / ADR-045) is deliberately a one-line
 * passthrough today — this test pins that contract so the eventual per-request
 * implementation swap is caught as an intentional change, not an accident.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../env.js", () => ({
	env: { userId: "11111111-2222-3333-4444-555555555555" },
}));

import { getCurrentUserId } from "../identity.js";

describe("getCurrentUserId", () => {
	it("returns env.userId verbatim (single-owner passthrough)", () => {
		expect(getCurrentUserId()).toBe("11111111-2222-3333-4444-555555555555");
	});
});
