import { afterEach, describe, expect, it, vi } from "vitest";
import { supabase } from "../supabase.js";
import { toMcpTool } from "../actions/index.js";
import { serverRegistry } from "../actions/serverRegistry.js";

const artifactDeleteHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("artifact_delete")!).handler(args);

const TEST_USER = "00000000-0000-0000-0000-000000000000"; // from vitest.config env

const origFrom = supabase.from;
afterEach(() => {
	(supabase as any).from = origFrom;
	vi.restoreAllMocks();
});

/** A thenable-at-select query builder: eq/in return itself, select resolves the result. */
function builder(result: unknown, hooks?: { eq?: (...a: unknown[]) => void; in?: (...a: unknown[]) => void }) {
	const b: any = {
		eq: (...args: unknown[]) => {
			hooks?.eq?.(...args);
			return b;
		},
		in: (...args: unknown[]) => {
			hooks?.in?.(...args);
			return b;
		},
		select: () => Promise.resolve(result),
	};
	return b;
}

describe("artifactDeleteHandler", () => {
	it("soft-deletes (archives) by default when archive_only is omitted", async () => {
		const eqCalls: unknown[][] = [];
		const inCalls: unknown[][] = [];
		let updatePayload: Record<string, unknown> | undefined;
		const b = builder(
			{ data: [{ id: "art-1", title: "Some Artifact" }], error: null },
			{ eq: (...a) => eqCalls.push(a), in: (...a) => inCalls.push(a) },
		);
		const update = vi.fn((payload: Record<string, unknown>) => {
			updatePayload = payload;
			return b;
		});
		(supabase as any).from = vi.fn(() => ({ update }));

		const result = await artifactDeleteHandler({ ids: ["art-1"] } as any);

		expect(update).toHaveBeenCalled();
		expect(updatePayload).toMatchObject({ archived: true, archived_reason: null });
		expect(typeof updatePayload?.archived_at).toBe("string");
		expect(eqCalls).toContainEqual(["user_id", TEST_USER]);
		expect(inCalls).toContainEqual(["id", ["art-1"]]);
		expect(result.content[0].text).toContain("Archived 1 artifact");
		expect(result.content[0].text).toContain("Some Artifact");
	});

	it("soft-deletes explicitly when archive_only: true is passed, recording archived_reason", async () => {
		let updatePayload: Record<string, unknown> | undefined;
		const b = builder({ data: [{ id: "art-2", title: "Another" }], error: null });
		(supabase as any).from = vi.fn(() => ({
			update: (payload: Record<string, unknown>) => {
				updatePayload = payload;
				return b;
			},
		}));

		await artifactDeleteHandler({
			ids: ["art-2"],
			archive_only: true,
			archived_reason: "superseded by re-capture",
		} as any);

		expect(updatePayload?.archived_reason).toBe("superseded by re-capture");
	});

	it("hard-deletes only when archive_only: false is explicitly passed", async () => {
		const eqCalls: unknown[][] = [];
		const inCalls: unknown[][] = [];
		const b = builder(
			{ data: [{ id: "art-3", title: "Old Artifact" }], error: null },
			{ eq: (...a) => eqCalls.push(a), in: (...a) => inCalls.push(a) },
		);
		const del = vi.fn(() => b);
		(supabase as any).from = vi.fn(() => ({ delete: del }));

		const result = await artifactDeleteHandler({
			ids: ["art-3"],
			archive_only: false,
		} as any);

		expect(del).toHaveBeenCalled();
		expect(eqCalls).toContainEqual(["user_id", TEST_USER]);
		expect(inCalls).toContainEqual(["id", ["art-3"]]);
		expect(result.content[0].text).toContain("Deleted 1 artifact");
	});

	it("scopes both the soft and hard paths by user_id (RLS-equivalent guard)", async () => {
		const softEq = vi.fn();
		const softBuilder = builder({ data: [], error: null }, { eq: softEq });
		(supabase as any).from = vi.fn(() => ({ update: () => softBuilder }));
		await artifactDeleteHandler({ ids: ["art-4"] } as any);
		expect(softEq).toHaveBeenCalledWith("user_id", TEST_USER);

		const hardEq = vi.fn();
		const hardBuilder = builder({ data: [], error: null }, { eq: hardEq });
		(supabase as any).from = vi.fn(() => ({ delete: () => hardBuilder }));
		await artifactDeleteHandler({ ids: ["art-5"], archive_only: false } as any);
		expect(hardEq).toHaveBeenCalledWith("user_id", TEST_USER);
	});

	it("surfaces the error message when the soft-delete update fails", async () => {
		const b = builder({ data: null, error: { message: "boom" } });
		(supabase as any).from = vi.fn(() => ({ update: () => b }));

		await expect(artifactDeleteHandler({ ids: ["art-6"] } as any)).rejects.toThrow(
			"Artifact archive failed: boom",
		);
	});

	it("surfaces the error message when the hard delete fails", async () => {
		const b = builder({ data: null, error: { message: "boom" } });
		(supabase as any).from = vi.fn(() => ({ delete: () => b }));

		await expect(
			artifactDeleteHandler({ ids: ["art-7"], archive_only: false } as any),
		).rejects.toThrow("Artifact delete failed: boom");
	});

	it("returns a no-op message when ids is empty", async () => {
		(supabase as any).from = vi.fn();
		const result = await artifactDeleteHandler({ ids: [] } as any);
		expect(supabase.from).not.toHaveBeenCalled();
		expect(result.content[0].text).toContain("Archived 0 artifacts");
	});
});
