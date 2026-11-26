import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	ActionRegistry,
	setDefaultAuditSink,
	stderrAuditSink,
	type ActionAuditRecord,
} from "@ahkms/core";
import { makeRegistrar, registerAllTools } from "../server.js";
import { ACTION_BACKED_LEGACY_TOOLS } from "../actions/legacyDispatch.js";
import { TOOL_ALIASES } from "../toolAliases.js";
import { toMcpTool } from "../actions/index.js";
import { serverRegistry } from "../actions/serverRegistry.js";
import { readLegacyBaseline } from "./legacyBaseline.js";

const entityGetAction = serverRegistry().get("entity_get")!;
const entitiesGetHandler = (args: Record<string, unknown>, extra?: any) =>
	toMcpTool(entityGetAction).handler(args, extra);

const require = createRequire(import.meta.url);
const manifest: {
	actions: Record<
		string,
		{
			expose: { mcp: boolean };
			formerIds?: Array<{ id: string; until: string }>;
		}
	>;
} = require("@ahkms/core/action-manifest.json");

function createStubServer() {
	const sdkHandlers = new Map<string, (...args: any[]) => any>();
	const stub = {
		registerTool: vi.fn((name: string, _config: unknown, handler: (...args: any[]) => any) => {
			sdkHandlers.set(name, handler);
			return {};
		}),
	} as unknown as McpServer;
	return { stub, sdkHandlers };
}

describe("makeRegistrar legacy tool ledger integration (#1413)", () => {
	let captured: ActionAuditRecord[] = [];

	beforeEach(() => {
		captured = [];
		setDefaultAuditSink((rec) => {
			captured.push(rec);
		});
	});

	afterEach(() => {
		setDefaultAuditSink(stderrAuditSink);
		vi.restoreAllMocks();
	});

	it("9. records canonical actionId when an alias re-registers the same handler, and keeps the raw handler in registered", async () => {
		const { stub, sdkHandlers } = createStubServer();
		const emptyRegistry = new ActionRegistry();
		const { register, registered } = makeRegistrar(stub, emptyRegistry);

		const h = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
		const cfg = { description: "test tool" };

		(register as any)("x", cfg, h);
		(register as any)("old_x", cfg, h);

		expect(registered.get("x")?.handler).toBe(h);
		expect(registered.get("old_x")?.handler).toBe(h);

		expect(sdkHandlers.get("x")).not.toBe(h);
		expect(sdkHandlers.get("old_x")).not.toBe(h);

		await sdkHandlers.get("x")!({ k: 1 }, {});
		await sdkHandlers.get("old_x")!({ k: 2 }, {});

		expect(captured).toHaveLength(2);
		expect(captured[0].actionId).toBe("x");
		expect(captured[1].actionId).toBe("x");
	});

	it("10. skips wrapping ACTION_BACKED_LEGACY_TOOLS and any alias sharing their handler", async () => {
		const { stub, sdkHandlers } = createStubServer();
		const emptyRegistry = new ActionRegistry();
		const { register } = makeRegistrar(stub, emptyRegistry);

		const h = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
		const cfg = { description: "entity get" };

		(register as any)("entity_get", cfg, h);
		(register as any)("entities_get", cfg, h);

		expect(sdkHandlers.get("entity_get")).toBe(h);
		expect(sdkHandlers.get("entities_get")).toBe(h);

		await sdkHandlers.get("entity_get")!({ id: "1" }, {});
		await sdkHandlers.get("entities_get")!({ id: "1" }, {});

		expect(captured).toHaveLength(0);
	});

	it("11. registerAllTools wraps every non-action-backed tool and leaves action-backed tools unwrapped", () => {
		const { stub, sdkHandlers } = createStubServer();
		const registered = registerAllTools(stub);

		const mcpManifestIds = new Set(
			Object.entries(manifest.actions)
				.filter(([, entry]) => entry.expose.mcp)
				.map(([id]) => id),
		);
		const actionBackedHandlers = new Set<unknown>();
		for (const id of mcpManifestIds) {
			const entry = registered.get(id);
			if (entry) actionBackedHandlers.add(entry.handler);
		}
		for (const id of ACTION_BACKED_LEGACY_TOOLS) {
			const entry = registered.get(id);
			if (entry) actionBackedHandlers.add(entry.handler);
		}

		const aliasNames = new Set<string>(Object.keys(TOOL_ALIASES));
		for (const entry of Object.values(manifest.actions)) {
			for (const former of entry.formerIds ?? []) {
				aliasNames.add(former.id);
			}
		}

		let wrappedNonAliasCount = 0;
		for (const [name, entry] of registered.entries()) {
			const sdkHandler = sdkHandlers.get(name);
			expect(sdkHandler).toBeDefined();

			if (actionBackedHandlers.has(entry.handler)) {
				expect(sdkHandler).toBe(entry.handler);
			} else {
				expect(sdkHandler).not.toBe(entry.handler);
				if (!aliasNames.has(name)) {
					wrappedNonAliasCount++;
				}
			}
		}

		// Every tool still listed in legacy-tools-baseline.txt is a wrapped non-alias tool; the floor
		// follows the baseline down to 0 as tools migrate (#2338), so no literal needs lowering by hand.
		expect(wrappedNonAliasCount).toBeGreaterThanOrEqual(readLegacyBaseline().length);
	});


	it("12. entitiesGetHandler forwards extra to toMcpTool(entityGetAction) and writes one action seam record (no legacy_tool record)", async () => {
		const id = "11111111-1111-4111-8111-111111111111";
		vi.spyOn(entityGetAction, "run").mockResolvedValue({
			found: true,
			entity: {
				id,
				title: "Test Entity",
				entity_type: "concept",
				description: "A test entity",
				archived: false,
				archived_at: null,
				properties: {},
				tags: [],
				source_url: null,
				user_id: "00000000-0000-0000-0000-000000000000",
				team_id: null,
				created_at: "2026-01-01T00:00:00Z",
				updated_at: "2026-01-01T00:00:00Z",
			},
		});

		await entitiesGetHandler(
			{ id } as any,
			{
				authInfo: { token: "t", clientId: "c1", scopes: [] },
				sessionId: "s1",
			},
		);

		expect(captured).toHaveLength(1);
		expect(captured[0]).toMatchObject({
			seam: "action",
			actionId: "entity_get",
			clientId: "c1",
			sessionId: "s1",
			outcome: "success",
		});
		expect(captured.some((r) => r.seam === "legacy_tool")).toBe(false);
	});
});
