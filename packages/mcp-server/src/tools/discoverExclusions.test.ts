import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { supabase } from "../supabase.js";
import {
	evaluateExclusion,
	getExcludedExtensions,
	getExcludedFolders,
	getExcludedMimeTypes,
	softArchiveExcludedPointers,
} from "./discoverExclusions.js";

const origFrom = supabase.from;

describe("discoverExclusions", () => {
	const origEnv = { ...process.env };

	beforeEach(() => {
		process.env = { ...origEnv };
	});

	afterEach(() => {
		process.env = { ...origEnv };
		(supabase as any).from = origFrom;
		vi.clearAllMocks();
	});

	describe("env overrides", () => {
		it("respects custom DISCOVER_EXCLUDE_FOLDERS", () => {
			process.env.DISCOVER_EXCLUDE_FOLDERS = "custom_dir,temp_build";
			const folders = getExcludedFolders();
			expect(folders).toEqual(["custom_dir", "temp_build"]);
			expect(evaluateExclusion({ title: "custom_dir/file.txt" }).excluded).toBe(true);
			expect(evaluateExclusion({ title: "node_modules/file.txt" }).excluded).toBe(false);
		});

		it("respects custom DISCOVER_EXCLUDE_EXTENSIONS", () => {
			process.env.DISCOVER_EXCLUDE_EXTENSIONS = "custom,bak";
			const exts = getExcludedExtensions();
			expect(exts).toEqual([".custom", ".bak"]);
			expect(evaluateExclusion({ title: "file.bak" }).excluded).toBe(true);
			expect(evaluateExclusion({ title: "file.ts" }).excluded).toBe(false);
		});

		it("respects custom DISCOVER_EXCLUDE_MIME_TYPES", () => {
			process.env.DISCOVER_EXCLUDE_MIME_TYPES = "text/custom-code";
			const mimes = getExcludedMimeTypes();
			expect(mimes).toEqual(["text/custom-code"]);
			expect(evaluateExclusion({ mime_type: "text/custom-code" }).excluded).toBe(true);
			expect(evaluateExclusion({ mime_type: "application/javascript" }).excluded).toBe(false);
		});
	});

	describe("softArchiveExcludedPointers", () => {
		it("runs in dryRun mode by default without updating artifacts", async () => {
			const rows = [
				{
					id: "art-1",
					title: "node_modules/react/index.js",
					source: "ext-1",
					storage_url: "discovered://gdrive/ext-1",
					processing_metadata: { discovery: { mime_type: "application/javascript" } },
				},
				{
					id: "art-2",
					title: "Angus_Hally_CV.pdf",
					source: "ext-2",
					storage_url: "discovered://gdrive/ext-2",
					processing_metadata: { discovery: { mime_type: "application/pdf" } },
				},
			];

			const updateFn = vi.fn();
			(supabase as any).from = vi.fn(() => ({
				select: () => ({
					eq: () => ({
						ilike: () => ({
							eq: () => ({
								order: () => ({
									limit: () => Promise.resolve({ data: rows, error: null }),
								}),
							}),
						}),
					}),
				}),
				update: updateFn,
			}));

			const res = await softArchiveExcludedPointers();
			expect(res.scanned).toBe(2);
			expect(res.matched).toBe(1);
			expect(res.archived).toBe(0);
			expect(res.sample.length).toBe(1);
			expect(res.sample[0].id).toBe("art-1");
			expect(updateFn).not.toHaveBeenCalled();
		});

		it("updates matched artifacts when dryRun is false", async () => {
			const rows = [
				{
					id: "art-1",
					title: "dist/bundle.js",
					source: "ext-1",
					storage_url: "discovered://gdrive/ext-1",
					processing_metadata: { discovery: { mime_type: "application/javascript" } },
				},
			];

			const updateCalls: Record<string, unknown>[] = [];
			(supabase as any).from = vi.fn(() => ({
				select: () => ({
					eq: () => ({
						ilike: () => ({
							eq: () => ({
								order: () => ({
									limit: () => Promise.resolve({ data: rows, error: null }),
								}),
							}),
						}),
					}),
				}),
				update: (payload: Record<string, unknown>) => {
					updateCalls.push(payload);
					return {
						eq: () => ({
							eq: () => Promise.resolve({ error: null }),
						}),
					};
				},
			}));

			const res = await softArchiveExcludedPointers({ dryRun: false });
			expect(res.scanned).toBe(1);
			expect(res.matched).toBe(1);
			expect(res.archived).toBe(1);
			expect(updateCalls.length).toBe(1);
			expect(updateCalls[0].archived).toBe(true);
			expect(String(updateCalls[0].archived_reason)).toContain("discover_excluded");
		});
	});
});
