import {
	createDocsBatchUpdateAction,
	executeAction,
	type ActionContext,
	type ArtifactRepository,
	type DocsPort,
} from "@ahkms/core";
import {
	AdapterUnavailableError,
	buildRegistry,
} from "@ahkms/core/actions";
import actionManifest from "@ahkms/core/action-manifest.json" with { type: "json" };
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createServer } from "../server.js";
import { readLegacyBaseline } from "./legacyBaseline.js";


async function connectTestClient() {
	const server = createServer();
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "docs-batch-update-test", version: "0.0.1" });
	await Promise.all([
		server.connect(serverTransport),
		client.connect(clientTransport),
	]);
	return {
		client,
		close: async () => {
			await client.close();
			await server.close();
		},
	};
}

describe("docs_batch_update action migration (#1521)", () => {
	it("1. Contract parity: MCP lists docs_batch_update with exact dev inputSchema, annotations, and description", async () => {
		const { client, close } = await connectTestClient();
		try {
			const { tools } = await client.listTools();
			const byName = new Map(tools.map((t) => [t.name, t]));

			const tool = byName.get("docs_batch_update");
			expect(tool).toBeDefined();
			expect(tool!.description).toBe(
				"Apply in-place structural updates to a Google Doc (insertText, deleteContentRange, replaceAllText, insertTable, etc.). Requires required_revision_id from docs_get. Full notes: docs/guides/tools/docs_batch_update.md",
			);
			expect(tool!.annotations).toMatchObject({
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: true,
			});

			const props = (tool!.inputSchema.properties ?? {}) as Record<
				string,
				Record<string, unknown>
			>;
			expect(Object.keys(props)).toEqual([
				"document_id",
				"domain",
				"account",
				"required_revision_id",
				"requests",
				"suggest",
			]);
			expect(tool!.inputSchema.required).toEqual([
				"document_id",
				"domain",
				"required_revision_id",
				"requests",
			]);
			expect(props.document_id).toMatchObject({
				type: "string",
				minLength: 1,
			});
			expect(props.domain).toMatchObject({
				type: "string",
				enum: ["work", "angus"],
			});
			expect(props.account).toMatchObject({
				type: "string",
				enum: ["personal", "work"],
			});
			expect(props.required_revision_id).toMatchObject({
				type: "string",
				minLength: 1,
			});
			expect(props.requests).toMatchObject({
				type: "array",
				minItems: 1,
			});
			expect(props.suggest).toMatchObject({
				type: "boolean",
			});
		} finally {
			await close();
		}
	});

	it("2. Exposure: docs_batch_update is in packages/core/action-manifest.json with default surface exposure", () => {
		const actions = (
			actionManifest as { actions: Record<string, { expose: unknown }> }
		).actions;

		expect(actions.docs_batch_update).toBeDefined();
		expect(actions.docs_batch_update.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
	});

	it("3. Registration path: in buildRegistry, absent from legacy-tools-baseline.txt, and throws AdapterUnavailableError when unwired", async () => {
		const registry = buildRegistry({});
		const ids = new Set(registry.list().map((a) => a.id));
		expect(ids.has("docs_batch_update")).toBe(true);

		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("docs_batch_update");

		const ctx: ActionContext = {
			caller: "mcp",
			userId: "00000000-0000-0000-0000-000000000001",
			requestId: "req-unwired",
		};
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(
				executeAction(
					registry.get("docs_batch_update")!,
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

	it("4-6. Refuses blank required_revision_id, enforces suggest mode without fallback, and appends one docs_edit_audit entry", async () => {
		const batchUpdate = vi.fn().mockResolvedValue({
			documentId: "doc-123",
			writeControl: { requiredRevisionId: "rev-new" },
			replies: [{ insertText: {} }],
		});
		const appendDocEditAudit = vi.fn().mockResolvedValue(undefined);
		const docs: DocsPort = {
			getDocument: vi.fn(),
			batchUpdate,
		};
		const artifacts: Pick<ArtifactRepository, "appendDocEditAudit"> = {
			appendDocEditAudit,
		};
		const action = createDocsBatchUpdateAction({ docs, artifacts });
		const ctx: ActionContext = {
			caller: "mcp",
			userId: "00000000-0000-0000-0000-000000000001",
			requestId: "req-parity",
		};

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
		expect(batchUpdate).not.toHaveBeenCalled();

		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const res = await executeAction(
				action,
				{
					document_id: "doc-123",
					domain: "angus",
					required_revision_id: "rev-old",
					requests: [{ insertText: { text: "hi", location: { index: 1 } } }],
				},
				{ context: ctx },
			);
			expect(res.revisionAfter).toBe("rev-new");
			expect(appendDocEditAudit).toHaveBeenCalledTimes(1);
			expect(appendDocEditAudit).toHaveBeenCalledWith(
				"doc-123",
				expect.objectContaining({
					revision_before: "rev-old",
					revision_after: "rev-new",
					request_count: 1,
					suggest: false,
				}),
			);

			batchUpdate.mockRejectedValueOnce(new Error("403 Suggest mode refused"));
			await expect(
				executeAction(
					action,
					{
						document_id: "doc-123",
						domain: "angus",
						required_revision_id: "rev-old",
						requests: [{ insertText: { text: "hi", location: { index: 1 } } }],
						suggest: true,
					},
					{ context: ctx },
				),
			).rejects.toThrow(
				/Google refused suggestion mode \(suggest: true\).*ahKMS will never fall back to a direct edit/,
			);
			expect(batchUpdate).toHaveBeenCalledTimes(2);
		} finally {
			errSpy.mockRestore();
		}
	});
});
