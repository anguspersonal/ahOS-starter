import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { executeAction } from "../adapters/direct.js";
import { entityDeriveInputSchema } from "../domain/derive.js";
import type { JobQueuePort, PendingJobRow } from "../../ports/jobQueue.js";
import {
	createEntityDeriveNextAction,
	deriveEntitiesSchema,
	ENTITY_DERIVE_NEXT_DESCRIPTION,
	MAX_PENDING_DERIVE_JOBS,
} from "./deriveNext.js";

const USER_ID = "00000000-0000-0000-0000-000000000001";
const ctx = { caller: "test" as const, requestId: "req-1", userId: USER_ID };

const EXPECTED_JSON_SCHEMA = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	type: "object",
	properties: {
		limit: {
			description: "Maximum candidate artifacts to process in this batch (1-20, default 5).",
			type: "integer",
			minimum: 1,
			maximum: 20,
		},
		artifact_id: {
			description: "Optional specific artifact id to derive entities from.",
			type: "string",
			format: "uuid",
			pattern:
				"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
		},
		artifact_ids: {
			description: "Optional explicit list of artifact ids to derive entities from.",
			maxItems: 20,
			type: "array",
			items: {
				type: "string",
				format: "uuid",
				pattern:
					"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
			},
		},
		force: {
			description: "Re-derive even if already derived. Defaults to false.",
			type: "boolean",
		},
		provider: {
			description: "Optional provider override ('gemini' or 'anthropic').",
			type: "string",
			enum: ["gemini", "anthropic"],
		},
		model: {
			description: "Optional model override.",
			type: "string",
		},
	},
	additionalProperties: false,
};

function makeFakeQueue(opts?: {
	pending?: PendingJobRow[];
	listError?: Error;
	enqueueId?: string;
	enqueueError?: Error;
}) {
	const listPending = vi.fn(async (_userId: string, _type: string, _limit: number) => {
		if (opts?.listError) throw opts.listError;
		return opts?.pending ?? [];
	});
	const enqueue = vi.fn(async (_userId: string, _type: string, _payload: unknown) => {
		if (opts?.enqueueError) throw opts.enqueueError;
		return { id: opts?.enqueueId ?? "job-12345" };
	});
	const port: JobQueuePort = { listPending, enqueue };
	return { port, listPending, enqueue };
}

describe("entity_derive_next action (#1506, ADR-101 §4)", () => {
	it("1. preserves dev contract: id, description, annotations, and JSON schema snapshot", () => {
		const { port } = makeFakeQueue();
		const action = createEntityDeriveNextAction(port);

		expect(action.id).toBe("entity_derive_next");
		expect(action.description).toBe(
			"Enqueue a background job (system_jobs) that extracts entities and relationships from enriched artifacts " +
				"and links them to the knowledge graph. This tool only enqueues and returns a job id; the engine process " +
				"runs the LLM derivation later. Identical pending jobs are deduplicated and at most 10 may be pending. " +
				"Supports batch draining (limit) and targeting up to 20 artifact ids.",
		);
		expect(action.description).toBe(ENTITY_DERIVE_NEXT_DESCRIPTION);
		expect(action.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		});
		expect(z.toJSONSchema(action.schema)).toEqual(EXPECTED_JSON_SCHEMA);

		const parsed = deriveEntitiesSchema.parse({});
		expect(parsed.limit).toBeUndefined();
		expect(parsed.force).toBeUndefined();
	});

	it("2. enqueues an entity_derive job with limit defaulted to 5 and force to false, and formats MCP output", async () => {
		const { port, listPending, enqueue } = makeFakeQueue({ enqueueId: "job-12345" });
		const action = createEntityDeriveNextAction(port);

		const out = await action.run({}, ctx);
		expect(listPending).toHaveBeenCalledWith(USER_ID, "entity_derive", MAX_PENDING_DERIVE_JOBS + 1);
		expect(enqueue).toHaveBeenCalledWith(USER_ID, "entity_derive", {
			artifact_id: undefined,
			artifact_ids: undefined,
			limit: 5,
			force: false,
			provider: undefined,
			model: undefined,
		});
		expect(action.formatMcp!(out)).toBe(
			"Enqueued entity derivation job [job-12345] for batch of candidates (limit 5). The background engine runner will process it; this tool does not run derivation itself.",
		);
	});

	it("enqueues for a specific artifact_id and formats MCP text", async () => {
		const { port, enqueue } = makeFakeQueue({ enqueueId: "job-12345" });
		const action = createEntityDeriveNextAction(port);

		const out = await action.run(
			{
				artifact_id: "11111111-1111-1111-1111-111111111111",
				force: true,
				provider: "gemini",
			},
			ctx,
		);

		expect(enqueue).toHaveBeenCalledWith(USER_ID, "entity_derive", {
			artifact_id: "11111111-1111-1111-1111-111111111111",
			artifact_ids: undefined,
			limit: 5,
			force: true,
			provider: "gemini",
			model: undefined,
		});
		expect(action.formatMcp!(out)).toContain(
			"Enqueued entity derivation job [job-12345] for artifact 11111111-1111-1111-1111-111111111111",
		);
		expect(action.formatMcp!(out)).toContain("does not run derivation itself");
	});

	it("3. does not enqueue a duplicate of an identical pending job (key order independent)", async () => {
		const { port, enqueue } = makeFakeQueue({
			pending: [{ id: "job-existing", payload: { force: false, limit: 10 } }],
		});
		const action = createEntityDeriveNextAction(port);

		const out = await action.run({ limit: 10 }, ctx);
		expect(enqueue).not.toHaveBeenCalled();
		expect(out.deduplicated).toBe(true);
		expect(out.job_id).toBe("job-existing");
		expect(action.formatMcp!(out)).toBe(
			"An identical entity derivation job [job-existing] is already queued; not enqueuing another.",
		);
	});

	it("4. refuses to enqueue when 10 pending jobs are already queued", async () => {
		const { port, enqueue } = makeFakeQueue({
			pending: Array.from({ length: MAX_PENDING_DERIVE_JOBS }, (_, i) => ({
				id: `j${i}`,
				payload: { limit: 1, force: false },
			})),
		});
		const action = createEntityDeriveNextAction(port);

		await expect(action.run({ limit: 10 }, ctx)).rejects.toThrow(
			`Too many pending entity derivation jobs (${MAX_PENDING_DERIVE_JOBS}); wait for the engine to drain the queue.`,
		);
		expect(enqueue).not.toHaveBeenCalled();
	});

	it("5. enqueued payload parses with entityDeriveInputSchema and artifact_ids of 21 is refused at action boundary", async () => {
		const { port, enqueue } = makeFakeQueue({ enqueueId: "job-77" });
		const action = createEntityDeriveNextAction(port);

		await executeAction(
			action,
			{
				artifact_ids: ["11111111-1111-4111-8111-111111111111"],
				limit: 8,
				force: true,
				provider: "anthropic",
				model: "claude-sonnet-4-5",
			},
			{ context: ctx },
		);
		const enqueuedPayload = enqueue.mock.calls[0][2];
		expect(entityDeriveInputSchema.safeParse(enqueuedPayload).success).toBe(true);

		const twentyOneIds = Array.from(
			{ length: 21 },
			() => "11111111-1111-4111-8111-111111111111",
		);
		expect(deriveEntitiesSchema.safeParse({ artifact_ids: twentyOneIds }).success).toBe(false);
		await expect(
			executeAction(action, { artifact_ids: twentyOneIds }, { context: ctx }),
		).rejects.toThrow();
	});

	it("6. rejects when ctx.userId is missing before calling any port method", async () => {
		const { port, listPending, enqueue } = makeFakeQueue();
		const action = createEntityDeriveNextAction(port);

		await expect(
			action.run({ limit: 5 }, { caller: "test", requestId: "r-no-user" }),
		).rejects.toThrow(/userId/);
		expect(listPending).not.toHaveBeenCalled();
		expect(enqueue).not.toHaveBeenCalled();
	});

	it("propagates enqueue failure with legacy error message prefix", async () => {
		const { port } = makeFakeQueue({
			enqueueError: new Error("Failed to enqueue entity_derive job: connection timeout"),
		});
		const action = createEntityDeriveNextAction(port);

		await expect(
			action.run({ artifact_id: "11111111-1111-1111-1111-111111111111" }, ctx),
		).rejects.toThrow("Failed to enqueue entity derivation job: connection timeout");
	});
});
