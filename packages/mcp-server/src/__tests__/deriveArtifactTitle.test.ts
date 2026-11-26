import { describe, expect, it } from "vitest";
import { deriveArtifactTitle, deriveTitleFromFilename, deriveTitleFromText } from "@ahkms/shared";

// Regression coverage for #131 (artifacts from web_upload could get a null
// title). This shared helper is the single implementation now used by the
// capture MCP tool and the worker's web_upload/phone_app/api ingestion path
// (packages/worker/src/workflows/steps/createArtifact.ts), so its edge cases
// are pinned here once instead of per-writer.

describe("deriveTitleFromText", () => {
	it("returns the first non-blank line, trimmed", () => {
		expect(deriveTitleFromText("Connection Crew @12 March 2026 16:30\n\nBody text...")).toBe(
			"Connection Crew @12 March 2026 16:30",
		);
	});

	it("skips leading blank lines to find the first non-blank one", () => {
		expect(deriveTitleFromText("\n   \nActual first line\nsecond line")).toBe("Actual first line");
	});

	it("truncates to the max length (default 120)", () => {
		const longLine = "A".repeat(300);
		const title = deriveTitleFromText(longLine);
		expect(title).toHaveLength(120);
	});

	it("respects a custom max length", () => {
		const longLine = "B".repeat(300);
		expect(deriveTitleFromText(longLine, 80)).toHaveLength(80);
	});

	it("returns null for empty content", () => {
		expect(deriveTitleFromText("")).toBeNull();
	});

	it("returns null for whitespace-only content", () => {
		expect(deriveTitleFromText("   \n\t\n   ")).toBeNull();
	});

	it("returns null for null/undefined input", () => {
		expect(deriveTitleFromText(null)).toBeNull();
		expect(deriveTitleFromText(undefined)).toBeNull();
	});
});

describe("deriveTitleFromFilename", () => {
	it("strips a single extension", () => {
		expect(deriveTitleFromFilename("Quarterly Report.pdf")).toBe("Quarterly Report");
	});

	it("only strips the last extension (dotted names keep interior dots)", () => {
		expect(deriveTitleFromFilename("archive.tar.gz")).toBe("archive.tar");
	});

	it("returns the name unchanged when there is no extension", () => {
		expect(deriveTitleFromFilename("README")).toBe("README");
	});

	it("returns null for an empty or missing filename", () => {
		expect(deriveTitleFromFilename("")).toBeNull();
		expect(deriveTitleFromFilename(null)).toBeNull();
		expect(deriveTitleFromFilename(undefined)).toBeNull();
	});

	it("returns null (not empty string) for an extension-only filename", () => {
		// Regression for the "never empty" guarantee: the strip-extension regex
		// matches the *entire* string for a bare-extension filename like ".txt",
		// so a naive implementation returns "" instead of falling through.
		expect(deriveTitleFromFilename(".txt")).toBeNull();
		expect(deriveTitleFromFilename(".pdf")).toBeNull();
		expect(deriveTitleFromFilename(".json")).toBeNull();
	});
});

describe("deriveArtifactTitle", () => {
	it("prefers an explicit title over everything else", () => {
		expect(
			deriveArtifactTitle({
				explicitTitle: "My Chosen Title",
				text: "First line of body",
				filename: "upload.txt",
			}),
		).toBe("My Chosen Title");
	});

	it("falls back to first-line-of-text when no explicit title is given (filename also present)", () => {
		expect(
			deriveArtifactTitle({
				text: "Connection Crew @12 March 2026 16:30\nmore body",
				filename: "capture-abc123.txt",
			}),
		).toBe("Connection Crew @12 March 2026 16:30");
	});

	it("falls back to the filename (extension stripped) when there is no text content", () => {
		expect(
			deriveArtifactTitle({
				text: null,
				filename: "Quarterly Report.pdf",
			}),
		).toBe("Quarterly Report");
	});

	it("falls back to filename when text is empty/whitespace-only", () => {
		expect(
			deriveArtifactTitle({
				text: "   ",
				filename: "notes.txt",
			}),
		).toBe("notes");
	});

	it("returns null when there is neither text nor a filename", () => {
		expect(deriveArtifactTitle({ text: null, filename: null })).toBeNull();
	});

	it("treats a blank explicit title as absent and derives from text instead", () => {
		expect(
			deriveArtifactTitle({
				explicitTitle: "   ",
				text: "Real first line",
				filename: "x.txt",
			}),
		).toBe("Real first line");
	});

	it("never emits an empty-string title for an extension-only filename with no text (#131 follow-up)", () => {
		// deriveTitleFromFilename('.txt') would (pre-fix) return '', and the
		// caller-side `?? fallback` in createArtifact.ts only catches
		// null/undefined, not ''. This pins the fix at the composed level so
		// the empty-string title can never reach the DB from this input shape.
		expect(deriveArtifactTitle({ text: null, filename: ".txt" })).toBeNull();
		expect(deriveArtifactTitle({ text: "   ", filename: ".pdf" })).toBeNull();
	});
});
