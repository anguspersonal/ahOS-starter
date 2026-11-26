import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaimResult, DedupSlotState } from "../../ports/externalLinks.js";
import type { NotionPort } from "../../ports/notion.js";
import {
	createCommunicationCreateAction,
	type CommunicationCreatePorts,
	type CreateCommunicationCall,
} from "./communicationCreate.js";

afterEach(() => {
	vi.restoreAllMocks();
});

const WORK_TOKEN = "Bearer secret_test_token";
const ANGUS_TOKEN = "Bearer secret_personal_test_token";

const WORK_MEETINGS_DB = "hl-meetings-db";
const WORK_MEETINGS_DS = "hl-meetings-ds";
const WORK_INVESTOR_CRM_DB = "hl-investor-crm-db";
const WORK_INVESTOR_CRM_DS = "hl-investor-crm-ds";

const ANGUS_MEETING_NOTES_DB = "angus-meetings-db";
const ANGUS_MEETING_NOTES_DS = "angus-meetings-ds";
const ANGUS_DAILY_LOG_DB = "angus-daily-log-db";
const ANGUS_DAILY_LOG_DS = "angus-daily-log-ds";

const WORK_ROW = {
	tasks_database_id: "db1",
	meetings_source_database_id: WORK_MEETINGS_DB,
	meetings_source_data_source_id: WORK_MEETINGS_DS,
	investor_crm_database_id: WORK_INVESTOR_CRM_DB,
	investor_crm_data_source_id: WORK_INVESTOR_CRM_DS,
};

const ANGUS_ROW = {
	tasks_database_id: "db-personal",
	meeting_notes_database_id: ANGUS_MEETING_NOTES_DB,
	meeting_notes_data_source_id: ANGUS_MEETING_NOTES_DS,
	daily_log_database_id: ANGUS_DAILY_LOG_DB,
	daily_log_data_source_id: ANGUS_DAILY_LOG_DS,
};

const MEETINGS_SCHEMA = {
	Name: { type: "title" },
	"Event time": { type: "date" },
	Type: { type: "select", select: { options: [{ name: "Investor Sync" }] } },
	Attendees: { type: "people" },
	External: { type: "relation" },
	Source: { type: "url" },
	Notes: { type: "rich_text" },
};

// Neither date property matches ROLES.meetingDate's preferred names ("Event time",
// "Date", "When"), so `findRole`/`resolveRole` see two equally-plausible candidates —
// the shape round-1's High finding covers.
const AMBIGUOUS_DATE_SCHEMA = {
	Name: { type: "title" },
	"Follow-up date": { type: "date" },
	"Reminder date": { type: "date" },
};

const DAILY_LOG_SCHEMA = {
	Name: { type: "title" },
	Date: { type: "date" },
};

type Call = { method: string; url: string; body?: any; auth?: string };

type LinkRow = {
	id: string;
	artifact_id: string;
	provider: string;
	kind: string;
	dedup_key: string | null;
	external_id: string;
	external_url?: string | null;
};

const ctx = { caller: "test" as const, requestId: "r1" };
let activeAction: ReturnType<typeof createCommunicationCreateAction>;

async function createCommunicationHandler(args: CreateCommunicationCall) {
	const out = await activeAction.run(args, ctx);
	return { content: [{ type: "text" as const, text: activeAction.formatMcp!(out) }] };
}

function setupTest(opts: {
	initialLinks?: LinkRow[];
	failCreate?: boolean;
	failAppend?: boolean;
	queryResults?: Record<string, { id: string; properties?: Record<string, unknown>; url?: string }[]>;
	schemaOverrides?: Record<string, Record<string, unknown>>;
	/** Databases in the Notion-Version 2025-09-03 shape: no `properties`, a data source that has them (#2285). */
	dataSourceShape?: boolean;
} = {}) {
	const links = [...(opts.initialLinks ?? [])];
	const insertedLinks: any[] = [];
	const updatedLinks: any[] = [];
	const deletedLinkIds: string[] = [];
	const linkReads: any[] = [];
	const calls: Call[] = [];

	const tokenFor = (ws: string) => (ws === "work" ? WORK_TOKEN : ANGUS_TOKEN);

	const notion = {
		resolveRecordTarget: vi.fn(async (kind: "meetings" | "contacts" | "investor_crm", domain: "work" | "angus") => {
			const row = domain === "work" ? WORK_ROW : ANGUS_ROW;
			const dsId =
				kind === "investor_crm"
					? (row as any).investor_crm_data_source_id
					: domain === "work"
						? WORK_MEETINGS_DS
						: ANGUS_MEETING_NOTES_DS;
			calls.push({ method: "GET", url: `https://api.notion.com/v1/data_sources/${dsId}`, auth: tokenFor(domain) });
			return { dataSourceId: dsId, databaseId: dsId.replace("-ds", "-db"), workspace: domain };
		}),
		resolveDailyLogTarget: vi.fn(async (domain: "work" | "angus") => ({
			databaseId: ANGUS_DAILY_LOG_DB,
			dataSourceId: ANGUS_DAILY_LOG_DS,
			workspace: domain,
		})),
		retrieveDatabase: vi.fn(async ({ workspace, databaseId }: { workspace: string; databaseId: string }) => {
			calls.push({
				method: "GET",
				url: `https://api.notion.com/v1/databases/${databaseId}`,
				auth: tokenFor(workspace),
			});
			const properties =
				opts.schemaOverrides?.[databaseId] ??
				(databaseId === ANGUS_DAILY_LOG_DB ? DAILY_LOG_SCHEMA : MEETINGS_SCHEMA);
			return opts.dataSourceShape
				? { id: databaseId, data_sources: [{ id: `first-ds-of-${databaseId}` }] }
				: { id: databaseId, properties: properties as any };
		}),
		retrieveDataSource: vi.fn(async ({ dataSourceId }: { dataSourceId: string }) => {
			const databaseId = dataSourceId === ANGUS_DAILY_LOG_DS ? ANGUS_DAILY_LOG_DB : dataSourceId.replace("-ds", "-db");
			const properties =
				opts.schemaOverrides?.[databaseId] ??
				(databaseId === ANGUS_DAILY_LOG_DB ? DAILY_LOG_SCHEMA : MEETINGS_SCHEMA);
			return { id: dataSourceId, properties: properties as any };
		}),
		queryDataSource: vi.fn(async ({ workspace, dataSourceId, filter }: any) => {
			calls.push({
				method: "POST",
				url: `https://api.notion.com/v1/data_sources/${dataSourceId}/query`,
				body: { filter },
				auth: tokenFor(workspace),
			});
			return { results: (opts.queryResults?.[dataSourceId] ?? []) as any, has_more: false, next_cursor: null };
		}),
		createPage: vi.fn(async ({ workspace, databaseId, properties, children }: any) => {
			calls.push({
				method: "POST",
				url: "https://api.notion.com/v1/pages",
				body: { parent: { database_id: databaseId }, properties, children },
				auth: tokenFor(workspace),
			});
			if (opts.failCreate) throw new Error("Notion API explosion");
			return { id: "page-created-123", url: "https://notion.so/page-created-123" };
		}),
		appendBlockChildren: vi.fn(async ({ workspace, blockId, children }: any) => {
			calls.push({
				method: "PATCH",
				url: `https://api.notion.com/v1/blocks/${blockId}/children`,
				body: { children },
				auth: tokenFor(workspace),
			});
			if (opts.failAppend) throw new Error("failed block append");
			return [];
		}),
		listUsers: vi.fn(async () => []),
	} as unknown as NotionPort;

	const externalLinks: CommunicationCreatePorts["externalLinks"] = {
		inspectDedupSlot: vi.fn(async (artifactId, provider, kind, dedupKey): Promise<DedupSlotState> => {
			linkReads.push({ artifactId, provider, kind, dedupKey });
			const matching = links.filter(
				(l) =>
					l.artifact_id === artifactId &&
					l.provider === provider &&
					l.kind === kind &&
					(!dedupKey || l.dedup_key === dedupKey),
			);
			if (matching.length === 0) return "free";
			if (matching.some((l) => l.external_id !== "__pending__")) return "linked";
			return "pending";
		}),
		claimDedupSlot: vi.fn(async (artifactId, provider, kind, dedupKey): Promise<ClaimResult> => {
			const key = dedupKey ?? "__single_communication__";
			if (links.some((l) => l.artifact_id === artifactId && l.provider === provider && l.kind === kind && l.dedup_key === key)) {
				return { claimed: false, reason: "conflict" };
			}
			const id = `claim-${links.length + 1}`;
			const row: LinkRow = {
				id,
				artifact_id: artifactId,
				provider,
				kind,
				dedup_key: key,
				external_id: "__pending__",
			};
			insertedLinks.push(row);
			links.push(row);
			return { claimed: true, linkId: id };
		}),
		finalizeExternalLink: vi.fn(async (linkId, externalId, externalUrl) => {
			updatedLinks.push({ id: linkId, external_id: externalId, external_url: externalUrl });
			const match = links.find((l) => l.id === linkId);
			if (match) Object.assign(match, { external_id: externalId, external_url: externalUrl });
			return { ok: true };
		}),
		recordExternalLink: vi.fn(async (artifactId, link) => {
			const row: LinkRow = {
				id: `link-${links.length + 1}`,
				artifact_id: artifactId,
				provider: link.provider,
				kind: link.kind,
				dedup_key: link.dedup_key ?? null,
				external_id: link.external_id,
				external_url: link.external_url,
			};
			insertedLinks.push(row);
			links.push(row);
			return { ok: true };
		}),
		releaseClaimForFailedWrite: vi.fn(async (claimedLinkId, error) => {
			if (claimedLinkId) {
				deletedLinkIds.push(claimedLinkId);
				const idx = links.findIndex((l) => l.id === claimedLinkId);
				if (idx !== -1) links.splice(idx, 1);
			}
			return error;
		}),
		interruptedClaimMessage: ({ artifactId, provider }) =>
			`Unfinished claim for artifact '${artifactId}' in '${provider}'.`,
	};

	activeAction = createCommunicationCreateAction({ notion, externalLinks });
	return { links, insertedLinks, updatedLinks, deletedLinkIds, linkReads, calls, action: activeAction };
}

describe("createCommunication", () => {
	it("routes audience='investor' to Investor CRM in Work domain", async () => {
		const { calls } = setupTest();

		const res = await createCommunicationHandler({
			domain: "work",
			title: "Q3 Update Call",
			audience: "investor",
			body: "Spoke with VC partners.",
		});

		expect(res.content[0].text).toContain("Created communication 'Q3 Update Call' in 'work' (investor_crm)");
		// Verify GET /v1/databases/hl-investor-crm-db was called
		const dbCall = calls.find((c) => c.url.includes(`/databases/${WORK_INVESTOR_CRM_DB}`));
		expect(dbCall).toBeDefined();
		expect(dbCall?.auth).toBe(WORK_TOKEN);

		// Verify POST /v1/pages parent was WORK_INVESTOR_CRM_DB
		const pageCall = calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/pages"));
		expect(pageCall?.body.parent.database_id).toBe(WORK_INVESTOR_CRM_DB);
	});

	it("routes general audience to Meetings DB in Work domain", async () => {
		const { calls } = setupTest();

		const res = await createCommunicationHandler({
			domain: "work",
			title: "Team Weekly Sync",
			audience: "team",
			body: "Reviewed weekly goals.",
		});

		expect(res.content[0].text).toContain("Created communication 'Team Weekly Sync' in 'work' (meetings)");
		const pageCall = calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/pages"));
		expect(pageCall?.body.parent.database_id).toBe(WORK_MEETINGS_DB);
	});

	// #2285: the shape production actually gets back from the SDK.
	it("reads the schema from the data source when the database carries no properties", async () => {
		const { calls } = setupTest({ dataSourceShape: true });

		const res = await createCommunicationHandler({
			domain: "work",
			title: "Team Weekly Sync",
			audience: "team",
			body: "Reviewed weekly goals.",
		});

		expect(res.content[0].text).toContain("Created communication 'Team Weekly Sync' in 'work' (meetings)");
		expect(calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/pages"))).toBeDefined();
	});

	it("refuses an ambiguous date property rather than silently dropping the date (round 1 High)", async () => {
		setupTest({ schemaOverrides: { [WORK_MEETINGS_DB]: AMBIGUOUS_DATE_SCHEMA } });

		await expect(
			createCommunicationHandler({
				domain: "work",
				title: "Ambiguous Date Meeting",
				destination: "meetings",
				date: "2026-09-26T10:00:00Z",
			}),
		).rejects.toThrow(/ambiguous/);
	});

	it("honours an explicit date_property override when the schema is ambiguous (round 1 High)", async () => {
		const { calls } = setupTest({ schemaOverrides: { [WORK_MEETINGS_DB]: AMBIGUOUS_DATE_SCHEMA } });

		const res = await createCommunicationHandler({
			domain: "work",
			title: "Ambiguous Date Meeting",
			destination: "meetings",
			date: "2026-09-26T10:00:00Z",
			date_property: "Follow-up date",
		});

		expect(res.content[0].text).toContain("Created communication 'Ambiguous Date Meeting'");
		const pageCall = calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/pages"));
		expect(pageCall?.body.properties["Follow-up date"].date.start).toBe("2026-09-26T10:00:00Z");
	});

	it("wires attendees, external, type, source_url and custom properties into the meetings/investor_crm branch (round 1 Low)", async () => {
		const { calls } = setupTest();

		await createCommunicationHandler({
			domain: "work",
			title: "Board Sync",
			destination: "meetings",
			type: "Investor Sync",
			attendees: ["11111111-2222-3333-4444-555555555555"],
			external: ["existing-contact-id"],
			source_url: "https://meet.google.com/xyz",
			properties: { Notes: { rich_text: [{ text: { content: "extra context" } }] } },
			body: "Agenda.",
		});

		const pageCall = calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/pages"));
		expect(pageCall?.body.properties.Type).toEqual({ select: { name: "Investor Sync" } });
		expect(pageCall?.body.properties.Attendees.people).toEqual([
			{ object: "user", id: "11111111-2222-3333-4444-555555555555" },
		]);
		expect(pageCall?.body.properties.External.relation).toEqual([{ id: "existing-contact-id" }]);
		expect(pageCall?.body.properties.Source).toEqual({ url: "https://meet.google.com/xyz" });
		expect(pageCall?.body.properties.Notes).toEqual({ rich_text: [{ text: { content: "extra context" } }] });
		// external attendee ids are used directly, so resolving them never touches the
		// Contacts database — this is the "already an id" path, not contact creation.
		expect(calls.some((c) => c.url.includes("/data_sources/") && c.url.includes("contact"))).toBe(false);
	});

	it("honours explicit destination override", async () => {
		const { calls } = setupTest();

		const res = await createCommunicationHandler({
			domain: "work",
			title: "Ad-hoc sync",
			audience: "investor", // audience says investor, but destination explicitly says meetings
			destination: "meetings",
			body: "Syncing up.",
		});

		expect(res.content[0].text).toContain("Created communication 'Ad-hoc sync' in 'work' (meetings)");
		const pageCall = calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/pages"));
		expect(pageCall?.body.parent.database_id).toBe(WORK_MEETINGS_DB);
	});

	describe("private meeting guard (#741 / ADR-053 §6 amendment)", () => {
		it("refuses source: 'private_meeting' when domain is not 'angus' before any read", async () => {
			const { calls, linkReads } = setupTest();

			await expect(
				createCommunicationHandler({
					domain: "work",
					title: "Private Catch-up",
					source: "private_meeting",
					body: "Sensitive discussion.",
					artifact_id: "11111111-2222-3333-4444-555555555555",
					single_communication: true,
				}),
			).rejects.toThrow(
				"Communications from a private meeting may only be written to the Daily Log body in the 'angus' domain (ADR-053 §6 amendment). Never the State Doc, never the Team, Investor or Advisor projections, never the Work Meetings DB.",
			);
			expect(calls).toHaveLength(0);
			expect(linkReads).toHaveLength(0);
		});

		it("refuses source: 'private_meeting' in 'angus' domain when destination is explicitly not 'daily_log'", async () => {
			const { calls, linkReads } = setupTest();

			await expect(
				createCommunicationHandler({
					domain: "angus",
					title: "Private Catch-up",
					source: "private_meeting",
					destination: "meetings",
					body: "Sensitive discussion.",
				}),
			).rejects.toThrow(
				"Communications from a private meeting may only be written to the Daily Log body in the 'angus' domain (ADR-053 §6 amendment). Never the State Doc, never the Team, Investor or Advisor projections, never the Work Meetings DB.",
			);
			expect(calls).toHaveLength(0);
			expect(linkReads).toHaveLength(0);
		});

		it("automatically defaults source: 'private_meeting' in 'angus' domain to 'daily_log' and succeeds", async () => {
			const { calls } = setupTest({
				queryResults: {
					[ANGUS_DAILY_LOG_DS]: [{ id: "daily-log-page-1", url: "https://notion.so/daily-log-page-1" }],
				},
			});

			const res = await createCommunicationHandler({
				domain: "angus",
				title: "Confidential Discussion",
				source: "private_meeting",
				body: "Notes from the 1:1.",
				date: "2026-09-26",
			});

			expect(res.content[0].text).toContain(
				"Appended communication 'Confidential Discussion' to Daily Log in 'angus': daily-log-page-1",
			);

			// Should have appended blocks to existing daily log page
			const appendCall = calls.find(
				(c) => c.method === "PATCH" && c.url.includes("/blocks/daily-log-page-1/children"),
			);
			expect(appendCall).toBeDefined();
			expect(appendCall?.body.children[0].heading_3.rich_text[0].text.content).toBe(
				"Communication: Confidential Discussion",
			);
		});
	});

	describe("Daily Log write path", () => {
		it("refuses to create a new Daily Log page if no entry exists for the date and releases any dedup claim (#1564, #1139)", async () => {
			const { calls, deletedLinkIds } = setupTest({
				queryResults: {
					[ANGUS_DAILY_LOG_DS]: [], // none found
				},
			});

			await expect(
				createCommunicationHandler({
					domain: "angus",
					title: "Evening Thoughts",
					destination: "daily_log",
					date: "2026-09-26",
					body: "A brief note.",
					artifact_id: "11111111-2222-3333-4444-555555555555",
					single_communication: true,
				}),
			).rejects.toThrow(
				"no Daily Log entry for 2026-09-26 in 'angus'; only the dos ritual creates Daily Log entries (#1139); run dos or pass a date that has an entry",
			);

			const pageCall = calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/pages"));
			expect(pageCall).toBeUndefined();
			expect(deletedLinkIds).toContain("claim-1");
		});

		it("notes an append failure on an existing Daily Log page instead of failing the whole write and releasing the dedup claim (round 1 Medium)", async () => {
			const { deletedLinkIds } = setupTest({
				queryResults: {
					[ANGUS_DAILY_LOG_DS]: [{ id: "daily-log-page-1", url: "https://notion.so/daily-log-page-1" }],
				},
				failAppend: true,
			});

			const res = await createCommunicationHandler({
				domain: "angus",
				title: "Confidential Discussion",
				destination: "daily_log",
				date: "2026-09-26",
				body: "Notes from the 1:1.",
				artifact_id: "44444444-5555-6666-7777-888888888888",
				single_communication: true,
			});

			// The page already existed, so this must read as (partial) success, not a
			// thrown error — and the dedup claim for it must be finalized, not released.
			expect(res.content[0].text).toContain(
				"Appended communication 'Confidential Discussion' to Daily Log in 'angus': daily-log-page-1",
			);
			expect(res.content[0].text).toMatch(/could not be written/);
			expect(deletedLinkIds).toHaveLength(0);
		});
	});

	describe("dedup and lineage (#422)", () => {
		it("skips creation if single_communication is true and link already exists", async () => {
			setupTest({
				initialLinks: [
					{
						id: "link-existing-1",
						artifact_id: "11111111-2222-3333-4444-555555555555",
						provider: "notion_work",
						kind: "communication",
						dedup_key: "__single_communication__",
						external_id: "existing-page-id",
					},
				],
			});

			const res = await createCommunicationHandler({
				domain: "work",
				title: "Investor Check-in",
				audience: "investor",
				artifact_id: "11111111-2222-3333-4444-555555555555",
				single_communication: true,
			});

			expect(res.content[0].text).toContain(
				"Skipped duplicate communication: artifact '11111111-2222-3333-4444-555555555555' already has a communication link in 'notion_work'.",
			);
		});

		it("claims and finalizes external link on successful creation", async () => {
			const { insertedLinks, updatedLinks } = setupTest();

			const res = await createCommunicationHandler({
				domain: "work",
				title: "Investor Update",
				audience: "investor",
				artifact_id: "22222222-3333-4444-5555-666666666666",
				single_communication: true,
			});

			expect(res.content[0].text).toContain("Created communication 'Investor Update' in 'work' (investor_crm)");
			expect(insertedLinks.length).toBe(1);
			expect(insertedLinks[0].kind).toBe("communication");
			expect(insertedLinks[0].dedup_key).toBe("__single_communication__");
			expect(updatedLinks.length).toBe(1);
			expect(updatedLinks[0].external_id).toBe("page-created-123");
		});

		it("releases dedup claim if Notion creation throws", async () => {
			const { deletedLinkIds } = setupTest({ failCreate: true });

			await expect(
				createCommunicationHandler({
					domain: "work",
					title: "Failing Comm",
					audience: "investor",
					artifact_id: "33333333-4444-5555-6666-777777777777",
					single_communication: true,
				}),
			).rejects.toThrow();

			expect(deletedLinkIds).toContain("claim-1");
		});
	});
});
