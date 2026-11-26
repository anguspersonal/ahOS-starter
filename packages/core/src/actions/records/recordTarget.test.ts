import { describe, expect, it } from "vitest";
import {
	POINTERS,
	RECORD_KINDS,
	RECORD_TARGET_KEYS,
	resolveRecordDataSourceId,
	unwiredRecordTargetError,
} from "./recordTarget.js";

describe("recordTarget", () => {
	it("maps every (kind, domain) pair to its asymmetric integration config key and never exposes private_meetings_source_data_source_id", () => {
		expect(RECORD_TARGET_KEYS).toBe(POINTERS);
		expect(POINTERS.meetings.work.key).toBe("meetings_source_data_source_id");
		expect(POINTERS.meetings.angus.key).toBe("meeting_notes_data_source_id");
		expect(POINTERS.contacts.work.key).toBe("contacts_data_source_id");
		expect(POINTERS.contacts.angus.key).toBe("people_data_source_id");
		expect(POINTERS.investor_crm.work.key).toBe("investor_crm_data_source_id");
		expect(POINTERS.investor_crm.angus.key).toBe("investor_crm_data_source_id");

		const allKeys = RECORD_KINDS.flatMap((k) => [POINTERS[k].work.key, POINTERS[k].angus.key]);
		expect(allKeys).not.toContain("private_meetings_source_data_source_id");
	});

	it("resolves configured data source ids and throws the exact two-step integration_set + Notion share error when unwired", () => {
		expect(
			resolveRecordDataSourceId("meetings", "work", {
				meetings_source_data_source_id: "ds-meetings-work",
			}),
		).toBe("ds-meetings-work");
		expect(
			resolveRecordDataSourceId("contacts", "angus", {
				people_data_source_id: "ds-people-personal",
			}),
		).toBe("ds-people-personal");

		for (const kind of RECORD_KINDS) {
			for (const [domain, provider] of [
				["work", "notion_work"],
				["angus", "notion_personal"],
			] as const) {
				const { key, what } = POINTERS[kind][domain];
				const err = unwiredRecordTargetError(kind, domain);
				expect(err.message).toContain(
					`No ${key} for domain '${domain}' — ${what} is unwired, so nothing was written.`,
				);
				expect(err.message).toContain(
					`1. integration_set({ provider: '${provider}', config: { ${key}: '<the data source id>' } })`,
				);
				expect(err.message).toContain("Connections → ahKMS");
				expect(() => resolveRecordDataSourceId(kind, domain, {})).toThrow(err.message);
			}
		}
	});
});
