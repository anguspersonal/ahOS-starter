import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "./frontmatter.js";

describe("parseFrontmatter", () => {
	it("reads name and description from a standard block", () => {
		const md = "---\nname: qa-review\ndescription: Review a PR against the rubric\n---\n\nBody here";
		expect(parseFrontmatter(md)).toEqual({ name: "qa-review", description: "Review a PR against the rubric" });
	});

	it("strips surrounding quotes", () => {
		expect(parseFrontmatter('---\ndescription: "quoted value"\n---\n')).toEqual({ description: "quoted value" });
	});

	it("tolerates CRLF line endings", () => {
		expect(parseFrontmatter("---\r\nname: x\r\n---\r\n")).toEqual({ name: "x" });
	});

	it("returns empty when there is no frontmatter", () => {
		expect(parseFrontmatter("# Just a heading\n")).toEqual({});
	});

	it("returns empty when the block is unterminated", () => {
		expect(parseFrontmatter("---\nname: x\n")).toEqual({});
	});

	// Block scalars matter because a registered capability's description is what a
	// surface sees BEFORE it fetches the body — and .claude/skills/dogfood really
	// does use `description: >`, which the naive reader turned into the string ">".
	describe("block scalars", () => {
		it("folds a `>` block into one paragraph", () => {
			const md = ["---", "name: dogfood", "description: >", "  Run the current chat", "  as a dogfooding session.", "---", ""].join("\n");
			expect(parseFrontmatter(md)).toEqual({ name: "dogfood", description: "Run the current chat as a dogfooding session." });
		});

		it("keeps the line breaks of a `|` block", () => {
			const md = ["---", "description: |", "  first", "  second", "---", ""].join("\n");
			expect(parseFrontmatter(md).description).toBe("first\nsecond");
		});

		it("accepts chomp indicators and stops at the next dedented key", () => {
			const md = ["---", "description: >-", "  folded text", "name: after", "---", ""].join("\n");
			expect(parseFrontmatter(md)).toEqual({ description: "folded text", name: "after" });
		});

		it("does not mistake a value that merely starts with > for a block scalar", () => {
			expect(parseFrontmatter("---\ndescription: > 100 items\n---\n")).toEqual({ description: "> 100 items" });
		});
	});
});
