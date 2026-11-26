import { describe, expect, it, vi } from "vitest";
import { executeAction } from "../adapters/direct.js";
import { createArtifactDeleteAction } from "./delete.js";

const ART_ID_1 = "11111111-2222-4333-8444-555555555555";
const ART_ID_2 = "22222222-2222-4333-8444-555555555555";

describe("createArtifactDeleteAction (#1529)", () => {
	it("soft-deletes (archives) by default when archive_only is omitted", async () => {
		const mutateByIds = vi.fn(async () => [{ id: ART_ID_1, title: "Some Artifact" }]);
		const action = createArtifactDeleteAction({ mutateByIds });

		const out = await executeAction(action, { ids: [ART_ID_1] });

		expect(mutateByIds).toHaveBeenCalledWith([ART_ID_1], true, undefined);
		expect(out.archive_only).toBe(true);
		expect(out.text).toBe(`Archived 1 artifact: [${ART_ID_1}] Some Artifact.`);
		expect(action.formatMcp?.(out)).toBe(out.text);
	});

	it("passes archive_only: false and formats plural deleted rows with untitled fallback", async () => {
		const mutateByIds = vi.fn(async () => [
			{ id: ART_ID_1, title: "First" },
			{ id: ART_ID_2, title: null },
		]);
		const action = createArtifactDeleteAction({
			artifacts: { mutateByIds },
		});

		const out = await executeAction(action, {
			ids: [ART_ID_1, ART_ID_2],
			archive_only: false,
		});

		expect(mutateByIds).toHaveBeenCalledWith([ART_ID_1, ART_ID_2], false, undefined);
		expect(out.archive_only).toBe(false);
		expect(out.text).toBe(
			`Deleted 2 artifacts: [${ART_ID_1}] First, [${ART_ID_2}] (untitled).`,
		);
	});
});
