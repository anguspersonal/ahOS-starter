import { describe, expect, it } from "vitest";
import {
	ARTIFACT_SURFACES,
	deriveArtifactTitle,
	deriveTitleFromFilename,
	deriveTitleFromText,
	slugify,
} from "./artifacts.js";

describe("domain/artifacts", () => {
	it("derives title preferring explicit title > first non-blank line (120 chars) > filename without extension > null", () => {
		expect(
			deriveArtifactTitle({
				explicitTitle: "  Explicit Title  ",
				text: "First line\nSecond line",
				filename: "doc.pdf",
			}),
		).toBe("Explicit Title");

		const longLine = "a".repeat(200);
		expect(
			deriveArtifactTitle({
				explicitTitle: "   ",
				text: `\n  \r\n  ${longLine}\nSecond line`,
				filename: "doc.pdf",
			}),
		).toBe("a".repeat(120));

		expect(
			deriveArtifactTitle({
				text: "   \n\t\n",
				filename: "quarterly-report.v2.pdf",
			}),
		).toBe("quarterly-report.v2");

		expect(deriveArtifactTitle({ text: "", filename: ".gitignore" })).toBeNull();
		expect(deriveTitleFromText(null)).toBeNull();
		expect(deriveTitleFromFilename("   ")).toBeNull();
	});

	it("slugifies strings, falls back to 'note' for symbols, and caps at 60 characters", () => {
		expect(slugify("Hello, World!")).toBe("hello-world");
		expect(slugify("!!!@@@###$$$")).toBe("note");
		expect(slugify("")).toBe("note");
		const longSlug = slugify("word-".repeat(20));
		expect(longSlug.length).toBeLessThanOrEqual(60);
	});

	it("exports canonical ARTIFACT_SURFACES values", () => {
		expect(ARTIFACT_SURFACES.api).toBe("api");
		expect(ARTIFACT_SURFACES.actReceipt).toBe("act_receipt");
		expect(ARTIFACT_SURFACES.slackDm).toBe("slack_dm");
	});
});
