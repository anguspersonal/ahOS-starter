import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getActionScope,
	inputSha256,
	noopActionScope,
	setActionScope,
	setDefaultAuditSink,
	stderrAuditSink,
	type ActionAuditRecord,
} from "@ahkms/core";
import { wrapLegacyHandler } from "./legacyDispatch.js";
import type { McpToolHandlerExtra } from "./adapters/mcp.js";
import { configureActionScope } from "./scope.js";
import {
	defaultSessionTraceTracker,
	MAX_ACTIVE_SESSIONS,
	SESSION_TURN_WINDOW_MS,
	SessionTraceTracker,
} from "./sessionTrace.js";

describe("wrapLegacyHandler (#1413)", () => {
	let captured: ActionAuditRecord[] = [];

	beforeEach(() => {
		captured = [];
		defaultSessionTraceTracker.clear();
		setDefaultAuditSink((rec) => {
			captured.push(rec);
		});
	});

	afterEach(() => {
		defaultSessionTraceTracker.clear();
		setActionScope(noopActionScope);
		setDefaultAuditSink(stderrAuditSink);
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("1. records a successful legacy tool call with clientId, sessionId, inputKeys, inputSha256 and no argument values", async () => {
		const expectedResult = { content: [{ type: "text", text: "ok" }] };
		const h = vi.fn().mockResolvedValue(expectedResult);
		const args = { channel: "#general", text: "super-secret-value-12345" };
		const extra: McpToolHandlerExtra = {
			authInfo: { token: "t", clientId: "c1", scopes: [] },
			sessionId: "s1",
		};

		const wrapped = wrapLegacyHandler("slack_post", h);
		const result = await wrapped(args, extra);

		expect(h).toHaveBeenCalledTimes(1);
		expect(h).toHaveBeenCalledWith(args, extra);
		expect(result).toBe(expectedResult);

		expect(captured).toHaveLength(1);
		const rec = captured[0];
		expect(rec).toMatchObject({
			actionId: "slack_post",
			seam: "legacy_tool",
			caller: "mcp",
			clientId: "c1",
			sessionId: "s1",
			outcome: "success",
			userId: "00000000-0000-0000-0000-000000000000",
			errorMessage: null,
			inputKeys: ["channel", "text"],
			inputSha256: await inputSha256(args),
		});
		expect(rec.requestId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
		);
		expect(typeof rec.durationMs).toBe("number");
		expect(rec.durationMs).toBeGreaterThanOrEqual(0);

		const serializedRecord = JSON.stringify(rec);
		expect(serializedRecord).not.toContain("#general");
		expect(serializedRecord).not.toContain("super-secret-value-12345");
	});

	it("2. omits/nulls clientId and sessionId when clientId is empty or extra is empty (stdio)", async () => {
		const h = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
		const wrapped = wrapLegacyHandler("slack_post", h);

		await wrapped({ a: 1 }, { authInfo: { token: "t", clientId: "", scopes: [] } });
		await wrapped({ a: 1 }, {});

		expect(captured).toHaveLength(2);
		expect(captured[0].clientId ?? null).toBeNull();
		expect(captured[0].sessionId ?? null).toBeNull();
		expect(captured[1].clientId ?? null).toBeNull();
		expect(captured[1].sessionId ?? null).toBeNull();
	});

	it("3. records read tools too without reading annotations", async () => {
		const h = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "files" }] });
		const wrapped = wrapLegacyHandler("drive_list", h);

		await wrapped({ query: "report" }, {});

		expect(captured).toHaveLength(1);
		expect(captured[0].actionId).toBe("drive_list");
		expect(captured[0].seam).toBe("legacy_tool");
		expect(captured[0].outcome).toBe("success");
	});

	it("4. treats an isError result as outcome error with errorMessage from the first text block", async () => {
		const errResult = {
			isError: true,
			content: [{ type: "text", text: "boom" }],
		};
		const h = vi.fn().mockResolvedValue(errResult);
		const wrapped = wrapLegacyHandler("slack_post", h);

		const result = await wrapped({ text: "hi" }, {});

		expect(result).toBe(errResult);
		expect(captured).toHaveLength(1);
		expect(captured[0].outcome).toBe("error");
		expect(captured[0].errorMessage).toBe("boom");
	});

	it("5. records outcome error and rethrows the same error when the handler throws", async () => {
		const boom = new Error("handler exploded");
		const h = vi.fn().mockRejectedValue(boom);
		const wrapped = wrapLegacyHandler("slack_post", h);

		await expect(wrapped({ text: "hi" }, {})).rejects.toBe(boom);

		expect(captured).toHaveLength(1);
		expect(captured[0].outcome).toBe("error");
		expect(captured[0].errorMessage).toBe("handler exploded");
	});

	it("6. hashes the args as received before the handler mutates them", async () => {
		const originalArgs = { keep: "yes", drop: "later" };
		const expectedHash = await inputSha256({ keep: "yes", drop: "later" });

		const h = vi.fn().mockImplementation(async (a: Record<string, unknown>) => {
			delete a.drop;
			return { content: [{ type: "text", text: "done" }] };
		});
		const wrapped = wrapLegacyHandler("slack_post", h);

		await wrapped(originalArgs, {});

		expect(captured).toHaveLength(1);
		expect(captured[0].inputSha256).toBe(expectedHash);
		expect(captured[0].inputKeys).toEqual(["keep", "drop"]);
	});

	it("7. still runs the handler and records inputSha256: null when canonicalJson throws (e.g. BigInt)", async () => {
		const expectedResult = { content: [{ type: "text", text: "ok" }] };
		const h = vi.fn().mockResolvedValue(expectedResult);
		const wrapped = wrapLegacyHandler("slack_post", h);

		const result = await wrapped({ n: 1n }, {});

		expect(h).toHaveBeenCalledTimes(1);
		expect(result).toBe(expectedResult);
		expect(captured).toHaveLength(1);
		expect(captured[0].inputSha256).toBeNull();
		expect(captured[0].inputKeys).toEqual(["n"]);
	});

	it("8. swallows sink rejection, preserves the result, and logs the requestId to console.error", async () => {
		let seenRequestId = "";
		setDefaultAuditSink(async (rec) => {
			seenRequestId = rec.requestId ?? "";
			throw new Error("sink down");
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const expectedResult = { content: [{ type: "text", text: "ok" }] };
		const h = vi.fn().mockResolvedValue(expectedResult);
		const wrapped = wrapLegacyHandler("slack_post", h);

		const result = await wrapped({ a: 1 }, {});

		expect(result).toBe(expectedResult);
		expect(seenRequestId).toBeTruthy();
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining(seenRequestId),
		);
	});

	it("9. correlates consecutive session calls within SESSION_TURN_WINDOW_MS and resets after window expiry (#2054)", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-04-20T12:00:00.000Z"));

		const h = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
		const personGet = wrapLegacyHandler("person_get", h);
		const entityRelate = wrapLegacyHandler("entity_relate", h);
		const extra: McpToolHandlerExtra = {
			authInfo: { token: "t", clientId: "claude-desktop", scopes: [] },
			sessionId: "sess-turn-1",
		};

		// First call in burst: starts a new trace and has no parentRequestId
		await personGet({ id: "p1" }, extra);
		// Second and third calls within 30s burst window: share traceId and point parentRequestId to rootRequestId
		vi.advanceTimersByTime(5_000);
		await entityRelate({ from: "p1", to: "e1" }, extra);
		vi.advanceTimersByTime(10_000);
		await entityRelate({ from: "p1", to: "e2" }, extra);

		expect(captured).toHaveLength(3);
		const [first, second, third] = captured;
		expect(first.parentRequestId).toBeNull();
		expect(first.traceId).toBe(first.requestId);

		expect(second.traceId).toBe(first.traceId);
		expect(second.parentRequestId).toBe(first.requestId);
		expect(second.requestId).not.toBe(first.requestId);

		expect(third.traceId).toBe(first.traceId);
		expect(third.parentRequestId).toBe(first.requestId);

		// Advance past SESSION_TURN_WINDOW_MS from the last call -> starts a fresh turn burst
		vi.advanceTimersByTime(SESSION_TURN_WINDOW_MS + 1);
		await personGet({ id: "p2" }, extra);

		expect(captured).toHaveLength(4);
		const fourth = captured[3];
		expect(fourth.parentRequestId).toBeNull();
		expect(fourth.traceId).toBe(fourth.requestId);
		expect(fourth.traceId).not.toBe(first.traceId);
	});

	it("10. correlates consecutive session calls via userId + clientId when sessionId is absent (#2054)", async () => {
		const h = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
		const wrapped = wrapLegacyHandler("person_get", h);
		const extra: McpToolHandlerExtra = {
			authInfo: { token: "t", clientId: "oauth-client-1", scopes: [] },
		};

		await wrapped({ id: "p1" }, extra);
		await wrapped({ id: "p2" }, extra);

		expect(captured).toHaveLength(2);
		expect(captured[0].parentRequestId).toBeNull();
		expect(captured[0].traceId).toBe(captured[0].requestId);
		expect(captured[1].traceId).toBe(captured[0].traceId);
		expect(captured[1].parentRequestId).toBe(captured[0].requestId);
	});

	it("11. preserves in-process ActionScope parentCtx over SessionTraceTracker (#2054)", async () => {
		configureActionScope();
		const h = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
		const outerTool = wrapLegacyHandler("outer_tool", h);
		const innerTool = wrapLegacyHandler("inner_tool", h);
		const extra: McpToolHandlerExtra = {
			authInfo: { token: "t", clientId: "c1", scopes: [] },
			sessionId: "sess-nested",
		};

		// Seed session tracker with an initial call
		await outerTool({ step: 1 }, extra);
		const rootCall = captured[0];

		// Now run innerTool inside an explicit in-process ActionScope
		const scope = getActionScope();
		await scope.run(
			{
				caller: "mcp",
				requestId: "11111111-1111-4111-8111-111111111111",
				traceId: "22222222-2222-4222-8222-222222222222",
			},
			async () => {
				await innerTool({ step: 2 }, extra);
			},
		);

		expect(captured).toHaveLength(2);
		const nestedCall = captured[1];
		expect(nestedCall.parentRequestId).toBe("11111111-1111-4111-8111-111111111111");
		expect(nestedCall.traceId).toBe("22222222-2222-4222-8222-222222222222");
		expect(nestedCall.traceId).not.toBe(rootCall.traceId);
	});

	it("12. enforces bounded session capacity and falls back cleanly when unattributed (#2054)", () => {
		expect(SESSION_TURN_WINDOW_MS).toBe(30_000);
		expect(MAX_ACTIVE_SESSIONS).toBe(1_000);

		const tracker = new SessionTraceTracker({ windowMs: 30_000, maxSessions: 2 });
		const unattributed = tracker.resolve("req-anon", {});
		expect(unattributed).toEqual({ traceId: "req-anon", parentRequestId: null });
		expect(tracker.size).toBe(0);

		tracker.resolve("req-1", { sessionId: "s1" }, 1_000);
		tracker.resolve("req-2", { sessionId: "s2" }, 1_001);
		expect(tracker.size).toBe(2);

		// Adding a 3rd session evicts the oldest active session (s1)
		tracker.resolve("req-3", { sessionId: "s3" }, 1_002);
		expect(tracker.size).toBe(2);
		expect(tracker.get("s1", 1_003)).toBeUndefined();
		expect(tracker.get("s2", 1_003)?.rootRequestId).toBe("req-2");
		expect(tracker.get("s3", 1_003)?.rootRequestId).toBe("req-3");
	});
});
