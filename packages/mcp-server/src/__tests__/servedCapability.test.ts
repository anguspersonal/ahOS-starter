import { describe, expect, it } from "vitest";
import { wrapServedCapabilityBody } from "@ahkms/core/actions";
import { serverRegistry } from "../actions/serverRegistry.js";
import { toMcpTool } from "../actions/index.js";
import { supabase } from "../supabase.js";

describe("wrapServedCapabilityBody (#810)", () => {
	it("returns body unchanged when storage_location is kms-db", () => {
		const body = "---\nname: my-skill\n---\n\n# Instructions\nStep 1.";
		expect(wrapServedCapabilityBody(body, "kms-db", null)).toBe(body);
	});

	it("prepends snapshot preamble for kms-repo without frontmatter", () => {
		const body = "# Instructions\nStep 1.";
		const result = wrapServedCapabilityBody(body, "kms-repo", "docs/skills/test/SKILL.md");
		expect(result).toBe(
			"> ⚠ SNAPSHOT. Canonical home: `kms-repo` at `docs/skills/test/SKILL.md`. This copy is served for execution only; editing it changes nothing and is lost on the next sync. If this protocol is wrong: do not fix it here. File a GitHub issue against the home repo, label `skills`, quoting the failing step and what you did instead, then continue the run.\n\n# Instructions\nStep 1.",
		);
	});

	it("prepends snapshot preamble after frontmatter for non-kms-db locations", () => {
		const body = "---\nname: test-skill\ndescription: A test\n---\n\n# Instructions\nStep 1.";
		const result = wrapServedCapabilityBody(body, "claude", "https://github.com/org/repo");
		expect(result).toBe(
			"---\nname: test-skill\ndescription: A test\n---\n\n> ⚠ SNAPSHOT. Canonical home: `claude` at `https://github.com/org/repo`. This copy is served for execution only; editing it changes nothing and is lost on the next sync. If this protocol is wrong: do not fix it here. File a GitHub issue against the home repo, label `skills`, quoting the failing step and what you did instead, then continue the run.\n\n# Instructions\nStep 1.",
		);
	});

	it("merges snapshot preamble and existing bundle pointer (#728) into a single header block", () => {
		const body =
			"---\nname: multi-file\n---\n\n" +
			"> **This file travels with its supporting files carried below.** Where a step above names\n" +
			'> a path, read the matching heading in the "Bundled supporting files" appendix at the\n' +
			"> end of this document instead of opening it on disk.\n\n" +
			"# Instructions\nStep 1.";
		const result = wrapServedCapabilityBody(body, "kms-repo", "skills/multi/SKILL.md");

		const expectedHeader =
			"> ⚠ SNAPSHOT. Canonical home: `kms-repo` at `skills/multi/SKILL.md`. This copy is served for execution only; editing it changes nothing and is lost on the next sync. If this protocol is wrong: do not fix it here. File a GitHub issue against the home repo, label `skills`, quoting the failing step and what you did instead, then continue the run.\n" +
			">\n" +
			"> **This file travels with its supporting files carried below.** Where a step above names\n" +
			'> a path, read the matching heading in the "Bundled supporting files" appendix at the\n' +
			"> end of this document instead of opening it on disk.";

		expect(result).toBe(`---\nname: multi-file\n---\n\n${expectedHeader}\n\n# Instructions\nStep 1.`);
	});

	it("handles CRLF line endings gracefully", () => {
		const body = "---\r\nname: crlf-skill\r\n---\r\n\r\n# Instructions\r\nStep 1.";
		const result = wrapServedCapabilityBody(body, "openai", "https://openai.com");
		expect(result).toContain("⚠ SNAPSHOT. Canonical home: `openai` at `https://openai.com`.");
		expect(result).toContain("# Instructions\nStep 1.");
	});

	it("handles null storage_url gracefully", () => {
		const body = "# Instructions\nStep 1.";
		const result = wrapServedCapabilityBody(body, "kms-repo", null);
		expect(result).toContain("Canonical home: `kms-repo` at `(unknown)`.");
	});

	it("resolveCapabilityHandler wraps external capability with snapshot preamble", async () => {
		const resolveCapabilityHandler = (args: Record<string, unknown>) =>
			toMcpTool(serverRegistry().get("capability_resolve")!).handler(args);
		const orig = supabase.from;
		try {
			(supabase as any).from = () => {
				const filters: Record<string, unknown> = {};
				const builder: any = {
					select: () => builder,
					eq: (col: string, val: unknown) => {
						filters[col] = val;
						return builder;
					},
					order: () => builder,
					then: (resolve: any) => {
						if (filters.entity_type === "domain") {
							return resolve({
								data: [{ id: "dom-angus", title: "angus" }],
								error: null,
							});
						}
						return resolve({
							data: [
								{
									id: "cap-test",
									title: "test-cap",
									properties: {
										body: "# Test\nRun step.",
										storage_location: "kms-repo",
										storage_url: "skills/test/SKILL.md",
									},
								},
							],
							error: null,
						});
					},
				};
				return builder;
			};
			const res = await resolveCapabilityHandler({ name: "test-cap", domain: "angus" });
			expect(res.content[0].text).toContain("⚠ SNAPSHOT. Canonical home: `kms-repo` at `skills/test/SKILL.md`.");
			expect(res.content[0].text).toContain("# Test\nRun step.");
		} finally {
			(supabase as any).from = orig;
		}
	});
});
