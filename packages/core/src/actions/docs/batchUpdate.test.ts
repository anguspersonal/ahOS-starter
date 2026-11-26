import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AdapterUnavailableError, buildRegistry } from "../buildRegistry.js";
import { executeAction } from "../adapters/direct.js";
import type { ActionContext } from "../types.js";
import type { DocsPort } from "../../ports/docs.js";
import type { ArtifactRepository } from "../../ports/artifacts.js";
import {
	createDocsBatchUpdateAction,
	formatDocsBatchUpdateMcp,
} from "./batchUpdate.js";

const ctx: ActionContext = {
	caller: "mcp",
	userId: "00000000-0000-0000-0000-000000000001",
	requestId: "req-docs-batch-update-test",
};

function makeMockPorts(overrides: {
	docs?: Partial<DocsPort>;
	artifacts?: Partial<ArtifactRepository>;
} = {}) {
	const docs: DocsPort = {
		getDocument: vi.fn(),
		batchUpdate: vi.fn().mockResolvedValue({
			documentId: "doc-123",
			writeControl: { requiredRevisionId: "rev-new" },
			replies: [{ insertText: {} }],
		}),
		...overrides.docs,
	};
	const artifacts: Pick<ArtifactRepository, "appendDocEditAudit"> = {
		appendDocEditAudit: vi.fn().mockResolvedValue(undefined),
		...overrides.artifacts,
	};
	return { docs, artifacts };
}

describe("createDocsBatchUpdateAction (#1521)", () => {
	it("1. matches dev contract (id, domain, description, annotations, schema keys and required list)", () => {
		const ports = makeMockPorts();
		const action = createDocsBatchUpdateAction(ports);

		expect(action.id).toBe("docs_batch_update");
		expect(action.domain).toBe("integrations");
		expect(action.description).toBe(
			"Apply in-place structural updates to a Google Doc (insertText, deleteContentRange, replaceAllText, insertTable, etc.). Requires required_revision_id from docs_get. Full notes: docs/guides/tools/docs_batch_update.md",
		);
		expect(action.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true,
		});
		expect(action.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});

		const jsonSchema = z.toJSONSchema(action.schema) as {
			properties: Record<string, { type?: string; enum?: unknown[] }>;
			required?: string[];
		};
		expect(Object.keys(jsonSchema.properties)).toEqual([
			"document_id",
			"domain",
			"account",
			"required_revision_id",
			"requests",
			"suggest",
		]);
		expect(jsonSchema.required).toEqual([
			"document_id",
			"domain",
			"required_revision_id",
			"requests",
		]);
		expect(jsonSchema.properties.document_id.type).toBe("string");
		expect(jsonSchema.properties.domain.enum).toEqual(["work", "angus"]);
		expect(jsonSchema.properties.account.enum).toEqual(["personal", "work"]);
		expect(jsonSchema.properties.required_revision_id.type).toBe("string");
		expect(jsonSchema.properties.requests.type).toBe("array");
		expect(jsonSchema.properties.suggest.type).toBe("boolean");
	});

	it("2. refuses blank required_revision_id before any request and rejects domain/account conflicts", async () => {
		const ports = makeMockPorts();
		const action = createDocsBatchUpdateAction(ports);

		await expect(
			executeAction(
				action,
				{
					document_id: "doc-123",
					domain: "angus",
					required_revision_id: "   ",
					requests: [{ insertText: { text: "hi", location: { index: 1 } } }],
				},
				{ context: ctx },
			),
		).rejects.toThrow(
			"required_revision_id is required for docs_batch_update. Read the document first with docs_get to obtain its current revisionId, and pass it here to guarantee your edits do not overwrite concurrent changes.",
		);
		expect(ports.docs.batchUpdate).not.toHaveBeenCalled();

		await expect(
			executeAction(
				action,
				{
					document_id: "doc-123",
					domain: "work",
					account: "personal",
					required_revision_id: "rev-1",
					requests: [{ insertText: { text: "hi", location: { index: 1 } } }],
				},
				{ context: ctx },
			),
		).rejects.toThrow(/name different domains/);
		expect(ports.docs.batchUpdate).not.toHaveBeenCalled();
	});

	it("3. sends writeControl.requiredRevisionId, formats replies, and appends one docs_edit_audit entry", async () => {
		const ports = makeMockPorts();
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const action = createDocsBatchUpdateAction(ports);
			const out = await executeAction(
				action,
				{
					document_id: "doc-123",
					domain: "angus",
					required_revision_id: "rev-old",
					requests: [{ insertText: { text: "new text", location: { index: 1 } } }],
				},
				{ context: ctx },
			);

			expect(ports.docs.batchUpdate).toHaveBeenCalledWith({
				domain: "angus",
				documentId: "doc-123",
				requests: [{ insertText: { text: "new text", location: { index: 1 } } }],
				writeControl: { requiredRevisionId: "rev-old" },
			});
			expect(ports.artifacts.appendDocEditAudit).toHaveBeenCalledTimes(1);
			expect(ports.artifacts.appendDocEditAudit).toHaveBeenCalledWith(
				"doc-123",
				expect.objectContaining({
					revision_before: "rev-old",
					revision_after: "rev-new",
					request_count: 1,
					suggest: false,
				}),
			);

			const text = formatDocsBatchUpdateMcp(out);
			expect(text).toContain(
				"Successfully applied 1 batchUpdate request(s) to document doc-123.",
			);
			expect(text).toContain("Revision before: rev-old");
			expect(text).toContain("Revision after:  rev-new");
			expect(text).toContain("Mode: Direct edit (writeMode: 'EDIT')");
			expect(text).toContain('[1] insertText: {"insertText":{}}');
			expect(errSpy).toHaveBeenCalledWith(
				"[docs_batch_update] docId=doc-123 revisionBefore=rev-old revisionAfter=(pending) requestCount=1 suggest=false",
			);
			expect(errSpy).toHaveBeenCalledWith(
				"[docs_batch_update] docId=doc-123 revisionBefore=rev-old revisionAfter=rev-new requestCount=1 suggest=false",
			);
		} finally {
			errSpy.mockRestore();
		}
	});

	it("4. logs audit failure to stderr without failing the edit", async () => {
		const ports = makeMockPorts({
			artifacts: {
				appendDocEditAudit: vi.fn().mockRejectedValue(new Error("db offline")),
			},
		});
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const action = createDocsBatchUpdateAction(ports);
			const out = await executeAction(
				action,
				{
					document_id: "doc-123",
					domain: "angus",
					required_revision_id: "rev-old",
					requests: [{ insertText: { text: "new text", location: { index: 1 } } }],
				},
				{ context: ctx },
			);
			expect(out.revisionAfter).toBe("rev-new");
			expect(errSpy).toHaveBeenCalledWith(
				expect.stringContaining(
					"[docs_batch_update] Note: Failed to append to artifact audit trail: db offline",
				),
			);
		} finally {
			errSpy.mockRestore();
		}
	});

	it("5. translates revision mismatch and suggest-mode refusal without falling back to direct edit", async () => {
		const mismatchPorts = makeMockPorts({
			docs: {
				batchUpdate: vi
					.fn()
					.mockRejectedValue(
						Object.assign(
							new Error(
								"The required revision ID 'AHj4eMT-iY_uIZEkTXEh3liXTV0_5DwQyF4UZINPQHPsvJ5EZ-r1pjTTvqFM3wr_7ZqOF45WXXRSnUbU5ABe5VpfGyld8F1ygKponeoVDIw' does not match the latest revision.",
							),
							{ status: 400, googleStatus: "INVALID_ARGUMENT" },
						),
					),
			},
		});
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(
				executeAction(
					createDocsBatchUpdateAction(mismatchPorts),
					{
						document_id: "doc-123",
						domain: "work",
						required_revision_id: "stale-rev",
						requests: [{ insertText: { text: "new text", location: { index: 1 } } }],
					},
					{ context: ctx },
				),
			).rejects.toThrow(
				/Doc changed since your read \(revision mismatch: required 'stale-rev'\)/,
			);

			const suggestPorts = makeMockPorts({
				docs: {
					batchUpdate: vi
						.fn()
						.mockRejectedValue(
							new Error("403 Suggestion mode writeMode is not permitted"),
						),
				},
			});
			await expect(
				executeAction(
					createDocsBatchUpdateAction(suggestPorts),
					{
						document_id: "doc-123",
						domain: "angus",
						required_revision_id: "rev-1",
						requests: [{ insertText: { text: "proposed text", location: { index: 1 } } }],
						suggest: true,
					},
					{ context: ctx },
				),
			).rejects.toThrow(
				/Google refused suggestion mode \(suggest: true\).*ahKMS will never fall back to a direct edit/,
			);
			expect(suggestPorts.docs.batchUpdate).toHaveBeenCalledTimes(1);
			expect(suggestPorts.docs.batchUpdate).toHaveBeenCalledWith({
				domain: "angus",
				documentId: "doc-123",
				requests: [{ insertText: { text: "proposed text", location: { index: 1 } } }],
				writeControl: { requiredRevisionId: "rev-1", writeMode: "SUGGEST" },
			});
		} finally {
			errSpy.mockRestore();
		}
	});

	it("6. is registered in buildRegistry({}) and throws AdapterUnavailableError when unwired", async () => {
		const registry = buildRegistry({});
		const action = registry.get("docs_batch_update");
		expect(action).toBeDefined();

		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(
				executeAction(
					action!,
					{
						document_id: "doc-123",
						domain: "angus",
						required_revision_id: "rev-1",
						requests: [{ insertText: { text: "hi", location: { index: 1 } } }],
					},
					{ context: ctx },
				),
			).rejects.toBeInstanceOf(AdapterUnavailableError);
		} finally {
			errSpy.mockRestore();
		}
	});
});
