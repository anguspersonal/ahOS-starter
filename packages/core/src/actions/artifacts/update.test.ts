import { describe, expect, it, vi } from "vitest";
import { executeAction } from "../adapters/direct.js";
import type { ArtifactPatchedRow, ArtifactPatch } from "../../ports/artifacts.js";
import { createArtifactUpdateAction } from "./update.js";

const ART_ID = "11111111-2222-4333-8444-555555555555";

function patchedRow(overrides: Partial<ArtifactPatchedRow> = {}): ArtifactPatchedRow {
	return {
		id: ART_ID,
		title: "Sample Artifact",
		description: null,
		plain_text: null,
		storage_bucket: "artifacts",
		storage_path: "u/sample.md",
		file_type: "text/markdown",
		routing_decision: null,
		drive_action: null,
		archived: false,
		updated_at: "2026-10-01T00:00:00.000Z",
		...overrides,
	};
}

describe("createArtifactUpdateAction (#1529)", () => {
	it("restores a soft-deleted artifact on archived:false, clearing archive stamps", async () => {
		let receivedPatch: ArtifactPatch | undefined;
		const action = createArtifactUpdateAction({
			patch: vi.fn(async (_id, p) => {
				receivedPatch = p;
				return patchedRow({ archived: false });
			}),
		});

		const out = await executeAction(action, {
			id: ART_ID,
			patch: { archived: false },
		});

		expect(receivedPatch).toMatchObject({
			archived: false,
			archived_at: null,
			archived_reason: null,
		});
		expect(out.updated).toBe(true);
		expect(out.text).toBe(`Updated artifact ${ART_ID}; restored (un-archived).`);
		expect(action.formatMcp?.(out)).toBe(out.text);
	});

	it("stamps archived_at when archiving (archived:true) and renders routing and drive action", async () => {
		let receivedPatch: ArtifactPatch | undefined;
		const action = createArtifactUpdateAction({
			artifacts: {
				patch: vi.fn(async (_id, p) => {
					receivedPatch = p;
					return patchedRow({
						archived: true,
						routing_decision: "move_to_archive",
						drive_action: "move",
					});
				}),
			},
		});

		const out = await executeAction(action, {
			id: ART_ID,
			patch: {
				archived: true,
				routing_decision: "move_to_archive",
				drive_action: "move",
			},
		});

		expect(receivedPatch?.archived).toBe(true);
		expect(typeof receivedPatch?.archived_at).toBe("string");
		expect(out.text).toBe(
			`Updated artifact ${ART_ID} (routing: move_to_archive); drive action: move; archived.`,
		);
	});

	it("returns no-op message when all supplied patch fields are undefined", async () => {
		const patchSpy = vi.fn();
		const action = createArtifactUpdateAction({ patch: patchSpy });

		const out = await executeAction(
			action,
			{ id: ART_ID, patch: { title: undefined } },
			{ skipValidation: true },
		);

		expect(patchSpy).not.toHaveBeenCalled();
		expect(out).toEqual({
			updated: false,
			text: "No fields supplied. Provide at least one artifact field to update.",
		});
	});
});
