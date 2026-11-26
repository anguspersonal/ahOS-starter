import { describe, expect, it } from "vitest";
import {
	discoveryMetadata,
	driveColumns,
	envelopeFields,
	firstLine,
	isJunkTitle,
	needsEnvelopeRefresh,
	normalizePointerUrl,
	originatedAt,
	originationFor,
	pointerDescription,
	pointerEmbedText,
	pointerProcessingStatus,
	pointerUrl,
	resolveTitle,
	slugify,
	type DiscoverItem,
	type ExistingRow,
} from "./discoverPointers.js";
import {
	DEFAULT_EXCLUDED_EXTENSIONS,
	DEFAULT_EXCLUDED_FOLDERS,
	DEFAULT_EXCLUDED_MIME_TYPES,
	evaluateExclusion,
} from "./exclusions.js";

describe("domain/ingest/discoverPointers (#1545)", () => {
	it("slugifies titles safely", () => {
		expect(slugify("Hello World! 123")).toBe("hello-world-123");
		expect(slugify("!!!")).toBe("item");
	});

	it("normalizes pointer URLs for notion only", () => {
		expect(normalizePointerUrl("notion", "https://www.notion.so/page-123?pvs=4#frag")).toBe(
			"https://www.notion.so/page-123",
		);
		expect(normalizePointerUrl("gdrive", "https://drive.google.com/file/d/1?usp=sharing")).toBe(
			"https://drive.google.com/file/d/1?usp=sharing",
		);
	});

	it("detects junk/template titles across Notion, Drive, and Gmail fixtures without dropping normal test docs", () => {
		// Notion scratch/template fixtures
		expect(isJunkTitle("[TEST] scratch")).toBe(true);
		expect(isJunkTitle("(template) onboarding")).toBe(true);
		// Drive disposable note fixture
		expect(isJunkTitle("Notes - safe to delete")).toBe(true);
		// Gmail draft fixture vs normal document
		expect(isJunkTitle("[DRAFT] Follow-up email")).toBe(true);
		expect(isJunkTitle("Testing strategy for Q4")).toBe(false);
		expect(isJunkTitle(null)).toBe(false);
	});

	it("resolves titles from title, summary first line, or untitled placeholder across Notion, Drive, and Gmail fixtures", () => {
		// Notion titled page
		expect(resolveTitle("notion", { external_id: "1", title: "  Real Title  " })).toBe(
			"Real Title",
		);
		// Gmail thread with empty subject falling back to summary snippet
		expect(
			resolveTitle("gmail", {
				external_id: "msg-2",
				title: "",
				summary: "First line summary\nSecond line",
			}),
		).toBe("First line summary");
		// Notion untitled typed database item
		expect(resolveTitle("notion", { external_id: "3", title: null, type: "Task" })).toBe(
			"(untitled Task)",
		);
		// Drive untitled file without summary or type
		expect(resolveTitle("gdrive", { external_id: "drive-4" })).toBe("(untitled gdrive)");
		expect(resolveTitle("notion", { external_id: "4" })).toBe("(untitled notion)");
		expect(firstLine("a".repeat(200)).endsWith("…")).toBe(true);
	});

	it("computes pointerDescription and pointerEmbedText from source text only", () => {
		const untitled: DiscoverItem = { external_id: "1" };
		expect(pointerDescription(untitled)).toBeNull();
		expect(pointerEmbedText(untitled, "(untitled notion)")).toBeNull();

		const titled: DiscoverItem = {
			external_id: "2",
			title: "Q3 Board Deck",
			summary: "Financials and roadmap",
		};
		expect(pointerDescription(titled)).toBe("Financials and roadmap");
		expect(pointerEmbedText(titled, "Q3 Board Deck")).toBe(
			"Q3 Board Deck\n\nFinancials and roadmap",
		);
	});

	it("computes pointerProcessingStatus and pointerUrl", () => {
		expect(
			pointerProcessingStatus("gdrive", {
				external_id: "1",
				mime_type: "application/pdf",
			}),
		).toBe("pending");
		expect(
			pointerProcessingStatus("gdrive", {
				external_id: "2",
				mime_type: "application/vnd.google-apps.folder",
			}),
		).toBe("completed");
		expect(
			pointerProcessingStatus("onedrive", {
				external_id: "od-1",
				mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			}),
		).toBe("pending");
		expect(pointerProcessingStatus("notion", { external_id: "3" })).toBe("completed");
		expect(pointerUrl("notion", "abc", undefined)).toBe("discovered://notion/abc");
		expect(pointerUrl("notion", "abc", "https://notion.so/abc")).toBe("https://notion.so/abc");
	});

	it("builds envelopeFields, discoveryMetadata, driveColumns, and originatedAt", () => {
		const item: DiscoverItem = {
			external_id: "f1",
			owner_email: "a@example.com",
			mime_type: "application/pdf",
			size: 1024,
			parents: ["p1"],
			source_created_at: "2020-01-02T03:04:05.000Z",
		};
		expect(envelopeFields(item)).toEqual({
			owner_email: "a@example.com",
			mime_type: "application/pdf",
			size: 1024,
			parents: ["p1"],
		});
		expect(driveColumns("gdrive", item)).toEqual({
			source_drive_file_id: "f1",
			source_parent_folder_ids: ["p1"],
		});
		expect(driveColumns("onedrive", item)).toEqual({});
		expect(driveColumns("notion", item)).toEqual({});
		expect(originatedAt("gdrive", item)).toEqual({
			originated_at: "2020-01-02T03:04:05.000Z",
		});
		expect(originatedAt("onedrive", item)).toEqual({
			originated_at: "2020-01-02T03:04:05.000Z",
		});
		expect(originationFor("unknown", item)).toBeUndefined();
		const meta = discoveryMetadata("gdrive", item, "2026-10-16T00:00:00.000Z", undefined);
		expect(meta.discovery.connector).toBe("gdrive");
		expect(meta.discovery.mime_type).toBe("application/pdf");
	});

	it("detects when an existing row needs envelope refresh", () => {
		const priorMissing: ExistingRow = {
			id: "r1",
			source: "f1",
			processing_metadata: { discovery: { connector: "gdrive" } },
		};
		const priorPresent: ExistingRow = {
			id: "r2",
			source: "f2",
			processing_metadata: { discovery: { connector: "gdrive", mime_type: "application/pdf" } },
		};
		expect(needsEnvelopeRefresh(priorMissing, { external_id: "f1", mime_type: "application/pdf" })).toBe(
			true,
		);
		expect(needsEnvelopeRefresh(priorPresent, { external_id: "f2", mime_type: "application/pdf" })).toBe(
			false,
		);
	});
});

describe("domain/ingest/exclusions (#1545)", () => {
	describe("evaluateExclusion - folders", () => {
		it("excludes items in node_modules", () => {
			const res = evaluateExclusion({ title: "node_modules/react/index.js" });
			expect(res.excluded).toBe(true);
			expect(res.reason).toBe("excluded_folder:node_modules");
		});

		it("excludes items with .git in path or external_id", () => {
			const res = evaluateExclusion({ external_id: "projects/.git/HEAD" });
			expect(res.excluded).toBe(true);
			expect(res.reason).toBe("excluded_folder:.git");
		});

		it("excludes items in .next build directory", () => {
			const res = evaluateExclusion({ title: ".next/server/pages/index.html" });
			expect(res.excluded).toBe(true);
			expect(res.reason).toBe("excluded_folder:.next");
		});

		it("excludes items in dist or build folders", () => {
			expect(evaluateExclusion({ title: "dist/bundle.js" }).excluded).toBe(true);
			expect(evaluateExclusion({ url: "https://example.com/build/output.html" }).excluded).toBe(true);
		});

		it("excludes items in .turbo or target folders", () => {
			expect(evaluateExclusion({ title: ".turbo/cache/xyz" }).excluded).toBe(true);
			expect(evaluateExclusion({ envelope: { path: "rust/target/debug/binary" } }).excluded).toBe(true);
		});
	});

	describe("evaluateExclusion - extensions", () => {
		it("excludes .DS_Store files", () => {
			const res = evaluateExclusion({ title: ".DS_Store" });
			expect(res.excluded).toBe(true);
			expect(res.reason).toBe("excluded_extension:.ds_store");
		});

		it("excludes TypeScript and JavaScript files", () => {
			expect(evaluateExclusion({ title: "server.ts" }).excluded).toBe(true);
			expect(evaluateExclusion({ title: "component.tsx" }).excluded).toBe(true);
			expect(evaluateExclusion({ title: "script.js" }).excluded).toBe(true);
			expect(evaluateExclusion({ title: "util.mjs" }).excluded).toBe(true);
		});

		it("excludes Python, Rust, Go, and compiled binaries", () => {
			expect(evaluateExclusion({ title: "main.py" }).excluded).toBe(true);
			expect(evaluateExclusion({ title: "lib.rs" }).excluded).toBe(true);
			expect(evaluateExclusion({ title: "handler.go" }).excluded).toBe(true);
			expect(evaluateExclusion({ title: "app.wasm" }).excluded).toBe(true);
		});

		it("excludes source maps and lockfiles", () => {
			expect(evaluateExclusion({ title: "bundle.js.map" }).excluded).toBe(true);
			expect(evaluateExclusion({ title: "package-lock.json" }).excluded).toBe(false);
			expect(evaluateExclusion({ title: "yarn.lock" }).excluded).toBe(true);
			expect(evaluateExclusion({ title: "Cargo.lock" }).excluded).toBe(true);
		});

		it("permits regular documents and notes", () => {
			expect(evaluateExclusion({ title: "Angus_Hally_CV_Sep_2026.docx" }).excluded).toBe(false);
			expect(evaluateExclusion({ title: "Financial_Model.xlsx" }).excluded).toBe(false);
			expect(evaluateExclusion({ title: "Pitch_Deck.pdf" }).excluded).toBe(false);
			expect(evaluateExclusion({ title: "Architecture_ADR.md" }).excluded).toBe(false);
		});
	});

	describe("evaluateExclusion - mime types", () => {
		it("excludes code and archive mime types", () => {
			expect(evaluateExclusion({ title: "bundle", mime_type: "application/javascript" }).excluded).toBe(true);
			expect(evaluateExclusion({ title: "source", mime_type: "text/x-python" }).excluded).toBe(true);
			expect(evaluateExclusion({ title: "source", mime_type: "text/x-typescript" }).excluded).toBe(true);
			expect(evaluateExclusion({ title: "archive", mime_type: "application/zip" }).excluded).toBe(true);
		});

		it("permits Google Doc and document mime types", () => {
			expect(
				evaluateExclusion({
					title: "Product Spec",
					mime_type: "application/vnd.google-apps.document",
				}),
			).toEqual({ excluded: false });
			expect(evaluateExclusion({ title: "doc", mime_type: "application/pdf" }).excluded).toBe(false);
			expect(
				evaluateExclusion({
					title: "doc",
					mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				}).excluded,
			).toBe(false);
			expect(evaluateExclusion({ title: "plain", mime_type: "text/plain" }).excluded).toBe(false);
		});
	});

	describe("explicit list overrides", () => {
		it("respects custom folders, extensions, and mimeTypes arguments", () => {
			expect(
				evaluateExclusion({ title: "custom_dir/file.txt" }, { folders: ["custom_dir"] }).excluded,
			).toBe(true);
			expect(
				evaluateExclusion({ title: "node_modules/file.txt" }, { folders: ["custom_dir"] }).excluded,
			).toBe(false);
			expect(
				evaluateExclusion({ title: "file.bak" }, { extensions: [".bak"] }).excluded,
			).toBe(true);
			expect(
				evaluateExclusion({ mime_type: "text/custom" }, { mimeTypes: ["text/custom"] }).excluded,
			).toBe(true);
			expect(DEFAULT_EXCLUDED_FOLDERS.length).toBeGreaterThan(0);
			expect(DEFAULT_EXCLUDED_EXTENSIONS.length).toBeGreaterThan(0);
			expect(DEFAULT_EXCLUDED_MIME_TYPES.length).toBeGreaterThan(0);
		});
	});
});

