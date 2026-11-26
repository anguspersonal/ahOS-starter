import { describe, expect, it, vi } from "vitest";
import type { ActionContext } from "../types.js";
import type { LinkRepository } from "../../ports/entities.js";
import {
	LINK_CREATE_DESCRIPTION,
	LINK_DELETE_DESCRIPTION,
	LINK_UPSERT_DESCRIPTION,
	createLinkCreateAction,
	createLinkDeleteAction,
	createLinkUpsertAction,
} from "./links.js";

const ARTIFACT_ID_1 = "22222222-2222-4222-8222-222222222222";
const ARTIFACT_ID_2 = "55555555-5555-4555-8555-555555555555";
const ENTITY_ID_1 = "33333333-3333-4333-8333-333333333333";
const LINK_ID_1 = "11111111-1111-4111-8111-111111111111";

function makeCtx(userId = "aaaa0000-0000-4000-8000-000000000001"): ActionContext {
	return {
		caller: "mcp",
		userId,
		requestId: "req-link-write-1",
	};
}

describe("link_create, link_upsert, and link_delete core actions (#1474)", () => {
	it("registers contracts, annotations, and default exposure for link_create, link_upsert, and link_delete", () => {
		const repo: LinkRepository = {
			get: vi.fn(),
			query: vi.fn(),
			create: vi.fn(),
			upsert: vi.fn(),
			delete: vi.fn(),
		};

		const createAction = createLinkCreateAction(repo);
		const upsertAction = createLinkUpsertAction(repo);
		const deleteAction = createLinkDeleteAction(repo);

		expect(createAction.id).toBe("link_create");
		expect(createAction.description).toBe(LINK_CREATE_DESCRIPTION);
		expect(createAction.domain).toBe("kg");
		expect(createAction.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		});

		expect(upsertAction.id).toBe("link_upsert");
		expect(upsertAction.description).toBe(LINK_UPSERT_DESCRIPTION);
		expect(upsertAction.domain).toBe("kg");
		expect(upsertAction.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});

		expect(deleteAction.id).toBe("link_delete");
		expect(deleteAction.description).toBe(LINK_DELETE_DESCRIPTION);
		expect(deleteAction.domain).toBe("kg");
		expect(deleteAction.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: false,
		});
	});

	it("link_create forwards links and userId to LinkRepository.create and formats MCP output", async () => {
		const repo: LinkRepository = {
			get: vi.fn(),
			query: vi.fn(),
			create: vi.fn().mockResolvedValue([
				{ id: LINK_ID_1, artifact_id: ARTIFACT_ID_1, entity_id: ENTITY_ID_1 },
			]),
		};
		const action = createLinkCreateAction(repo);
		const ctx = makeCtx();
		const links = [
			{
				artifact_id: ARTIFACT_ID_1,
				entity_id: ENTITY_ID_1,
				link_type: "mentions",
				confidence_score: 0.9,
			},
		];

		const res = await action.run({ links }, ctx);
		expect(res.count).toBe(1);
		expect(action.formatMcp!(res)).toBe("Created 1 artifact-entity link(s).");
		expect(repo.create).toHaveBeenCalledWith(links, ctx.userId);
	});

	it("link_upsert forwards links, mark_artifact_derived, and userId to LinkRepository.upsert and formats MCP output", async () => {
		const repo: LinkRepository = {
			get: vi.fn(),
			query: vi.fn(),
			upsert: vi.fn().mockResolvedValue([
				{ id: LINK_ID_1, artifact_id: ARTIFACT_ID_1, entity_id: ENTITY_ID_1, link_type: "mentions" },
				{ id: "44444444-4444-4444-8444-444444444444", artifact_id: ARTIFACT_ID_2, entity_id: ENTITY_ID_1, link_type: "related" },
			]),
		};
		const action = createLinkUpsertAction(repo);
		const ctx = makeCtx();
		const links = [
			{ artifact_id: ARTIFACT_ID_1, entity_id: ENTITY_ID_1, link_type: "mentions" },
			{ artifact_id: ARTIFACT_ID_2, entity_id: ENTITY_ID_1 },
		];

		const res = await action.run({ links, mark_artifact_derived: true }, ctx);
		expect(res.count).toBe(2);
		expect(action.formatMcp!(res)).toBe("Upserted 2 artifact-entity link(s).");
		expect(repo.upsert).toHaveBeenCalledWith(links, {
			markArtifactDerived: true,
			userId: ctx.userId,
		});
	});

	it("link_delete formats miss and hit MCP messages and forwards id and userId to LinkRepository.delete", async () => {
		const repo: LinkRepository = {
			get: vi.fn(),
			query: vi.fn(),
			delete: vi
				.fn()
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([{ id: LINK_ID_1, artifact_id: ARTIFACT_ID_1, entity_id: ENTITY_ID_1 }]),
		};
		const action = createLinkDeleteAction(repo);
		const ctx = makeCtx();

		const miss = await action.run({ id: LINK_ID_1 }, ctx);
		expect(miss.deleted).toBe(false);
		expect(action.formatMcp!(miss)).toBe("No artifact-entity link deleted.");

		const hit = await action.run({ id: LINK_ID_1 }, ctx);
		expect(hit.deleted).toBe(true);
		expect(action.formatMcp!(hit)).toBe(`Deleted artifact-entity link ${LINK_ID_1}.`);
		expect(repo.delete).toHaveBeenCalledWith(LINK_ID_1, ctx.userId);
	});
});
