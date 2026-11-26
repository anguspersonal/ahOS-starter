import { afterEach, describe, expect, it, vi } from "vitest";
import { toMcpTool } from "../actions/index.js";
import { serverRegistry } from "../actions/serverRegistry.js";
import { supabase } from "../supabase.js";
import { STATE_DOC_LINK_KIND } from "../vocab.js";

const origFrom = supabase.from;
afterEach(() => {
	(supabase as any).from = origFrom;
	vi.restoreAllMocks();
});

const TWIN = "11111111-1111-4111-8111-111111111111";
const ATOM = "22222222-2222-4222-8222-222222222222";

/**
 * `artifacts` answers the guard's read. `artifact_external_links` accepts the upsert and
 * answers the daily_log guard's existing-pointer select (#2313).
 */
function stub(
	subtypeById: Record<string, string | null>,
	opts: {
		readError?: string;
		pointers?: Array<{ provider: string; external_id: string }>;
		pointerReadError?: string;
	} = {},
) {
	const upsert = vi.fn().mockResolvedValue({ error: null });
	const reads = vi.fn();
	const pointerReads = vi.fn();
	(supabase as any).from = vi.fn((table: string) => {
		if (table === "artifact_external_links") {
			const q: any = {
				eq: () => q,
				then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
					Promise.resolve(
						opts.pointerReadError
							? { data: null, error: { message: opts.pointerReadError } }
							: { data: opts.pointers ?? [], error: null },
					).then(resolve, reject),
			};
			return {
				upsert,
				select: () => {
					pointerReads();
					return q;
				},
			};
		}
		reads();
		let id: string | undefined;
		const b: any = {
			select: () => b,
			eq: (col: string, v: string) => {
				if (col === "id") id = v;
				return b;
			},
			maybeSingle: async () =>
				opts.readError
					? { data: null, error: { message: opts.readError } }
					: { data: id && id in subtypeById ? { content_subtype: subtypeById[id] } : null, error: null },
		};
		return b;
	});
	return { upsert, reads, pointerReads };
}

const call = (artifact_id: string, kind: string, run_id?: string) =>
	toMcpTool(serverRegistry().get("external_link_create")!).handler({
		artifact_id,
		provider: "notion_work",
		kind,
		external_id: "page-1",
		run_id,
	});

describe("external_link_create refuses the two rows that would be wrong forever", () => {
	it(`writes '${STATE_DOC_LINK_KIND}' on a Daily Log twin (hop 2)`, async () => {
		const { upsert } = stub({ [TWIN]: "daily_log" });
		const { content } = await call(TWIN, STATE_DOC_LINK_KIND);
		expect(upsert).toHaveBeenCalledTimes(1);
		expect(content[0].text).toContain(`→ notion_work/${STATE_DOC_LINK_KIND}/page-1`);
	});

	it(`refuses '${STATE_DOC_LINK_KIND}' on an atom, atoms are consumed by a log, never by the State Doc`, async () => {
		const { upsert } = stub({ [ATOM]: null });
		await expect(call(ATOM, STATE_DOC_LINK_KIND)).rejects.toThrow(/belongs on a Daily Log twin/);
		expect(upsert).not.toHaveBeenCalled();
	});

	it.each(["synthesized", "synthesized_unattended"])("refuses a '%s' marker on a twin", async (kind) => {
		const { upsert } = stub({ [TWIN]: "daily_log" });
		await expect(call(TWIN, kind, "run-123")).rejects.toThrow(/a twin never carries a synthesis marker/);
		expect(upsert).not.toHaveBeenCalled();
	});

	it("refuses 'synthesized' without a ritual run_id", async () => {
		const { upsert } = stub({ [ATOM]: null });
		await expect(call(ATOM, "synthesized")).rejects.toThrow(/requires a ritual `run_id`/);
		expect(upsert).not.toHaveBeenCalled();
	});

	it("writes a 'synthesized' marker on an atom when ritual run_id is supplied", async () => {
		const { upsert } = stub({ [ATOM]: null });
		await call(ATOM, "synthesized", "run-123");
		expect(upsert).toHaveBeenCalledTimes(1);
	});

	it("writes a 'synthesized_unattended' marker without a run_id", async () => {
		const { upsert } = stub({ [ATOM]: null });
		await call(ATOM, "synthesized_unattended");
		expect(upsert).toHaveBeenCalledTimes(1);
	});

	it.each(["task", "event"])("does not read the artifact for a '%s' pointer", async (kind) => {
		const { upsert, reads } = stub({});
		await call(ATOM, kind);
		expect(reads).not.toHaveBeenCalled();
		expect(upsert).toHaveBeenCalledTimes(1);
	});

	it("refuses rather than skips when the guard's read fails or finds nothing", async () => {
		let s = stub({}, { readError: "timeout" });
		await expect(call(ATOM, "synthesized", "run-123")).rejects.toThrow(/never skipped on a failed read/);
		expect(s.upsert).not.toHaveBeenCalled();

		s = stub({});
		await expect(call(ATOM, STATE_DOC_LINK_KIND)).rejects.toThrow(/was not found for this user/);
		expect(s.upsert).not.toHaveBeenCalled();
	});
});

describe("external_link_create guards a daily_log pointer (#2313)", () => {
	it("refuses rather than writes when the existing-pointer query errors (the production read is strict)", async () => {
		const { upsert, pointerReads } = stub({ [TWIN]: "daily_log" }, { pointerReadError: "timeout" });
		await expect(call(TWIN, "daily_log")).rejects.toThrow(
			/Could not read the existing 'daily_log' pointers.*timeout.*Nothing was written/s,
		);
		expect(pointerReads).toHaveBeenCalledTimes(1);
		expect(upsert).not.toHaveBeenCalled();
	});

	it("writes once on a pointerless twin, after reading the artifact and its pointers", async () => {
		const { upsert, reads, pointerReads } = stub({ [TWIN]: "daily_log" });
		const { content } = await call(TWIN, "daily_log");
		expect(reads).toHaveBeenCalledTimes(1);
		expect(pointerReads).toHaveBeenCalledTimes(1);
		expect(upsert).toHaveBeenCalledTimes(1);
		expect(content[0].text).toContain("→ notion_work/daily_log/page-1");
	});

	it("refuses a daily_log pointer on an artifact that is not a twin", async () => {
		const { upsert } = stub({ [ATOM]: null });
		await expect(call(ATOM, "daily_log")).rejects.toThrow(/belongs on a Daily Log twin/);
		expect(upsert).not.toHaveBeenCalled();
	});

	it("refuses a second daily_log pointer naming a different page", async () => {
		const { upsert } = stub(
			{ [TWIN]: "daily_log" },
			{ pointers: [{ provider: "notion_work", external_id: "page-other" }] },
		);
		await expect(call(TWIN, "daily_log")).rejects.toThrow(/already carries a 'daily_log' pointer/);
		expect(upsert).not.toHaveBeenCalled();
	});
});
