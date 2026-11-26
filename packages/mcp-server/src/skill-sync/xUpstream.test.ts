import { describe, expect, it } from "vitest";
import { parseXUpstream, removeXUpstream, serializeXUpstream, stampXUpstream, type XUpstream } from "./xUpstream.js";

const X: XUpstream = {
	repo: "https://github.com/mattpocock/skills",
	path: "skills/engineering/implement/SKILL.md",
	baseCommit: "e9fcdf95b402d360f90f1db8d776d5dd450f9234",
	baseBlob: "7a0b11f5f4fe9505ea5c7983c3083ba1bf754f69",
	reviewed: "2026-07-15",
	localEdits: "remapped /code-review -> /qa-review",
};

const STAMPED = `---
name: implement
description: Implement a piece of work.
disable-model-invocation: true
${serializeXUpstream(X)}
---

Body here.
`;

describe("parseXUpstream", () => {
	it("round-trips a stamped block", () => {
		expect(parseXUpstream(STAMPED)).toEqual(X);
	});

	it("returns null when there is no x-upstream block", () => {
		expect(parseXUpstream("---\nname: x\n---\nbody")).toBeNull();
	});

	it("returns null when required keys are missing", () => {
		expect(parseXUpstream("---\nname: x\nx-upstream:\n  repo: r\n---\n")).toBeNull();
	});
});

describe("stampXUpstream", () => {
	it("inserts a block when none exists, preserving the body", () => {
		const src = "---\nname: implement\ndescription: d\n---\n\nBody here.\n";
		const out = stampXUpstream(src, X);
		expect(parseXUpstream(out)).toEqual(X);
		expect(out).toContain("name: implement");
		expect(out.endsWith("\n\nBody here.\n")).toBe(true);
	});

	it("replaces an existing block idempotently", () => {
		const once = stampXUpstream("---\nname: x\ndescription: d\n---\nbody\n", X);
		const twice = stampXUpstream(once, X);
		expect(twice).toBe(once);
		expect(parseXUpstream(twice)).toEqual(X);
	});

	it("advances only the base fields, leaving the body byte-identical", () => {
		const moved = stampXUpstream(STAMPED, { ...X, baseCommit: "NEWCOMMIT", baseBlob: "NEWBLOB" });
		expect(parseXUpstream(moved)?.baseCommit).toBe("NEWCOMMIT");
		expect(parseXUpstream(moved)?.baseBlob).toBe("NEWBLOB");
		expect(moved.endsWith("---\n\nBody here.\n")).toBe(true);
	});

	it("treats a $-sequence in a field value literally, not as a replacement pattern", () => {
		// String.prototype.replace's 2nd arg is special-cased for $&, $$, $1, etc. when
		// it's a plain string. stampXUpstream must use a function replacer so values like
		// this round-trip byte-for-byte instead of pulling in the matched frontmatter.
		const dollarX: XUpstream = { ...X, localEdits: "note: $& then $$ then $1 verbatim" };
		const src = "---\nname: implement\ndescription: d\n---\n\nBody here.\n";
		const out = stampXUpstream(src, dollarX);
		expect(parseXUpstream(out)).toEqual(dollarX);
		expect(out).toContain("note: $& then $$ then $1 verbatim");
	});
});

/**
 * #392: git-for-Windows installs with core.autocrlf=true, so a cloned upstream
 * SKILL.md arrives as `---\r\n…`. The LF-only frontmatter regex didn't match it,
 * and stampXUpstream's "no frontmatter" branch then PREPENDED a second, LF
 * frontmatter block — demoting the real one to body and cascading through
 * importUpstreamSkill -> walkFork into a corrupt file.
 *
 * These are written CRLF-first so they'd fail on the old implementation. Note
 * `countFrontmatter` rather than a plain round-trip assertion: the old code
 * produced output that parseXUpstream could still read (it found the *prepended*
 * block), which is exactly why upstream.test.ts stayed green over a corrupt
 * file. Well-formedness is the property that actually catches this.
 */
const crlf = (s: string) => s.replace(/\n/g, "\r\n");

/** How many `---` frontmatter delimiters open the file. A valid SKILL.md has one block. */
function countFrontmatter(md: string): number {
	return md.split(/\r?\n/).filter((l) => l === "---").length;
}

describe("xUpstream under CRLF (#392)", () => {
	const CRLF_SRC = crlf("---\nname: implement\ndescription: d\n---\n\nBody here.\n");

	it("stamps into an existing CRLF frontmatter instead of prepending a second block", () => {
		const out = stampXUpstream(CRLF_SRC, X);

		expect(countFrontmatter(out)).toBe(2); // exactly one block: an opener and a closer
		expect(parseXUpstream(out)).toEqual(X);
		expect(out).toContain("name: implement");
	});

	it("keeps the file CRLF throughout — no mixed endings in the stamped block", () => {
		const out = stampXUpstream(CRLF_SRC, X);

		// Every line break is CRLF: no bare \n survives anywhere.
		expect(/[^\r]\n/.test(out)).toBe(false);
		expect(out).toContain(`base_commit: ${X.baseCommit}\r\n`);
	});

	it("leaves the body byte-identical", () => {
		const out = stampXUpstream(CRLF_SRC, X);

		expect(out.endsWith("---\r\n\r\nBody here.\r\n")).toBe(true);
	});

	it("parses a CRLF-stamped block", () => {
		expect(parseXUpstream(crlf(STAMPED))).toEqual(X);
	});

	it("does not leak a carriage return into a parsed field value", () => {
		// splitLines strips \r before YAML sees it; otherwise base_blob would come
		// back as "…f69\r" and every fork-point comparison would mismatch.
		const parsed = parseXUpstream(crlf(STAMPED));

		expect(parsed?.baseBlob).toBe(X.baseBlob);
		expect(parsed?.repo).not.toMatch(/\r/);
	});

	it("is idempotent under CRLF", () => {
		const once = stampXUpstream(CRLF_SRC, X);
		const twice = stampXUpstream(once, X);

		expect(twice).toBe(once);
		expect(countFrontmatter(twice)).toBe(2);
	});

	it("round-trips stamp -> remove back to the original CRLF file", () => {
		const stamped = stampXUpstream(CRLF_SRC, X);

		expect(removeXUpstream(stamped)).toBe(CRLF_SRC);
	});

	it("still prepends LF frontmatter to an LF file that has none", () => {
		// The no-frontmatter branch infers EOL from the body, so a plain LF file
		// isn't dragged to CRLF just because it lacks frontmatter.
		const out = stampXUpstream("Just a body.\nNo frontmatter.\n", X);

		expect(out.startsWith("---\n")).toBe(true);
		expect(out).not.toContain("\r");
		expect(parseXUpstream(out)).toEqual(X);
	});

	it("prepends CRLF frontmatter to a CRLF file that has none", () => {
		const out = stampXUpstream(crlf("Just a body.\nNo frontmatter.\n"), X);

		expect(out.startsWith("---\r\n")).toBe(true);
		expect(/[^\r]\n/.test(out)).toBe(false);
		expect(parseXUpstream(out)).toEqual(X);
	});
});

describe("removeXUpstream", () => {
	it("strips the block, preserving the rest of the frontmatter and body", () => {
		const out = removeXUpstream(STAMPED);
		expect(out).toBe("---\nname: implement\ndescription: Implement a piece of work.\ndisable-model-invocation: true\n---\n\nBody here.\n");
		expect(parseXUpstream(out)).toBeNull();
	});

	it("returns the input unchanged when there is no x-upstream block", () => {
		const src = "---\nname: x\n---\nbody";
		expect(removeXUpstream(src)).toBe(src);
	});

	it("treats a $-sequence in a sibling frontmatter field literally, not as a replacement pattern", () => {
		// Same footgun as stampXUpstream: a $& in a remaining field would otherwise pull
		// the entire matched (pre-strip) frontmatter block back into the output.
		const stampedWithDollar = `---
name: implement
description: costs $& to run
${serializeXUpstream(X)}
---

Body here.
`;
		const out = removeXUpstream(stampedWithDollar);
		expect(out).toBe("---\nname: implement\ndescription: costs $& to run\n---\n\nBody here.\n");
		expect(parseXUpstream(out)).toBeNull();
	});
});
