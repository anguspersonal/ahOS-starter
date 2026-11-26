import { describe, expect, it, vi } from "vitest";
import { jobHuntGmailIngestSchema } from "../../actions/domain/jobhunt.js";
import { defineAction } from "../../actions/defineAction.js";
import { parseJobHuntGmailMode, runJobHuntGmailSweep } from "./jobHuntCadence.js";

describe("parseJobHuntGmailMode", () => {
	it("defaults unset or unknown values to 'shadow' and accepts 'label' / 'act'", () => {
		expect(parseJobHuntGmailMode(undefined)).toBe("shadow");
		expect(parseJobHuntGmailMode("")).toBe("shadow");
		expect(parseJobHuntGmailMode("invalid")).toBe("shadow");
		expect(parseJobHuntGmailMode("LABEL")).toBe("label");
		expect(parseJobHuntGmailMode(" act ")).toBe("act");
	});
});

describe("runJobHuntGmailSweep", () => {
	it("invokes job_hunt_gmail_ingest with domain 'angus' and flattens counts", async () => {
		const spy = vi.fn(async (input) => ({
			domain: "angus" as const,
			mode: input.mode,
			dry_run: input.dry_run,
			scanned_messages: 5,
			skipped_watermarked: 1,
			skipped_seeded_provenance: 1,
			ignored_non_job: 1,
			classified_updates: 1,
			classified_tasks: 0,
			classified_evidence: 1,
			shadow_logged: 2,
			parked_approvals: 0,
			auto_applied: 0,
			tasks_created: 0,
			evidence_linked: 0,
			labels_added: 0,
			needs_review_count: 0,
			errors: [],
			items: [],
		}));

		const action = defineAction({
			id: "job_hunt_gmail_ingest",
			domain: "kg",
			description: "test",
			schema: jobHuntGmailIngestSchema,
			run: spy,
		});

		const res = await runJobHuntGmailSweep({
			userId: "user-1",
			registry: { get: (id) => (id === "job_hunt_gmail_ingest" ? action : undefined) },
			mode: "shadow",
			maxMessages: 25,
		});

		expect(res.error).toBeUndefined();
		expect(spy).toHaveBeenCalledWith(
			expect.objectContaining({
				domain: "angus",
				mode: "shadow",
				max_messages: 25,
				dry_run: false,
			}),
			expect.objectContaining({ caller: "worker", userId: "user-1" }),
		);
		expect(res.counts).toMatchObject({
			mode: "shadow",
			scanned_messages: 5,
			shadow_logged: 2,
			errors: 0,
		});
	});

	it("returns error object without throwing when action is missing", async () => {
		const res = await runJobHuntGmailSweep({
			userId: "user-1",
			registry: { get: () => undefined },
		});
		expect(res.output).toBeNull();
		expect(res.error).toContain("job_hunt_gmail_ingest");
	});
});
