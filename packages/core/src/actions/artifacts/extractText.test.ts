import { describe, expect, it, vi } from "vitest";
import { OFFICE_OPEN_XML_MIMES } from "../../domain/extract/office.js";
import type { ArtifactRow } from "../../ports/artifacts.js";
import {
	classifyArtifactForExtraction,
	createArtifactExtractTextAction,
	formatArtifactExtractTextMcp,
} from "./extractText.js";

const ARTIFACT_ID = "11111111-2222-3333-4444-555555555555";

function buildStoredZipBuffer(entries: { name: string; content: string }[]): Uint8Array {
	const encoder = new TextEncoder();
	const chunks: Uint8Array[] = [];
	let totalLength = 0;
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
		totalLength += record.byteLength;
	}
	const out = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

function makeArtifact(overrides: Partial<ArtifactRow> = {}): ArtifactRow {
	return {
		id: ARTIFACT_ID,
		title: "Sample Doc",
		description: null,
		plain_text: null,
		tags: [],
		lifecycle_stage: "uploaded",
		source: null,
		source_url: null,
		source_channel: "mcp",
		surface: "claude_code",
		trust_override: null,
		source_drive_file_id: null,
		source_parent_folder_ids: null,
		source_parent_folder_path: null,
		routing_decision: null,
		routing_confidence: null,
		routing_reason: null,
		drive_action: null,
		drive_action_at: null,
		created_at: "2026-10-01T00:00:00.000Z",
		storage_bucket: "user-uploads",
		storage_path: "uploads/sample.pdf",
		storage_url: "https://example.supabase.co/storage/v1/object/public/user-uploads/uploads/sample.pdf",
		file_type: "application/pdf",
		...overrides,
	};
}

describe("artifact_extract_text core action (#1616)", () => {
	it("returns missing-artifact message when getById returns null", async () => {
		const action = createArtifactExtractTextAction({
			artifacts: {
				getById: vi.fn().mockResolvedValue(null),
				saveExtractedText: vi.fn(),
			},
			storage: { download: vi.fn() },
			extraction: { extract: vi.fn() },
		});

		const result = await action.run(
			{ artifact_id: ARTIFACT_ID },
			{ caller: "mcp", requestId: "req-1" },
		);

		expect(result.status).toBe("not_found");
		expect(formatArtifactExtractTextMcp(result)).toBe(`No artifact ${ARTIFACT_ID}.`);
	});

	it("stores plain-text files directly without calling the extraction model", async () => {
		const saveExtractedText = vi.fn().mockResolvedValue(undefined);
		const extract = vi.fn();
		const summarize = vi.fn().mockResolvedValue({ summary: "Text summary" });
		const embedArtifact = vi.fn().mockResolvedValue(undefined);

		const action = createArtifactExtractTextAction({
			artifacts: {
				getById: vi.fn().mockResolvedValue(
					makeArtifact({
						storage_path: "uploads/notes.md",
						file_type: "text/markdown",
					}),
				),
				saveExtractedText,
			},
			storage: {
				download: vi.fn().mockResolvedValue(new TextEncoder().encode("Hello markdown")),
			},
			extraction: { extract, summarize },
			embedArtifact,
		});

		const result = await action.run(
			{ artifact_id: ARTIFACT_ID },
			{ caller: "mcp", requestId: "req-2" },
		);

		expect(extract).not.toHaveBeenCalled();
		expect(saveExtractedText).toHaveBeenCalledWith(ARTIFACT_ID, {
			extracted_content: "Hello markdown",
			plain_text: "Hello markdown",
			description: "Text summary",
			processing_status: "completed",
		});
		expect(embedArtifact).toHaveBeenCalledWith(ARTIFACT_ID, {
			title: "Sample Doc",
			description: "Text summary",
			plain_text: "Hello markdown",
		});
		expect(formatArtifactExtractTextMcp(result)).toBe(
			"Stored 14 chars from text file (no extraction needed).",
		);
	});

	it("extracts Office Open XML (.docx) documents without calling the extraction model", async () => {
		const saveExtractedText = vi.fn().mockResolvedValue(undefined);
		const extract = vi.fn();
		const docxBytes = buildStoredZipBuffer([
			{
				name: "word/document.xml",
				content: `<w:document><w:body><w:p><w:r><w:t>Extracted Word body</w:t></w:r></w:p></w:body></w:document>`,
			},
		]);

		const action = createArtifactExtractTextAction({
			artifacts: {
				getById: vi.fn().mockResolvedValue(
					makeArtifact({
						description: "Existing summary",
						storage_path: "uploads/memo.docx",
						file_type: OFFICE_OPEN_XML_MIMES.docx,
					}),
				),
				saveExtractedText,
			},
			storage: {
				download: vi.fn().mockResolvedValue(docxBytes),
			},
			extraction: { extract },
		});

		const result = await action.run(
			{ artifact_id: ARTIFACT_ID },
			{ caller: "mcp", requestId: "req-3" },
		);

		expect(extract).not.toHaveBeenCalled();
		expect(saveExtractedText).toHaveBeenCalledWith(ARTIFACT_ID, {
			extracted_content: "Extracted Word body",
			plain_text: "Extracted Word body",
			description: "Existing summary",
			processing_status: "completed",
		});
		expect(formatArtifactExtractTextMcp(result)).toBe(
			"Extracted 19 chars from docx document.",
		);
	});

	it("refuses unsupported image types before any model call", async () => {
		const extract = vi.fn();
		const download = vi.fn();

		const action = createArtifactExtractTextAction({
			artifacts: {
				getById: vi.fn().mockResolvedValue(
					makeArtifact({
						storage_path: "uploads/diagram.svg",
						file_type: "image/svg+xml",
					}),
				),
				saveExtractedText: vi.fn(),
			},
			storage: { download },
			extraction: { extract },
		});

		const result = await action.run(
			{ artifact_id: ARTIFACT_ID },
			{ caller: "mcp", requestId: "req-4" },
		);

		expect(extract).not.toHaveBeenCalled();
		expect(download).not.toHaveBeenCalled();
		expect(formatArtifactExtractTextMcp(result)).toBe(
			"Unsupported file type for extraction: image/svg+xml.",
		);
	});

	it("calls extraction port for PDF/image and appends truncation warning when truncated=true", async () => {
		const saveExtractedText = vi.fn().mockResolvedValue(undefined);
		const extract = vi.fn().mockResolvedValue({
			text: "Transcribed PDF text",
			model: "claude-opus-4-7",
			truncated: true,
		});

		const action = createArtifactExtractTextAction({
			artifacts: {
				getById: vi.fn().mockResolvedValue(
					makeArtifact({
						description: "Already described",
						storage_path: "uploads/report.pdf",
						file_type: "application/pdf",
					}),
				),
				saveExtractedText,
			},
			storage: {
				download: vi.fn().mockResolvedValue(new TextEncoder().encode("%PDF-1.4")),
			},
			extraction: { extract },
		});

		const result = await action.run(
			{ artifact_id: ARTIFACT_ID },
			{ caller: "mcp", requestId: "req-5" },
		);

		expect(extract).toHaveBeenCalledTimes(1);
		expect(formatArtifactExtractTextMcp(result)).toBe(
			"Extracted 20 chars from pdf (model: claude-opus-4-7). ⚠️ Output hit max_tokens : document may be truncated.",
		);
	});

	it("classifyArtifactForExtraction classifies pdf, office, supported images, text, and unknown", () => {
		expect(classifyArtifactForExtraction("application/pdf", "a/b.bin")).toEqual({ kind: "pdf" });
		expect(classifyArtifactForExtraction("image/png", "a/b.png")).toEqual({
			kind: "image",
			mediaType: "image/png",
		});
		expect(classifyArtifactForExtraction("image/heic", "a/b.heic")).toEqual({ kind: "unknown" });
		expect(classifyArtifactForExtraction("text/plain", "a/b.txt")).toEqual({ kind: "text" });
	});
});
