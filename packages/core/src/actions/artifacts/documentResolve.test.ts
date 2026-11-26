import { describe, expect, it, vi } from "vitest";
import { executeAction } from "../adapters/direct.js";
import {
	createDocumentResolveAction,
	DOCUMENT_RESOLVE_DESCRIPTION,
	documentResolveInput,
	documentResolveSchema,
	formatDocumentResolveMcp,
	matchTrackedDocument,
	titleSearchTerms,
	type DocumentResolvePorts,
} from "./documentResolve.js";
import type { DocumentResolveArtifactRow } from "../../ports/artifacts.js";
import type { TrackedEntityRow } from "../../ports/entities.js";

const ENTITY_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const D6 = "00000000-0000-4000-8000-0000000000d6";
const D1 = "00000000-0000-4000-8000-0000000000d1";
const D2 = "00000000-0000-4000-8000-0000000000d2";
const R1 = "00000000-0000-4000-8000-0000000000e1";

function docRow(
	id: string,
	overrides: Partial<DocumentResolveArtifactRow> = {},
	disc: Record<string, unknown> = {},
): DocumentResolveArtifactRow {
	return {
		id,
		title: `Doc ${id}`,
		storage_bucket: "external",
		storage_url: `https://drive.google.com/file/d/${id}/view`,
		source_url: null,
		source: id,
		source_channel: "discovered_gdrive",
		surface: "discovered_gdrive",
		file_type: null,
		archived: false,
		archived_reason: null,
		lifecycle_stage: "discovered",
		processing_metadata: {
			discovery: {
				connector: "gdrive",
				url: `https://drive.google.com/file/d/${id}/view`,
				source_modified_at: "2025-01-01T00:00:00.000Z",
				...disc,
			},
		},
		...overrides,
	};
}

const CV_ENTITY: TrackedEntityRow = {
	id: ENTITY_ID,
	title: "CV - Angus Hally",
	aliases: ["CV", "curriculum vitae"],
	archived: false,
	properties: {
		tracked: true,
		doc_kind: "cv",
		canonical_artifact_id: D6,
		canonical_url: `https://drive.google.com/file/d/${D6}/view?usp=sharing`,
		canonical_set_at: "2026-09-29T10:00:00.000Z",
		canonical_set_by: "owner",
		renditions: [
			{
				format: "docx",
				artifact_id: R1,
				url: `https://drive.google.com/file/d/${R1}/view`,
			},
		],
	},
};

function makePorts(overrides: Partial<DocumentResolvePorts> = {}): DocumentResolvePorts {
	const docs = new Map<string, DocumentResolveArtifactRow>([
		[
			D6,
			docRow(
				D6,
				{ title: "Angus Hally CV Jun 24.pdf" },
				{ source_modified_at: "2026-09-11T09:00:00.000Z", mime_type: "application/pdf" },
			),
		],
		[
			D1,
			docRow(
				D1,
				{ title: "Angus Hally CV.pdf" },
				{ source_modified_at: "2025-05-13T10:00:00.000Z" },
			),
		],
		[
			D2,
			docRow(D2, {
				title: "Angus Hally CV Feb 23.docx",
				archived: true,
				archived_reason: "superseded:d6",
			}),
		],
		[
			R1,
			docRow(
				R1,
				{ title: "Angus Hally CV Jun 24.docx" },
				{ source_modified_at: "2026-09-11T09:05:00.000Z" },
			),
		],
	]);

	return {
		entities: {
			findTrackedResources: vi.fn().mockResolvedValue([CV_ENTITY]),
			getTitleById: vi.fn().mockResolvedValue(null),
			...overrides.entities,
		},
		artifacts: {
			getDocumentsByIds: vi.fn(async (ids: readonly string[]) => {
				const out = new Map<string, DocumentResolveArtifactRow>();
				for (const id of ids) {
					const found = docs.get(id);
					if (found) out.set(id, found);
				}
				return out;
			}),
			getPrimaryLinksForEntities: vi
				.fn()
				.mockResolvedValue(new Map([[ENTITY_ID, [D6, D1, D2, R1]]])),
			searchDocumentTitleCandidates: vi.fn().mockResolvedValue([]),
			...overrides.artifacts,
		},
	};
}

describe("document_resolve core action (#1622)", () => {
	it("exposes exact contract metadata, schema keys, and annotations", () => {
		const action = createDocumentResolveAction(makePorts());
		expect(action.id).toBe("document_resolve");
		expect(action.domain).toBe("artifacts");
		expect(action.description).toBe(DOCUMENT_RESOLVE_DESCRIPTION);
		expect(Object.keys(documentResolveInput)).toEqual([
			"query",
			"entity_id",
			"doc_kind",
			"include_archived",
			"limit",
		]);
		expect(Object.keys(documentResolveSchema.shape)).toEqual([
			"query",
			"entity_id",
			"doc_kind",
			"include_archived",
			"limit",
		]);
		expect(action.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
	});

	it("refuses when none of query, entity_id, or doc_kind is given", async () => {
		const action = createDocumentResolveAction(makePorts());
		await expect(
			executeAction(action, {}, { context: { caller: "mcp", requestId: "r1", userId: "u1" } }),
		).rejects.toThrow("document_resolve: provide at least one of query, entity_id, doc_kind.");
	});

	it("resolves a tracked document over the entity and artifact ports", async () => {
		const ports = makePorts();
		const action = createDocumentResolveAction(ports);
		const result = await executeAction(
			action,
			{ query: "CV" },
			{ context: { caller: "mcp", requestId: "r1", userId: "owner-1" } },
		);
		const text = formatDocumentResolveMcp(result);

		expect(ports.entities.findTrackedResources).toHaveBeenCalledWith(
			{ entity_id: undefined, include_archived: undefined, limit: 501 },
			"owner-1",
		);
		expect(ports.artifacts.getPrimaryLinksForEntities).toHaveBeenCalledWith([ENTITY_ID]);
		expect(text).toContain("1 tracked document(s) match.");
		expect(text).toContain("## CV - Angus Hally");
		expect(text).toContain(`Canonical: [${D6}] Angus Hally CV Jun 24.pdf`);
		expect(text).toContain("(1 archived version(s) hidden; pass include_archived: true to list them)");
	});

	it("falls back to untracked candidate title search and looks up entity title when only entity_id is given", async () => {
		const ports = makePorts({
			entities: {
				findTrackedResources: vi.fn().mockResolvedValue([]),
				getTitleById: vi.fn().mockResolvedValue("Tenancy agreement"),
			},
			artifacts: {
				getDocumentsByIds: vi.fn().mockResolvedValue(new Map()),
				getPrimaryLinksForEntities: vi.fn().mockResolvedValue(new Map()),
				searchDocumentTitleCandidates: vi
					.fn()
					.mockResolvedValue([docRow("t1", { title: "Tenancy agreement 2024.pdf" })]),
			},
		});
		const action = createDocumentResolveAction(ports);
		const result = await executeAction(
			action,
			{ entity_id: ENTITY_ID },
			{ context: { caller: "mcp", requestId: "r2", userId: "owner-1" } },
		);

		expect(ports.entities.getTitleById).toHaveBeenCalledWith(ENTITY_ID, "owner-1");
		expect(ports.artifacts.searchDocumentTitleCandidates).toHaveBeenCalledWith(
			["tenancy", "agreement"],
			11,
			"owner-1",
		);
		expect(result.text).toContain(`No tracked document matches "${ENTITY_ID}".`);
		expect(result.text).toContain("[t1] Tenancy agreement 2024.pdf");
	});

	it("exports pure helpers matchTrackedDocument and titleSearchTerms", () => {
		expect(titleSearchTerms("get my latest CV")).toEqual(["cv"]);
		expect(
			matchTrackedDocument(
				{ title: "CV - Angus Hally", aliases: ["CV"], properties: { doc_kind: "cv" } },
				{ query: "cv" },
			),
		).toEqual({ match: true, exact: true });
	});
});
