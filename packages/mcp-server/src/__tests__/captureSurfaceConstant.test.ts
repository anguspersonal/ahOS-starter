import { describe, expect, it } from "vitest";
import { ARTIFACT_SURFACES as CORE_ARTIFACT_SURFACES, captureInput } from "@ahkms/core";
import { ARTIFACT_SURFACES as SHARED_ARTIFACT_SURFACES } from "@ahkms/shared";

describe("captureInput surface constant inlining parity (issue #1528)", () => {
	it("inlines ARTIFACT_SURFACES.api in captureInput.surface description", () => {
		const description = captureInput.surface.description;
		expect(description).toBeDefined();
		expect(CORE_ARTIFACT_SURFACES.api).toBe(SHARED_ARTIFACT_SURFACES.api);
		expect(description).toContain(`'${CORE_ARTIFACT_SURFACES.api}'`);
	});
});
