import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import {
	createArtifactExtractTextAction,
	formatArtifactExtractTextMcp,
	OFFICE_OPEN_XML_MIMES,
} from "@ahkms/core";
import { buildRegistry } from "@ahkms/core/actions";
import manifest from "@ahkms/core/action-manifest.json" with { type: "json" };
import { createServer } from "../server.js";
import { readLegacyBaseline } from "./legacyBaseline.js";


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

describe("artifact_extract_text action registration and MCP parity (#1616)", () => {
	it("1. Contract parity: artifact_extract_text MCP tool preserves inputSchema.properties, required, annotations, and description", async () => {
		const server = createServer();
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "test-extract-text", version: "0" }, { capabilities: {} });
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
		const { tools } = await client.listTools();
		await client.close();

		const tool = tools.find((t) => t.name === "artifact_extract_text");
		expect(tool).toBeDefined();
		expect(tool!.description).toBe(
			"Extract text from a captured PDF or image artifact into its searchable content. Run after capturing a file so it shows up in knowledge_search.",
		);

		const props = (tool!.inputSchema.properties ?? {}) as Record<string, { type?: string }>;
		expect(Object.keys(props)).toEqual(["artifact_id"]);
		expect(props.artifact_id.type).toBe("string");
		expect(tool!.inputSchema.required).toEqual(["artifact_id"]);

		expect(tool!.annotations).toMatchObject({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
	});

	it("2. Exposure: artifact_extract_text is in action-manifest.json with mcp, http, ui_agent, worker true and cli, a2a false", () => {
		const entry = (manifest.actions as Record<string, any>).artifact_extract_text;
		expect(entry).toBeDefined();
		expect(entry.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
	});

	it("3. Registration path: artifact_extract_text is in buildRegistry({}) and absent from legacy-tools-baseline.txt", () => {
		const ids = buildRegistry({}).list().map((a) => a.id);
		expect(ids).toContain("artifact_extract_text");

		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("artifact_extract_text");
	});

	it("4. Plain-text and Office Open XML are stored without model call; unsupported image refused before any call; max_tokens stop adds warning", async () => {
		const artifactId = "11111111-2222-3333-4444-555555555555";
		const extract = vi.fn();

		// Plain text
		const textAction = createArtifactExtractTextAction({
			artifacts: {
				getById: vi.fn().mockResolvedValue({
					id: artifactId,
					title: "Notes",
					description: "Existing",
					storage_bucket: "user-uploads",
					storage_path: "uploads/notes.txt",
					storage_url: null,
					file_type: "text/plain",
				} as any),
				saveExtractedText: vi.fn().mockResolvedValue(undefined),
			},
			storage: {
				download: vi.fn().mockResolvedValue(new TextEncoder().encode("Plain body")),
			},
			extraction: { extract },
		});
		const textRes = await textAction.run(
			{ artifact_id: artifactId },
			{ caller: "mcp", requestId: "r1" },
		);
		expect(extract).not.toHaveBeenCalled();
		expect(formatArtifactExtractTextMcp(textRes)).toBe(
			"Stored 10 chars from text file (no extraction needed).",
		);

		// Office Open XML (.docx)
		const docxBytes = buildStoredZipBuffer([
			{
				name: "word/document.xml",
				content: `<w:document><w:body><w:p><w:r><w:t>Hello docx</w:t></w:r></w:p></w:body></w:document>`,
			},
		]);
		const officeAction = createArtifactExtractTextAction({
			artifacts: {
				getById: vi.fn().mockResolvedValue({
					id: artifactId,
					title: "Docx",
					description: "Existing",
					storage_bucket: "user-uploads",
					storage_path: "uploads/doc.docx",
					storage_url: null,
					file_type: OFFICE_OPEN_XML_MIMES.docx,
				} as any),
				saveExtractedText: vi.fn().mockResolvedValue(undefined),
			},
			storage: {
				download: vi.fn().mockResolvedValue(docxBytes),
			},
			extraction: { extract },
		});
		const officeRes = await officeAction.run(
			{ artifact_id: artifactId },
			{ caller: "mcp", requestId: "r2" },
		);
		expect(extract).not.toHaveBeenCalled();
		expect(formatArtifactExtractTextMcp(officeRes)).toBe(
			"Extracted 10 chars from docx document.",
		);

		// Unsupported image type refused before any call
		const downloadUnsupported = vi.fn();
		const unsupportedAction = createArtifactExtractTextAction({
			artifacts: {
				getById: vi.fn().mockResolvedValue({
					id: artifactId,
					title: "Photo",
					description: null,
					storage_bucket: "user-uploads",
					storage_path: "uploads/photo.heic",
					storage_url: null,
					file_type: "image/heic",
				} as any),
				saveExtractedText: vi.fn(),
			},
			storage: { download: downloadUnsupported },
			extraction: { extract },
		});
		const unsupportedRes = await unsupportedAction.run(
			{ artifact_id: artifactId },
			{ caller: "mcp", requestId: "r3" },
		);
		expect(downloadUnsupported).not.toHaveBeenCalled();
		expect(extract).not.toHaveBeenCalled();
		expect(formatArtifactExtractTextMcp(unsupportedRes)).toBe(
			"Unsupported file type for extraction: image/heic.",
		);

		// max_tokens truncation warning
		const pdfAction = createArtifactExtractTextAction({
			artifacts: {
				getById: vi.fn().mockResolvedValue({
					id: artifactId,
					title: "Long PDF",
					description: "Summary",
					storage_bucket: "user-uploads",
					storage_path: "uploads/long.pdf",
					storage_url: null,
					file_type: "application/pdf",
				} as any),
				saveExtractedText: vi.fn().mockResolvedValue(undefined),
			},
			storage: {
				download: vi.fn().mockResolvedValue(new TextEncoder().encode("%PDF-1.4")),
			},
			extraction: {
				extract: vi.fn().mockResolvedValue({
					text: "Truncated content",
					model: "claude-opus-4-7",
					truncated: true,
				}),
			},
		});
		const pdfRes = await pdfAction.run(
			{ artifact_id: artifactId },
			{ caller: "mcp", requestId: "r4" },
		);
		expect(formatArtifactExtractTextMcp(pdfRes)).toBe(
			"Extracted 17 chars from pdf (model: claude-opus-4-7). ⚠️ Output hit max_tokens : document may be truncated.",
		);
	});
});
