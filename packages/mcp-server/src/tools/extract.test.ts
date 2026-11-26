import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OFFICE_OPEN_XML_MIMES } from "@ahkms/core";
import { supabase } from "../supabase.js";

const embedAndStore = vi.fn(async () => undefined);
const generateL2Summary = vi.fn(async () => ({ summary: "Generated short summary" }));
const extractDocumentTextWithGemini = vi.fn();
const anthropicCreate = vi.fn();

vi.mock("../identity.js", () => ({
	getCurrentUserId: () => "00000000-0000-0000-0000-000000000001",
}));

vi.mock("../embeddings.js", () => ({
	embedAndStore: (...args: unknown[]) => embedAndStore(...(args as [])),
}));

vi.mock("./enrich/summary.js", () => ({
	generateL2Summary: (...args: unknown[]) => generateL2Summary(...(args as [])),
}));

vi.mock("@ahkms/core/adapters", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ahkms/core/adapters")>();
	return {
		...actual,
		extractDocumentTextWithGemini: (...args: unknown[]) =>
			extractDocumentTextWithGemini(...(args as [])),
	};
});

vi.mock("../anthropic.js", () => ({
	getAnthropic: () => ({
		messages: {
			create: (...args: unknown[]) => anthropicCreate(...(args as [])),
		},
	}),
}));

const { extractTextHandler } = await import("./extract.js");

const origFrom = supabase.from;
const origStorageFrom = supabase.storage.from;

function buildStoredZipBuffer(entries: { name: string; content: string }[]): Buffer {
	const encoder = new TextEncoder();
	const chunks: Uint8Array[] = [];
	for (const entry of entries) {
		const nameBytes = encoder.encode(entry.name);
		const dataBytes = encoder.encode(entry.content);
		const record = new Uint8Array(30 + nameBytes.byteLength + dataBytes.byteLength);
		const view = new DataView(record.buffer);
		view.setUint32(0, 0x04034b50, true);
		view.setUint16(4, 20, true);
		view.setUint16(8, 0, true);
		view.setUint32(18, dataBytes.byteLength, true);
		view.setUint32(22, dataBytes.byteLength, true);
		view.setUint16(26, nameBytes.byteLength, true);
		record.set(nameBytes, 30);
		record.set(dataBytes, 30 + nameBytes.byteLength);
		chunks.push(record);
	}
	return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	(supabase as unknown as { from: typeof origFrom }).from = origFrom;
	(supabase.storage as unknown as { from: typeof origStorageFrom }).from = origStorageFrom;
});

describe("extractTextHandler Office Open XML support (#2084)", () => {
	it("extracts .docx, .xlsx, and .pptx artifacts directly without calling vision models", async () => {
		const artifactId = "11111111-2222-3333-4444-555555555555";
		const docxBytes = buildStoredZipBuffer([
			{
				name: "word/document.xml",
				content: `<w:document><w:body><w:p><w:r><w:t>Extracted Word body</w:t></w:r></w:p></w:body></w:document>`,
			},
		]);

		const updatePayloads: Record<string, unknown>[] = [];
		(supabase as unknown as { from: unknown }).from = vi.fn(() => ({
			select: () => ({
				eq: () => ({
					eq: () => ({
						maybeSingle: async () => ({
							data: {
								id: artifactId,
								title: "Board Memo",
								description: null,
								storage_bucket: "user-uploads",
								storage_path: "uploads/memo.docx",
								storage_url: null,
								file_type: OFFICE_OPEN_XML_MIMES.docx,
							},
							error: null,
						}),
					}),
				}),
			}),
			update: (payload: Record<string, unknown>) => {
				updatePayloads.push(payload);
				return {
					eq: () => ({
						eq: () => ({
							select: async () => ({ data: [{ id: artifactId }], error: null }),
						}),
					}),
				};
			},
		}));

		(supabase.storage as unknown as { from: unknown }).from = vi.fn(() => ({
			download: async () => ({
				data: {
					arrayBuffer: async () =>
						docxBytes.buffer.slice(
							docxBytes.byteOffset,
							docxBytes.byteOffset + docxBytes.byteLength,
						),
				},
				error: null,
			}),
		}));

		const result = await extractTextHandler({ artifact_id: artifactId });

		expect(result.content[0]?.text).toBe("Extracted 19 chars from docx document.");
		expect(updatePayloads).toHaveLength(1);
		expect(updatePayloads[0]).toEqual({
			extracted_content: "Extracted Word body",
			plain_text: "Extracted Word body",
			description: "Generated short summary",
			processing_status: "completed",
		});
		expect(embedAndStore).toHaveBeenCalledWith("artifacts", artifactId, {
			title: "Board Memo",
			description: "Generated short summary",
			plain_text: "Extracted Word body",
		});
		expect(extractDocumentTextWithGemini).not.toHaveBeenCalled();
		expect(anthropicCreate).not.toHaveBeenCalled();
	});

	it("classifies .xlsx by storage_path extension when file_type is application/octet-stream", async () => {
		const artifactId = "22222222-3333-4444-5555-666666666666";
		const xlsxBytes = buildStoredZipBuffer([
			{
				name: "xl/workbook.xml",
				content: `<workbook><sheets><sheet name="KPIs" sheetId="1" r:id="rId1"/></sheets></workbook>`,
			},
			{
				name: "xl/worksheets/sheet1.xml",
				content: `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Active Users</t></is></c></row></sheetData></worksheet>`,
			},
		]);

		let storedText = "";
		(supabase as unknown as { from: unknown }).from = vi.fn(() => ({
			select: () => ({
				eq: () => ({
					eq: () => ({
						maybeSingle: async () => ({
							data: {
								id: artifactId,
								title: "KPI Sheet",
								description: "Existing summary",
								storage_bucket: "user-uploads",
								storage_path: "uploads/kpis.xlsx",
								storage_url: null,
								file_type: "application/octet-stream",
							},
							error: null,
						}),
					}),
				}),
			}),
			update: (payload: Record<string, unknown>) => {
				storedText = String(payload.plain_text ?? "");
				return {
					eq: () => ({
						eq: () => ({
							select: async () => ({ data: [{ id: artifactId }], error: null }),
						}),
					}),
				};
			},
		}));

		(supabase.storage as unknown as { from: unknown }).from = vi.fn(() => ({
			download: async () => ({
				data: {
					arrayBuffer: async () =>
						xlsxBytes.buffer.slice(
							xlsxBytes.byteOffset,
							xlsxBytes.byteOffset + xlsxBytes.byteLength,
						),
				},
				error: null,
			}),
		}));

		const result = await extractTextHandler({ artifact_id: artifactId });

		expect(result.content[0]?.text).toContain("from xlsx document.");
		expect(storedText).toContain("## KPIs");
		expect(storedText).toContain("| Active Users |");
	});
});
