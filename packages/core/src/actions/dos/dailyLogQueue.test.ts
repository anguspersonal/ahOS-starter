import { describe, expect, it, vi } from "vitest";
import type { DailyLogQueueEntry, ExternalLinkRepository } from "../../ports/externalLinks.js";
import {
	createDosDailyLogQueueAction,
	formatDosDailyLogQueueMcp,
} from "./dailyLogQueue.js";

function makeRepo(entries: DailyLogQueueEntry[] = []): ExternalLinkRepository {
	return {
		recordExternalLink: vi.fn(),
		getArtifactContentSubtype: vi.fn(),
		getExternalLinks: vi.fn(),
		inspectDedupSlot: vi.fn(),
		claimDedupSlot: vi.fn(),
		finalizeExternalLink: vi.fn(),
		releaseClaimForFailedWrite: vi.fn(),
		interruptedClaimMessage: vi.fn(),
		scopeToDomain: vi.fn((q) => q),
		getSynthesizedArtifactIds: vi.fn(),
		computeStreak: vi.fn(),
		enumerateDays: vi.fn(),
		getSynthesisCoverage: vi.fn(),
		getStreak: vi.fn(),
		getDailyLogQueue: vi.fn(async () => entries),
	};
}

describe("dos_daily_log_queue action (#1606)", () => {
	it("delegates domain and include_consumed (defaulting to false) to ExternalLinkRepository.getDailyLogQueue", async () => {
		const entries: DailyLogQueueEntry[] = [
			{
				artifact_id: "t1",
				date: "2026-08-21",
				title: "log t1",
				domain: "work",
				provider: "notion_work",
				page_id: "page-21",
				page_url: "https://notion.so/page-21",
				markers: "attended",
				conflicting_providers: [],
				consumed_by_state: null,
			},
		];
		const repo = makeRepo(entries);
		const action = createDosDailyLogQueueAction(repo);

		const result = await action.run(
			{ domain: "work" },
			{ caller: "test", requestId: "req-1" },
		);

		expect(repo.getDailyLogQueue).toHaveBeenCalledWith("work", false);
		expect(result).toEqual({
			domain: "work",
			include_consumed: false,
			entries,
		});
	});

	it("renders each status variant and the machine-readable JSON block via formatMcp", () => {
		const entries: DailyLogQueueEntry[] = [
			{
				artifact_id: "t-confirmed",
				date: "2026-08-20",
				title: "Confirmed Log",
				domain: "work",
				provider: "notion_work",
				page_id: "page-20",
				page_url: "https://notion.so/page-20",
				markers: "attended",
				conflicting_providers: [],
				consumed_by_state: null,
			},
			{
				artifact_id: "t-draft",
				date: "2026-08-21",
				title: "Draft Log",
				domain: "work",
				provider: "notion_work",
				page_id: "page-21",
				page_url: "https://notion.so/page-21",
				markers: "unattended",
				conflicting_providers: [],
				consumed_by_state: null,
			},
			{
				artifact_id: "t-unmarked",
				date: "2026-08-22",
				title: "Unmarked Log",
				domain: "work",
				provider: "notion_work",
				page_id: "page-22",
				page_url: "https://notion.so/page-22",
				markers: "none",
				conflicting_providers: [],
				consumed_by_state: null,
			},
			{
				artifact_id: "t-noptr",
				date: "2026-08-23",
				title: null,
				domain: null,
				provider: null,
				page_id: null,
				page_url: null,
				markers: "none",
				conflicting_providers: [],
				consumed_by_state: null,
			},
			{
				artifact_id: "t-conflict",
				date: null,
				title: "Conflict Log",
				domain: null,
				provider: null,
				page_id: null,
				page_url: null,
				markers: "none",
				conflicting_providers: ["notion_work", "notion_personal"],
				consumed_by_state: null,
			},
			{
				artifact_id: "t-consumed",
				date: "2026-08-19",
				title: "Consumed Log",
				domain: "work",
				provider: "notion_work",
				page_id: "page-19",
				page_url: "https://notion.so/page-19",
				markers: "attended",
				conflicting_providers: [],
				consumed_by_state: "state-doc-1",
			},
		];

		const text = formatDosDailyLogQueueMcp({
			include_consumed: true,
			entries,
		});

		expect(text).toContain("daily-log queue, all domains (no domain given), oldest first: twins with no 'consumed_by_state' row (consumed twins included, marked):");
		expect(text).toContain("2026-08-20  work  confirmed  page page-20  \"Confirmed Log\"  twin t-confirmed");
		expect(text).toContain("2026-08-21  work  UNCONFIRMED (swept draft, #561)  page page-21  \"Draft Log\"  twin t-draft");
		expect(text).toContain("2026-08-22  work  NO SYNTHESIS MARKERS (its atoms were never marked; half-written)  page page-22  \"Unmarked Log\"  twin t-unmarked");
		expect(text).toContain("2026-08-23  (no domain)  NO PAGE POINTER (twin write was cut short; cannot be promoted)  (untitled)  twin t-noptr");
		expect(text).toContain("(no date)  (no domain)  POINTER CONFLICT (daily_log pointers under notion_work and notion_personal; unattributable)  \"Conflict Log\"  twin t-conflict");
		expect(text).toContain("2026-08-19  work  folded into state doc state-doc-1  page page-19  \"Consumed Log\"  twin t-consumed");
		expect(text).toContain("5 log(s) not yet folded into the State Doc; 1 unconfirmed swept drafts; 1 with no synthesis markers; 1 with no page pointer; 1 unattributable (pointer conflict).");
		expect(JSON.parse(text.split("```json\n")[1].split("\n```")[0])).toEqual(entries);
	});
});
