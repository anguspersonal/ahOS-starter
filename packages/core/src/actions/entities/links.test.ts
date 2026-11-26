import { describe, expect, it, vi } from "vitest";
import type { ActionContext } from "../types.js";
import type { ArtifactEntityLinkRow, LinkRepository } from "../../ports/entities.js";
import {
	LINK_GET_DESCRIPTION,
	LINK_QUERY_DESCRIPTION,
	createLinkGetAction,
	createLinkQueryAction,
	formatArtifactEntityLinkRow,
} from "./links.js";

const SAMPLE_LINK: ArtifactEntityLinkRow = {
	id: "11111111-1111-4111-8111-111111111111",
	artifact_id: "22222222-2222-4222-8222-222222222222",
	entity_id: "33333333-3333-4333-8333-333333333333",
	link_type: "mentions",
	confidence_score: 0.9,
	created_by: "derive",
	notes: null,
	created_at: "2026-04-17T00:00:00.000Z",
};

function makeCtx(userId = "aaaa0000-0000-4000-8000-000000000001"): ActionContext {
	return {
		caller: "mcp",
		userId,
		requestId: "req-link-1",
	};
}

describe("link_get and link_query core actions (#1472)", () => {
	it("registers read-only contracts and default exposure for link_get and link_query", () => {
		const repo: LinkRepository = {
			get: vi.fn(),
			query: vi.fn(),
		};
		const getAction = createLinkGetAction(repo);
		const queryAction = createLinkQueryAction(repo);

		expect(getAction.id).toBe("link_get");
		expect(getAction.description).toBe(LINK_GET_DESCRIPTION);
		expect(getAction.domain).toBe("kg");
		expect(getAction.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});

		expect(queryAction.id).toBe("link_query");
		expect(queryAction.description).toBe(LINK_QUERY_DESCRIPTION);
		expect(queryAction.domain).toBe("kg");
		expect(queryAction.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
	});

	it("link_get formats 'No artifact-entity link found.' on miss and row bullet on hit", async () => {
		const repo: LinkRepository = {
			get: vi
				.fn()
				.mockResolvedValueOnce(null)
				.mockResolvedValueOnce(SAMPLE_LINK),
			query: vi.fn(),
		};
		const getAction = createLinkGetAction(repo);
		const ctx = makeCtx();

		const miss = await getAction.run({ id: SAMPLE_LINK.id }, ctx);
		expect(miss).toEqual({ link: null });
		expect(getAction.formatMcp!(miss)).toBe("No artifact-entity link found.");

		const hit = await getAction.run({ id: SAMPLE_LINK.id }, ctx);
		expect(hit).toEqual({ link: SAMPLE_LINK });
		expect(getAction.formatMcp!(hit)).toBe(formatArtifactEntityLinkRow(SAMPLE_LINK));
		expect(repo.get).toHaveBeenCalledWith(SAMPLE_LINK.id, ctx.userId);
	});

	it("link_query formats empty and populated results and forwards filter to LinkRepository.query", async () => {
		const fallbackRow: ArtifactEntityLinkRow = {
			...SAMPLE_LINK,
			id: "44444444-4444-4444-8444-444444444444",
			link_type: null,
			confidence_score: null,
		};
		const repo: LinkRepository = {
			get: vi.fn(),
			query: vi
				.fn()
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([SAMPLE_LINK, fallbackRow]),
		};
		const queryAction = createLinkQueryAction(repo);
		const ctx = makeCtx();

		const empty = await queryAction.run({}, ctx);
		expect(empty).toEqual({ rows: [] });
		expect(queryAction.formatMcp!(empty)).toBe("No artifact-entity links found.");

		const populated = await queryAction.run(
			{
				artifact_id: SAMPLE_LINK.artifact_id,
				entity_id: SAMPLE_LINK.entity_id,
				link_type: "mentions",
				limit: 10,
			},
			ctx,
		);
		expect(populated.rows).toHaveLength(2);
		expect(queryAction.formatMcp!(populated)).toBe(
			`Artifact-entity links (2):\n${formatArtifactEntityLinkRow(SAMPLE_LINK)}\n${formatArtifactEntityLinkRow(fallbackRow)}`,
		);
		expect(formatArtifactEntityLinkRow(fallbackRow)).toContain("type=related score=n/a");
		expect(repo.query).toHaveBeenLastCalledWith(
			{
				artifact_id: SAMPLE_LINK.artifact_id,
				entity_id: SAMPLE_LINK.entity_id,
				link_type: "mentions",
				limit: 10,
			},
			ctx.userId,
		);
	});
});
