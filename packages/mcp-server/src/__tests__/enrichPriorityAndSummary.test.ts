import { afterEach, describe, expect, it, vi } from "vitest";
import { supabase } from "../supabase.js";
import { enrichNextCore, enrichNextHandler } from "../tools/enrichNext.js";
import { isPdfBuffer, isUndecodedBinary } from "@ahkms/core";
import { generateL2Summary } from "../tools/enrich/summary.js";

// #1229: Tests for:
// 1. Selection query ordering by effective_at desc, then captured_at desc.
// 2. On-demand enrichment list path (artifact_ids array) outside daily limit.
// 3. L2 summary generation into description.
// 4. Undecoded binary detection and skipping (%PDF-1.4 header / null bytes).

const origFrom = supabase.from;
afterEach(() => {
	(supabase as any).from = origFrom;
	vi.restoreAllMocks();
});

describe("isPdfBuffer and isUndecodedBinary (#1229)", () => {
	it("detects PDF magic header in buffer", () => {
		const pdfBuffer = Buffer.from("%PDF-1.4\n1 0 obj");
		expect(isPdfBuffer(pdfBuffer)).toBe(true);
		expect(isUndecodedBinary(pdfBuffer)).toBe(true);
	});

	it("detects null bytes in initial chunk as binary", () => {
		const binaryBuffer = Buffer.from([0x68, 0x65, 0x6c, 0x00, 0x6f]);
		expect(isPdfBuffer(binaryBuffer)).toBe(false);
		expect(isUndecodedBinary(binaryBuffer)).toBe(true);
	});

	it("treats clean text buffer as not binary", () => {
		const textBuffer = Buffer.from("Hello world! This is clean markdown prose.");
		expect(isPdfBuffer(textBuffer)).toBe(false);
		expect(isUndecodedBinary(textBuffer)).toBe(false);
	});

	it("detects raw %PDF- text as undecoded binary", () => {
		const text = "%PDF-1.4\n%junk\nobj";
		const emptyBuffer = Buffer.alloc(0);
		expect(isUndecodedBinary(emptyBuffer, text)).toBe(true);
	});
});

describe("generateL2Summary (#1229)", () => {
	it("skips empty or whitespace-only text", async () => {
		const res1 = await generateL2Summary(null);
		expect(res1.summary).toBeNull();
		expect(res1.skipReason).toBe("empty text content");

		const res2 = await generateL2Summary("   \n\t  ");
		expect(res2.summary).toBeNull();
		expect(res2.skipReason).toBe("empty text content");
	});

	it("skips undecoded binary (%PDF-1.4 header) without calling Anthropic", async () => {
		const rawPdfText = "%PDF-1.4\n%xxxx\n1 0 obj<</Type/Catalog>>";
		const res = await generateL2Summary(rawPdfText, "Test Document");
		expect(res.summary).toBeNull();
		expect(res.skipReason).toContain("undecoded binary content detected");
	});
});

describe("enrichNext selection ordering (#1229)", () => {
	it("orders selection query by effective_at desc, then captured_at desc", async () => {
		const orderCalls: unknown[][] = [];
		(supabase as any).from = vi.fn(() => {
			const b: any = {
				select: () => b,
				eq: () => b,
				in: () => b,
				or: () => b,
				order: (...args: unknown[]) => {
					orderCalls.push(args);
					return b;
				},
				limit: () => Promise.resolve({ data: [], error: null }),
				then: (resolve: (v: unknown) => void) => resolve({ count: 10, error: null }),
			};
			return b;
		});

		await enrichNextCore({});

		expect(orderCalls).toEqual([
			["effective_at", { ascending: false }],
			["captured_at", { ascending: false }],
		]);
	});
});

describe("enrichNext on-demand artifact list (#1229)", () => {
	it("processes an array of artifact_ids outside the daily budget without counting backlog", async () => {
		const id1 = "11111111-1111-1111-1111-111111111111";
		const id2 = "22222222-2222-2222-2222-222222222222";
		let headCountCalled = false;
		const queriedIds: string[] = [];

		(supabase as any).from = vi.fn(() => {
			const b: any = {
				select: (...args: unknown[]) => {
					if ((args[1] as { head?: boolean } | undefined)?.head) {
						headCountCalled = true;
					}
					return b;
				},
				eq: (col: string, val: unknown) => {
					if (col === "id") queriedIds.push(val as string);
					return b;
				},
				maybeSingle: () => {
					const targetId = queriedIds[queriedIds.length - 1];
					if (targetId === id1) {
						return Promise.resolve({
							data: {
								id: id1,
								title: "CV 2026",
								storage_bucket: "artifacts",
								storage_path: "enriched/gdrive/u/cv1.pdf",
								lifecycle_stage: "extracted",
								source_channel: "discovered_gdrive",
							},
							error: null,
						});
					}
					return Promise.resolve({ data: null, error: null });
				},
			};
			return b;
		});

		const out = await enrichNextCore({ artifact_ids: [id1, id2] });

		expect(headCountCalled).toBe(false);
		expect(out.remaining_discovered).toBeNull();
		expect(queriedIds).toEqual([id1, id2]);
		expect(out.enriched).toBe(0);
		expect(out.failed).toBe(1); // id2 not found
		expect(out.notes).toContain(`${id1}: already enriched (storage_path: enriched/gdrive/u/cv1.pdf)`);
		expect(out.notes).toContain(`${id2}: artifact not found`);
	});

	it("formats summary text properly for on-demand artifact lists", async () => {
		const id1 = "11111111-1111-1111-1111-111111111111";
		const id2 = "22222222-2222-2222-2222-222222222222";

		(supabase as any).from = vi.fn(() => {
			const b: any = {
				select: () => b,
				eq: () => b,
				maybeSingle: () => Promise.resolve({ data: null, error: null }),
			};
			return b;
		});

		const out = await enrichNextHandler({ artifact_ids: [id1, id2] });
		const text = out.content[0].text;

		expect(text).toContain("2 on-demand artifacts");
		expect(text).not.toContain("discovered remaining");
	});
});
