import { describe, expect, it } from "vitest";
import { canonicalize, hashBody } from "./hash.js";

describe("canonicalize", () => {
	it("normalises CRLF and lone CR to LF", () => {
		expect(canonicalize("a\r\nb\rc")).toBe("a\nb\nc\n");
	});

	it("strips trailing spaces and tabs per line", () => {
		expect(canonicalize("a   \nb\t\n")).toBe("a\nb\n");
	});

	it("collapses trailing blank lines to a single trailing newline", () => {
		expect(canonicalize("a\n\n\n")).toBe("a\n");
	});

	it("returns empty string for whitespace-only input", () => {
		expect(canonicalize("\n \t\n")).toBe("");
	});
});

describe("hashBody", () => {
	it("is stable across incidental whitespace differences", () => {
		expect(hashBody("hello world")).toBe(hashBody("hello world  \r\n"));
	});

	it("differs when real content differs", () => {
		expect(hashBody("hello")).not.toBe(hashBody("hallo"));
	});

	it("treats the x-upstream block as content (not stripped)", () => {
		const withBlock = "---\nx-upstream:\n  repo: a/b\n---\nbody";
		const without = "---\n---\nbody";
		expect(hashBody(withBlock)).not.toBe(hashBody(without));
	});
});
