import { describe, expect, it } from "vitest";
import { DEFAULT_DOS_CONFIG, type DosConfig } from "./dosConfig.js";
import {
	matchesDomainSignals,
	resolveEntityDomain,
	resolveEntityDomainSafely,
	type EntityDomainReader,
	type EntityDomainRow,
} from "./entityDomain.js";

const TEST_DOS_CONFIG: DosConfig = {
	...DEFAULT_DOS_CONFIG,
	by_domain: {
		work: {
			...DEFAULT_DOS_CONFIG.by_domain.work,
			domain_signals: ["Work", "Round"],
		},
		angus: {
			...DEFAULT_DOS_CONFIG.by_domain.angus,
			domain_signals: ["wedding", "Laura"],
		},
	},
};

function makeFakeReader(
	entities: Array<Partial<EntityDomainRow> & { id: string }>,
	edges: Record<string, string> = {},
): EntityDomainReader {
	const byId = new Map(
		entities.map((e) => [
			e.id,
			{
				id: e.id,
				title: e.title ?? null,
				description: e.description ?? null,
				tags: e.tags ?? null,
				properties: e.properties ?? null,
				domain_override: e.domain_override ?? null,
			},
		]),
	);
	return {
		async getDomainRow(id: string) {
			return byId.get(id) ?? null;
		},
		async fetchPrimaryParentId(id: string) {
			return edges[id] ?? null;
		},
	};
}

describe("entityDomain (core over EntityRepository)", () => {
	it("matchesDomainSignals performs case-insensitive substring matching and skips blanks", () => {
		expect(matchesDomainSignals("the Work round closed", ["work"])).toBe(true);
		expect(matchesDomainSignals("nothing relevant", ["work", "   "])).toBe(false);
	});

	it("resolves override, is_self, parent chain, signals fallback, cycle and missing entity", async () => {
		const repo = makeFakeReader(
			[
				{ id: "override-1", title: "Work", domain_override: "angus" },
				{ id: "self-1", title: "Owner", properties: { is_self: true } },
				{ id: "area", title: "Wedding", domain_override: "angus" },
				{ id: "project", title: "Project" },
				{ id: "task", title: "Task" },
				{ id: "sig-1", title: "Coffee with Laura" },
				{ id: "cyc-a", title: "A" },
				{ id: "cyc-b", title: "B" },
			],
			{
				task: "project",
				project: "area",
				"cyc-a": "cyc-b",
				"cyc-b": "cyc-a",
			},
		);

		expect(await resolveEntityDomain(repo, "override-1", { dosConfig: TEST_DOS_CONFIG })).toEqual({
			domain: "angus",
			resolved_by: "override",
			path: ["override-1"],
		});
		expect(await resolveEntityDomain(repo, "self-1", { dosConfig: TEST_DOS_CONFIG })).toEqual({
			domain: "cross-domain",
			resolved_by: "is_self",
			path: ["self-1"],
		});
		expect(await resolveEntityDomain(repo, "task", { dosConfig: TEST_DOS_CONFIG })).toEqual({
			domain: "angus",
			resolved_by: "parent",
			path: ["task", "project", "area"],
		});
		expect(await resolveEntityDomain(repo, "sig-1", { dosConfig: TEST_DOS_CONFIG })).toEqual({
			domain: "angus",
			resolved_by: "signals",
			path: ["sig-1"],
		});
		expect(await resolveEntityDomain(repo, "cyc-a", { dosConfig: TEST_DOS_CONFIG }).then((r) => r.resolved_by)).toBe(
			"unresolved",
		);
		expect(await resolveEntityDomain(repo, "missing", { dosConfig: TEST_DOS_CONFIG })).toEqual({
			domain: null,
			resolved_by: "unresolved",
			path: ["missing", "not-found"],
		});
	});

	it("resolveEntityDomainSafely degrades thrown repository errors to unresolved", async () => {
		const failingRepo: EntityDomainReader = {
			async getDomainRow() {
				throw new Error("db down");
			},
			async fetchPrimaryParentId() {
				return null;
			},
		};
		const res = await resolveEntityDomainSafely(failingRepo, "e1");
		expect(res).toEqual({
			domain: null,
			resolved_by: "unresolved",
			path: ["e1", "resolution-error: db down"],
		});
	});
});
