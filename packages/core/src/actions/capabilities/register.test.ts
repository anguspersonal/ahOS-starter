import { describe, expect, it } from "vitest";
import { createCapabilityRegisterAction } from "./register.js";
import type { ActionContext } from "../types.js";
import type {
	CapabilityEntityRow,
	CapabilityInsertInput,
	CapabilityRepository,
	CapabilityUpdatePatch,
} from "../../ports/capabilities.js";

const ctx: ActionContext = { userId: "u1", caller: "mcp", requestId: "req-1" };

function makeStore(initial: CapabilityEntityRow[] = []) {
	const inserted: CapabilityInsertInput[] = [];
	const updated: Array<{ id: string; patch: CapabilityUpdatePatch }> = [];
	const repo: CapabilityRepository = {
		list: async () => initial,
		findByName: async (name) =>
			initial.find((r) => (r.title ?? "").toLowerCase() === name.toLowerCase()) ?? null,
		insert: async (row) => {
			inserted.push(row);
			return { id: "new-cap-id" };
		},
		update: async (id, patch) => {
			updated.push({ id, patch });
		},
	};
	return { repo, inserted, updated };
}

describe("createCapabilityRegisterAction (#1593)", () => {
	it("creates a new capability and maps personal scope/domain to domain_override 'angus'", async () => {
		const { repo, inserted } = makeStore();
		const action = createCapabilityRegisterAction(repo);
		const out = await action.run(
			{
				name: "my-skill",
				description: "Test skill",
				kind: ["skill", "agent"],
				surface: ["claude-code"],
				clients: ["terminal"],
				domain: "angus",
				storage_location: "kms-db",
				body: "skill body",
			},
			ctx,
		);
		expect(out.created).toBe(true);
		expect(out.id).toBe("new-cap-id");
		expect(out.text).toBe("Registered capability [new-cap-id] my-skill (skill+agent, kms-db).");
		expect(inserted).toHaveLength(1);
		expect(inserted[0].domain_override).toBe("angus");
		expect(inserted[0].properties.scope).toBe("personal");
	});

	it("updates an existing capability and strips legacy tags", async () => {
		const { repo, updated } = makeStore([
			{
				id: "cap-existing",
				title: "my-skill",
				description: "Old",
				properties: {},
				tags: ["also:skill", "drift:twin-unsourced", "scope:personal", "keep"],
				archived: false,
				created_at: null,
				updated_at: null,
			},
		]);
		const action = createCapabilityRegisterAction(repo);
		const out = await action.run(
			{
				name: "my-skill",
				kind: "skill",
				surface: ["claude-code"],
				storage_location: "kms-repo",
				storage_url: "skills/my-skill/SKILL.md",
			},
			ctx,
		);
		expect(out.created).toBe(false);
		expect(out.text).toBe("Updated capability [cap-existing] my-skill (skill, kms-repo).");
		expect(updated).toHaveLength(1);
		expect(updated[0].patch.tags).toEqual(["keep"]);
	});

	it("warns when creating a near-duplicate or mode-sibling capability name", async () => {
		const { repo } = makeStore([
			{
				id: "cap-retro",
				title: "retro",
				description: "Retro",
				properties: { kind: ["skill"], surface: ["claude-code"], storage_location: "kms-db", body: "b" },
				tags: [],
				archived: false,
				created_at: null,
				updated_at: null,
			},
		]);
		const action = createCapabilityRegisterAction(repo);
		const nearDup = await action.run(
			{
				name: "retros",
				kind: "skill",
				surface: ["claude-code"],
				storage_location: "kms-db",
				body: "body",
			},
			ctx,
		);
		expect(nearDup.created).toBe(true);
		expect(nearDup.text).toContain("Note: similar capability name(s) already registered ('retro')");

		const modeSibling = await action.run(
			{
				name: "check-retro",
				kind: "skill",
				surface: ["claude-code"],
				storage_location: "kms-db",
				body: "body",
			},
			ctx,
		);
		expect(modeSibling.created).toBe(true);
		expect(modeSibling.text).toContain("Note: similar capability name(s) already registered ('retro')");

		const substringDup = await action.run(
			{
				name: "retro-session",
				kind: "skill",
				surface: ["claude-code"],
				storage_location: "kms-db",
				body: "body",
			},
			ctx,
		);
		expect(substringDup.created).toBe(true);
		expect(substringDup.text).toContain("Note: similar capability name(s) already registered ('retro')");

		const { repo: checkOnlyRepo } = makeStore([
			{
				id: "cap-check-retro",
				title: "check-retro",
				description: "Check retro",
				properties: { kind: ["skill"], surface: ["claude-code"], storage_location: "kms-db", body: "b" },
				tags: [],
				archived: false,
				created_at: null,
				updated_at: null,
			},
		]);
		const checkOnlyAction = createCapabilityRegisterAction(checkOnlyRepo);
		const crossPrefixSibling = await checkOnlyAction.run(
			{
				name: "verify-retro",
				kind: "skill",
				surface: ["claude-code"],
				storage_location: "kms-db",
				body: "body",
			},
			ctx,
		);
		expect(crossPrefixSibling.created).toBe(true);
		expect(crossPrefixSibling.text).toContain("Note: similar capability name(s) already registered ('check-retro')");
	});

	it("preserves repo_mirror and warns when updating a repo-mirrored skill directly", async () => {
		const { repo, updated } = makeStore([
			{
				id: "cap-dos",
				title: "dos",
				description: "DOS ritual",
				properties: {
					kind: ["skill"],
					surface: ["claude-code"],
					storage_location: "kms-db",
					repo_mirror: ".claude/skills/dos/SKILL.md",
					body: "old",
				},
				tags: [],
				archived: false,
				created_at: null,
				updated_at: null,
			},
		]);
		const action = createCapabilityRegisterAction(repo);
		const out = await action.run(
			{
				name: "dos",
				kind: "skill",
				surface: ["claude-code"],
				storage_location: "kms-db",
				body: "new",
			},
			ctx,
		);
		expect(out.created).toBe(false);
		expect(out.text).toContain("Warning: 'dos' is mirrored from .claude/skills/dos/SKILL.md");
		expect(updated[0].patch.properties.repo_mirror).toBe(".claude/skills/dos/SKILL.md");
	});

	it("enforces conditional storage_location rules and domain/scope agreement", async () => {
		const { repo } = makeStore();
		const action = createCapabilityRegisterAction(repo);

		await expect(
			action.run(
				{
					name: "missing-body",
					kind: "skill",
					surface: ["claude-code"],
					storage_location: "kms-db",
				},
				ctx,
			),
		).rejects.toThrow(/body is required when storage_location='kms-db'/);

		await expect(
			action.run(
				{
					name: "conflict",
					kind: "skill",
					surface: ["claude-code"],
					domain: "work",
					scope: "personal",
					storage_location: "kms-db",
					body: "b",
				},
				ctx,
			),
		).rejects.toThrow(/disagree/);
	});
});
