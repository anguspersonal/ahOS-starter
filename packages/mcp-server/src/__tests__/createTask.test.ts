import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ARTIFACT_SURFACES } from "@ahkms/shared";
import { supabase } from "../supabase.js";
import {
	createTaskAction,
	createTaskHandler,
	createTaskInput,
	tomorrowDateOnly,
} from "../tools/createTask.js";
import { executeAction } from "../actions/index.js";

const origFrom = supabase.from;
const origStorageFrom = supabase.storage.from;
afterEach(() => {
	(supabase as any).from = origFrom;
	(supabase.storage as any).from = origStorageFrom;
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

/** A write result core's adapters can both await and chain `.select().single()` on (#1662). */
function written(error: unknown = null) {
	const result: any = Promise.resolve({ data: null, error });
	result.select = () => result;
	result.single = () => result;
	return result;
}

/**
 * Stub the storage upload/remove that the #413 provenance auto-capture performs (both
 * succeed). Returns the recorded upload/remove calls so a test can assert on them.
 */
function stubStorageWrites() {
	const uploads: Array<{ path: string; body: unknown }> = [];
	const removes: string[][] = [];
	(supabase.storage as any).from = vi.fn(() => ({
		upload: vi.fn(async (path: string, body: unknown) => {
			uploads.push({ path, body });
			return { error: null };
		}),
		remove: vi.fn(async (paths: string[]) => {
			removes.push(paths);
			return { error: null };
		}),
	}));
	return { uploads, removes };
}

/**
 * Stub the `user_integrations` lookup that `loadIntegrationConfig` performs:
 * `.from('user_integrations').select(...).eq('user_id', …).eq('provider', provider).maybeSingle()`.
 * Records which `provider` value(s) were queried so tests can assert the reader looks up
 * the actual row name rather than a stale/legacy one.
 *
 * Also stubs storage + the `artifacts` insert + the `artifact_external_links` upsert as
 * no-op successes so tests that call task_create WITHOUT an artifact_id (which now
 * auto-captures a task_request provenance artifact and links to it, issue #413) don't hit
 * unstubbed writes. Tests that need to inspect the auto-captured row use
 * `stubProvenancePath` instead.
 */
function stubUserIntegrations(
	rows: Record<string, Record<string, unknown>>,
	options?: {
		entities?: Record<string, any>;
		artifactEntityLinksUpserts?: any[];
	},
) {
	const queried: string[] = [];

	(supabase as any).from = vi.fn((table: string) => {
		if (table === "user_integrations") {
			let currentProvider: string | undefined;
			const b: any = {
				select: () => b,
				eq: (col: string, value: string) => {
					if (col === "provider") {
						currentProvider = value;
						queried.push(value);
					}
					return b;
				},
				maybeSingle: () => {
					const config = currentProvider ? rows[currentProvider] : undefined;
					return Promise.resolve(
						config
							? { data: { config, enabled: true }, error: null }
							: { data: null, error: null },
					);
				},
			};
			return b;
		}
		if (table === "artifacts") {
			return { insert: () => written() };
		}
		if (table === "artifact_external_links") {
			const b: any = {
				select: () => b,
				eq: () => b,
				upsert: () => Promise.resolve({ error: null }),
			};
			return b;
		}
		if (table === "entities") {
			let entityId: string | undefined;
			const b: any = {
				select: () => b,
				eq: (col: string, val: string) => {
					if (col === "id") entityId = val;
					return b;
				},
				maybeSingle: () => {
					const ent = entityId && options?.entities ? options.entities[entityId] : null;
					return Promise.resolve({ data: ent, error: null });
				},
			};
			return b;
		}
		if (table === "artifact_entity_links") {
			return {
				upsert: (payload: any) => {
					if (options?.artifactEntityLinksUpserts) {
						options.artifactEntityLinksUpserts.push(...[payload].flat());
					}
					return written();
				},
			};
		}
		throw new Error(`Unexpected table in test stub: ${table}`);
	});
	stubStorageWrites();
	return queried;
}

function stubNotionCreatePage() {
	return vi.fn(
		async (_url: string, _init: RequestInit) =>
			({
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({ id: "page_1", url: "https://notion.so/page_1" }),
				text: async () => "",
			}) as Response,
	);
}

/** One `artifact_external_links` row, as the in-memory stub below stores it. */
type LinkRow = {
	id: string;
	artifact_id: string;
	provider: string;
	kind: string;
	dedup_key: string | null;
	external_id: string;
	external_url?: string | null;
};

/**
 * Stub BOTH `user_integrations` (loadIntegrationConfig) and
 * `artifact_external_links` (inspectDedupSlot's dedup check + recordExternalLink's
 * lineage upsert + claimDedupSlot's insert + finalizeExternalLink's update +
 * the #653 claim release's delete) behind one `supabase.from` mock, so dedup tests don't
 * need Notion network wiring beyond the standard `stubNotionCreatePage`.
 *
 * - `existingLinkCount` seeds that many FINALIZED rows (real page ids) for
 *   `inspectDedupSlot` to read — a genuine duplicate.
 * - `pendingLinkCount` seeds rows still at `external_id='__pending__'` — an unfinished
 *   claim from a create that never completed (issue #653). Kept separate from
 *   `existingLinkCount` because telling those two apart IS the fix: one is a duplicate,
 *   the other is not.
 * - `claimError` simulates `claimDedupSlot`'s INSERT failing — pass
 *   `{ code: "23505" }` to simulate a real concurrent-race unique-violation (the
 *   loser's claim), or any other `code` to simulate an infra failure (e.g. migration
 *   064 not applied) that should degrade to the best-effort `recordExternalLink` path.
 * - `finalizeError` simulates `finalizeExternalLink`'s UPDATE failing AFTER the Notion
 *   page exists — the case where the claim must be left alone, not released.
 * - `releaseError` simulates the release DELETE itself failing, so the stuck claim gets
 *   reported alongside the failure that caused it instead of vanishing.
 */
function stubIntegrationsAndLinks(opts: {
	notionWork?: Record<string, unknown>;
	notionPersonal?: Record<string, unknown>;
	existingLinkCount?: number;
	pendingLinkCount?: number;
	claimError?: { code: string; message?: string };
	finalizeError?: { message: string };
	releaseError?: { message: string };
}) {
	const upsertCalls: Array<Record<string, unknown>> = [];
	const insertCalls: Array<Record<string, unknown>> = [];
	const updateCalls: Array<{ id: string; row: Record<string, unknown> }> = [];
	const deleteCalls: Array<Array<[string, unknown]>> = [];
	const linkEqCalls: Array<[string, unknown]> = [];
	// Provenance auto-capture rows (#413), recorded for tests that create a task without an
	// artifact_id via this helper (the no-artifact_id path now auto-captures a source).
	const artifactInserts: Array<Record<string, unknown>> = [];
	let claimedRowId = 0;

	// Rows this run actually wrote — claims, finalizes, releases. Real state, so a test
	// can drive claim -> fail -> release -> retry and see the retry find a free slot.
	const rows: LinkRow[] = [];
	// `.eq(...)` filters accumulated on the current read, drained when it is awaited.
	const readFilters: Array<[string, unknown]> = [];
	// Pre-existing rows, seeded as unconditional read hits: they stand for links written
	// by some EARLIER call whose artifact/provider/key the test doesn't restate.
	const seededRows = [
		...Array.from({ length: opts.existingLinkCount ?? 0 }, (_, i) => ({
			external_id: `page_existing_${i}`,
		})),
		...Array.from({ length: opts.pendingLinkCount ?? 0 }, () => ({
			external_id: "__pending__",
		})),
	];

	const configByProvider: Record<string, Record<string, unknown> | undefined> = {
		notion_work: opts.notionWork,
		notion_personal: opts.notionPersonal,
	};

	stubStorageWrites();

	(supabase as any).from = vi.fn((table: string) => {
		if (table === "user_integrations") {
			let currentProvider: string | undefined;
			const b: any = {
				select: () => b,
				eq: (col: string, value: string) => {
					if (col === "provider") currentProvider = value;
					return b;
				},
				maybeSingle: () => {
					const config = currentProvider
						? configByProvider[currentProvider]
						: undefined;
					return Promise.resolve(
						config
							? { data: { config, enabled: true }, error: null }
							: { data: null, error: null },
					);
				},
			};
			return b;
		}
		if (table === "artifact_external_links") {
			// A filter-collecting builder over the in-memory `rows` above. Reads, deletes
			// and the claim's unique check all resolve against the SAME array, so a test
			// that releases a claim and retries observes the release — rather than being
			// handed a scripted answer that would pass with or without the fix.
			const matching = (filters: Array<[string, unknown]>) =>
				rows.filter((row) =>
					filters.every(
						([col, value]) =>
							col === "user_id" || (row as Record<string, unknown>)[col] === value,
					),
				);

			const b: any = {
				select: (..._args: unknown[]) => b,
				eq: (col: string, value: unknown) => {
					linkEqCalls.push([col, value]);
					readFilters.push([col, value]);
					return b;
				},
				upsert: (row: Record<string, unknown>) => {
					upsertCalls.push(row);
					rows.push(row as LinkRow);
					return Promise.resolve({ error: null });
				},
				insert: (row: Record<string, unknown>) => {
					insertCalls.push(row);
					return {
						select: () => ({
							single: () => {
								if (opts.claimError) {
									return Promise.resolve({
										data: null,
										error: {
											code: opts.claimError.code,
											message: opts.claimError.message ?? "insert failed",
										},
									});
								}
								// Migration 064's partial unique index, in miniature: a second
								// claim on an occupied (artifact, provider, kind, dedup_key)
								// gets a real 23505 rather than a second row.
								const key = row.dedup_key;
								if (
									key != null &&
									rows.some(
										(r) =>
											r.artifact_id === row.artifact_id &&
											r.provider === row.provider &&
											r.kind === row.kind &&
											r.dedup_key === key,
									)
								) {
									return Promise.resolve({
										data: null,
										error: {
											code: "23505",
											message: "duplicate key value violates unique constraint",
										},
									});
								}
								claimedRowId += 1;
								const id = `claim-${claimedRowId}`;
								rows.push({ ...(row as object), id } as LinkRow);
								return Promise.resolve({ data: { id }, error: null });
							},
						}),
					};
				},
				update: (row: Record<string, unknown>) => ({
					eq: (_col: string, id: unknown) => {
						updateCalls.push({ id: id as string, row });
						if (opts.finalizeError) return Promise.resolve({ error: opts.finalizeError });
						const target = rows.find((r) => r.id === id);
						if (target) Object.assign(target, row);
						return Promise.resolve({ error: null });
					},
				}),
				// The #653 release: DELETE scoped by BOTH the claimed row id and
				// external_id='__pending__'. Every .eq is recorded so a test can assert the
				// release never widens past the row this attempt claimed.
				delete: () => {
					const eqs: Array<[string, unknown]> = [];
					deleteCalls.push(eqs);
					const d: any = {
						eq: (col: string, value: unknown) => {
							eqs.push([col, value]);
							return d;
						},
						then: (res: any) => {
							if (opts.releaseError) {
								return Promise.resolve({ error: opts.releaseError }).then(res);
							}
							for (const row of matching(eqs)) {
								rows.splice(rows.indexOf(row), 1);
							}
							return Promise.resolve({ error: null }).then(res);
						},
					};
					return d;
				},
				then: (res: any) => {
					const filters = readFilters.splice(0);
					return Promise.resolve({
						data: [
							...seededRows,
							...matching(filters).map((r) => ({ external_id: r.external_id })),
						],
						error: null,
					}).then(res);
				},
			};
			return b;
		}
		if (table === "artifacts") {
			return {
				insert: (row: Record<string, unknown>) => {
					artifactInserts.push(row);
					return written();
				},
			};
		}
		throw new Error(`Unexpected table in test stub: ${table}`);
	});

	return {
		upsertCalls,
		insertCalls,
		updateCalls,
		deleteCalls,
		linkEqCalls,
		artifactInserts,
	};
}

describe("createTaskHandler", () => {
	it("recognises a 'notion_work' row (the current Work workspace provider name) and creates the task", async () => {
		// Exact shape from the #144 repro: a notion_work row with tasks_database_id
		// plus several dos-hl-only keys the schema doesn't declare.
		const queried = stubUserIntegrations({
			notion_work: {
				tasks_database_id: "db_work",
				title_property: "Name",
				property_map: {},
				notion_user_id: "user_1",
				state_doc_page_id: "sdp_1",
				daily_log_data_source_id: "dl_1",
				investor_crm_data_source_id: "crm_1",
				tasks_source_data_source_id: "to_1",
				meetings_source_data_source_id: "mo_1",
			},
		});
		vi.stubGlobal("fetch", stubNotionCreatePage());

		const out = await createTaskHandler({ workspace: "notion_work", title: "Ship it" });

		expect(queried).toContain("notion_work");
		expect(out.content[0].text).toContain("Created Notion task: Ship it");
		expect(out.content[0].text).toContain("https://notion.so/page_1");
	});

	it("does NOT fall back to a legacy 'notion' row when only 'notion_personal' is configured", async () => {
		// The #144 repro also had a notion_personal row present. task_create's
		// Work-only lookup must not accidentally match it (or any legacy 'notion' row).
		stubUserIntegrations({
			notion_personal: {
				tasks_database_id: "db_personal",
				title_property: "Name",
				property_map: {},
			},
		});

		await expect(createTaskHandler({ workspace: "notion_work", title: "Ship it" })).rejects.toThrow(
			/notion_work/,
		);
	});

	it("throws a clear, current error (naming 'notion_work', not the legacy 'notion') when unconfigured", async () => {
		stubUserIntegrations({});

		await expect(createTaskHandler({ workspace: "notion_work", title: "Ship it" })).rejects.toThrow(
			/No Notion Work integration configured.*'notion_work' row/s,
		);
		// Guard against the legacy row name reappearing in the message ahead of the rename.
		await expect(createTaskHandler({ workspace: "notion_work", title: "Ship it" })).rejects.not.toThrow(
			/'notion' row/,
		);
	});

	// #817: `due` was the one abstract key read straight off property_map instead of
	// through resolvePropertyName, so an empty property_map — which is what BOTH
	// workspaces actually have — discarded every date and said so only in prose. Every
	// task ahKMS ever created landed undated.
	describe("due date with an unmapped property_map (#817)", () => {
		/** Dispatches GET /databases/* (schema) vs POST /pages, recording both. */
		function stubNotionWithSchema(schemaProperties: Record<string, unknown>) {
			const calls: Array<{ url: string; init: RequestInit }> = [];
			const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
				calls.push({ url, init });
				if (url.includes("/databases/") && init.method === "GET") {
					return {
						ok: true,
						status: 200,
						statusText: "OK",
						json: async () => ({ properties: schemaProperties }),
						text: async () => "",
					} as Response;
				}
				return {
					ok: true,
					status: 200,
					statusText: "OK",
					json: async () => ({ id: "page_1", url: "https://notion.so/page_1" }),
					text: async () => "",
				} as Response;
			});
			return { fetchMock, calls };
		}

		const UNMAPPED = {
			notion_work: {
				tasks_database_id: "db_work",
				title_property: "Name",
				property_map: {},
			},
		};

		it("applies an explicit due via the DEFAULT_PROPERTY_NAMES fallback name", async () => {
			stubUserIntegrations(UNMAPPED);
			const { fetchMock, calls } = stubNotionWithSchema({
				Name: { type: "title", title: {} },
				"Due date": { type: "date", date: {} },
			});
			vi.stubGlobal("fetch", fetchMock);

			const out = await createTaskHandler({
				workspace: "notion_work",
				title: "Ship it",
				due: "2026-07-10",
			});

			const create = calls.find((c) => c.init.method === "POST");
			const body = JSON.parse(create!.init.body as string);
			expect(body.properties["Due date"]).toEqual({ date: { start: "2026-07-10" } });
			expect(out.content[0].text).not.toContain("skipped");
		});

		it("RAISES when the guessed property is absent, naming it and the workspace, and creates nothing", async () => {
			stubUserIntegrations(UNMAPPED);
			const { fetchMock, calls } = stubNotionWithSchema({
				Name: { type: "title", title: {} },
				Deadline: { type: "date", date: {} },
			});
			vi.stubGlobal("fetch", fetchMock);

			await expect(
				createTaskHandler({ workspace: "notion_work", title: "Ship it", due: "2026-07-10" }),
			).rejects.toThrow(/'Due date'[\s\S]*notion_work/);
			// The failure must name what IS there, so the fix is one step.
			await expect(
				createTaskHandler({ workspace: "notion_work", title: "Ship it", due: "2026-07-10" }),
			).rejects.toThrow(/Deadline/);
			// And nothing may be written: a task without the date it was asked for is the
			// exact outcome #817 exists to stop.
			expect(calls.some((c) => c.init.method === "POST")).toBe(false);
		});

		it("RAISES when the property exists but is not a date", async () => {
			stubUserIntegrations(UNMAPPED);
			const { fetchMock, calls } = stubNotionWithSchema({
				Name: { type: "title", title: {} },
				"Due date": { type: "rich_text", rich_text: {} },
			});
			vi.stubGlobal("fetch", fetchMock);

			await expect(
				createTaskHandler({ workspace: "notion_work", title: "Ship it", due: "2026-07-10" }),
			).rejects.toThrow(/is a rich_text, not a date/);
			expect(calls.some((c) => c.init.method === "POST")).toBe(false);
		});

		it("no due supplied: no date stamped, and the one-call fast path is untouched", async () => {
			stubUserIntegrations(UNMAPPED);
			const { fetchMock, calls } = stubNotionWithSchema({
				Name: { type: "title", title: {} },
				"Due date": { type: "date", date: {} },
			});
			vi.stubGlobal("fetch", fetchMock);

			await createTaskHandler({ workspace: "notion_work", title: "Ship it" });

			// The #298 tomorrow-default stays keyed on an EXPLICIT property_map.due entry,
			// so fixing the name lookup must not start dating every task on both
			// workspaces as a side effect (#817, explicitly out of scope).
			expect(calls).toHaveLength(1);
			const body = JSON.parse(calls[0].init.body as string);
			expect(body.properties["Due date"]).toBeUndefined();
		});
	});
});

// Issue #145 gap 1: task_create must be able to target either Notion workspace's tasks
// database, not just the hardcoded Work one.
describe("createTaskHandler — workspace targeting", () => {
	it("REFUSES an omitted workspace, naming both values, and creates nothing (#820)", async () => {
		const queried = stubUserIntegrations({
			notion_work: {
				tasks_database_id: "db_work",
				title_property: "Name",
				property_map: {},
			},
		});
		const refuseFetch = stubNotionCreatePage();
		vi.stubGlobal("fetch", refuseFetch);

		// The old default was right about half the time, which is the worst kind of wrong:
		// on 2026-08-08 it put a personal task on the Work board and reported success.
		// Nothing may be created, and the error must name both values so the retry is one
		// step rather than a guess.
		await expect(createTaskHandler({ title: "Ship it" })).rejects.toThrow(
			/'work'.*'angus'|'angus'.*'work'/,
		);
		expect(refuseFetch).not.toHaveBeenCalled();
		expect(queried).not.toContain("notion_work");
	});

	it("routes to 'notion_work' when it is selected explicitly", async () => {
		const queried = stubUserIntegrations({
			notion_work: {
				tasks_database_id: "db_work",
				title_property: "Name",
				property_map: {},
			},
		});
		const fetchMock = stubNotionCreatePage();
		vi.stubGlobal("fetch", fetchMock);

		const out = await createTaskHandler({ workspace: "notion_work", title: "Ship it" });

		expect(queried).toContain("notion_work");
		expect(queried).not.toContain("notion_personal");
		const [, init] = fetchMock.mock.calls[0];
		expect(JSON.parse((init as RequestInit).body as string).parent).toEqual({
			database_id: "db_work",
		});
		// Regression guard (QA round 1, #424): the work path must keep authenticating
		// with the work token, not fall through to the personal one.
		expect((init as RequestInit).headers as Record<string, string>).toMatchObject({
			Authorization: "Bearer secret_test_token",
		});
		expect(out.content[0].text).toContain("Created Notion task: Ship it");
	});

	it("loads the personal config and targets its tasks DB when workspace='notion_personal'", async () => {
		const queried = stubUserIntegrations({
			notion_personal: {
				tasks_database_id: "db_personal",
				title_property: "Name",
				property_map: {},
			},
		});
		const fetchMock = stubNotionCreatePage();
		vi.stubGlobal("fetch", fetchMock);

		const out = await createTaskHandler({
			title: "Buy groceries",
			workspace: "notion_personal",
		});

		expect(queried).toContain("notion_personal");
		expect(queried).not.toContain("notion_work");
		const [, init] = fetchMock.mock.calls[0];
		expect(JSON.parse((init as RequestInit).body as string).parent).toEqual({
			database_id: "db_personal",
		});
		// Regression guard (QA round 1, #424): must authenticate with the personal
		// token (notionTokenFor('notion_personal')), not silently fall back to the
		// work token — this is the exact regression defect 1 fixed.
		expect((init as RequestInit).headers as Record<string, string>).toMatchObject({
			Authorization: "Bearer secret_personal_test_token",
		});
		expect(out.content[0].text).toContain("Created Notion task: Buy groceries");
	});

	it("throws an error naming 'notion_personal' when that workspace is unconfigured", async () => {
		stubUserIntegrations({});

		await expect(
			createTaskHandler({ title: "Buy groceries", workspace: "notion_personal" }),
		).rejects.toThrow(/No Notion personal integration configured.*'notion_personal' row/s);
	});
});

// Issue #141: EOD's Act step (and any second Act pass, e.g. eager Act at capture
// followed by an EOD Act pass over the same atom) must not double-create a task when
// one has already been linked to the artifact.
describe("createTaskHandler — dedup against existing task links", () => {
	const NOTION_WORK_CONFIG = {
		tasks_database_id: "db_work",
		title_property: "Name",
		property_map: {},
	};

	it("single_task + no existing link: claims the dedup slot BEFORE calling Notion, then finalizes it with the real page id", async () => {
		const { insertCalls, updateCalls } = stubIntegrationsAndLinks({
			notionWork: NOTION_WORK_CONFIG,
			existingLinkCount: 0,
		});
		vi.stubGlobal("fetch", stubNotionCreatePage());

		const out = await createTaskHandler({
			workspace: "notion_work",
			title: "Complete marriage-licence form",
			artifact_id: "11111111-1111-1111-1111-111111111111",
			single_task: true,
		});

		expect(out.content[0].text).toContain("Created Notion task");
		// The claim (a raw INSERT against migration 064's partial unique index, not an
		// upsert) happens once, using the single_task sentinel key since single_task has
		// no natural per-item key of its own.
		expect(insertCalls).toHaveLength(1);
		expect(insertCalls[0]).toMatchObject({
			artifact_id: "11111111-1111-1111-1111-111111111111",
			provider: "notion_work",
			kind: "task",
			dedup_key: "__single_task__",
			external_id: "__pending__",
		});
		// Then the claimed row is finalized with the real Notion page id/url — never a
		// second upsert.
		expect(updateCalls).toHaveLength(1);
		expect(updateCalls[0].row).toMatchObject({
			external_id: "page_1",
			external_url: "https://notion.so/page_1",
		});
	});

	it("single_task + an existing kind='task' link: skips creation, reports skipped, does not call Notion", async () => {
		stubIntegrationsAndLinks({
			notionWork: NOTION_WORK_CONFIG,
			existingLinkCount: 1,
		});
		const fetchMock = stubNotionCreatePage();
		vi.stubGlobal("fetch", fetchMock);

		const out = await createTaskHandler({
			workspace: "notion_work",
			title: "Complete marriage-licence form",
			artifact_id: "11111111-1111-1111-1111-111111111111",
			single_task: true,
		});

		expect(out.content[0].text).toMatch(/^Skipped:/);
		expect(out.content[0].text).toContain("already linked");
		// The loud single_task contract (round-1 review finding #2): a skip under
		// single_task must say this exact phrase so a caller who misclassified a
		// multi-task atom as single_task can notice it in the response text.
		expect(out.content[0].text).toContain("skipped as duplicate (single_task)");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("no single_task and no dedup_key: creates unconditionally (today's default behaviour, unchanged)", async () => {
		const { linkEqCalls } = stubIntegrationsAndLinks({
			notionWork: NOTION_WORK_CONFIG,
			existingLinkCount: 1, // even with an existing link, no guard means no check at all
		});
		vi.stubGlobal("fetch", stubNotionCreatePage());

		const out = await createTaskHandler({
			workspace: "notion_work",
			title: "Ship it",
			artifact_id: "11111111-1111-1111-1111-111111111111",
		});

		expect(out.content[0].text).toContain("Created Notion task");
		// The dedup lookup itself scopes by kind='task'; with no guard requested it should
		// never run at all, so no 'kind' eq call should have fired for the dedup check.
		expect(linkEqCalls.some(([col, val]) => col === "kind" && val === "task")).toBe(
			false,
		);
	});

	it("dedup_key + no existing link with that key: claims the slot under that key, then finalizes it", async () => {
		const { insertCalls, updateCalls } = stubIntegrationsAndLinks({
			notionWork: NOTION_WORK_CONFIG,
			existingLinkCount: 0,
		});
		vi.stubGlobal("fetch", stubNotionCreatePage());

		const out = await createTaskHandler({
			workspace: "notion_work",
			title: "Return form to Shelly",
			artifact_id: "22222222-2222-2222-2222-222222222222",
			dedup_key: "return-form-to-shelly",
		});

		expect(out.content[0].text).toContain("Created Notion task");
		expect(insertCalls[0]).toMatchObject({ dedup_key: "return-form-to-shelly" });
		expect(updateCalls).toHaveLength(1);
	});

	// Issue #145 gap 1 correctness: when a task targets notion_personal, the dedup claim
	// and the lineage row must both carry provider='notion_personal' — otherwise a
	// personal task collides with the work dedup namespace (migration 064's unique
	// index keys on provider) and its lineage is mislabeled.
	const NOTION_PERSONAL_CONFIG = {
		tasks_database_id: "db_personal",
		title_property: "Name",
		property_map: {},
	};

	it("workspace='notion_personal' + dedup_key: claims the slot under provider='notion_personal'", async () => {
		const { insertCalls, updateCalls } = stubIntegrationsAndLinks({
			notionPersonal: NOTION_PERSONAL_CONFIG,
			existingLinkCount: 0,
		});
		vi.stubGlobal("fetch", stubNotionCreatePage());

		const out = await createTaskHandler({
			title: "Buy groceries",
			workspace: "notion_personal",
			artifact_id: "33333333-3333-3333-3333-333333333333",
			dedup_key: "buy-groceries",
		});

		expect(out.content[0].text).toContain("Created Notion task");
		expect(insertCalls[0]).toMatchObject({
			provider: "notion_personal",
			dedup_key: "buy-groceries",
		});
		expect(updateCalls).toHaveLength(1);
	});

	it("workspace='notion_personal' (no dedup guard): records the lineage link under provider='notion_personal'", async () => {
		const { upsertCalls } = stubIntegrationsAndLinks({
			notionPersonal: NOTION_PERSONAL_CONFIG,
			existingLinkCount: 0,
		});
		vi.stubGlobal("fetch", stubNotionCreatePage());

		const out = await createTaskHandler({
			title: "Buy groceries",
			workspace: "notion_personal",
			artifact_id: "33333333-3333-3333-3333-333333333333",
		});

		expect(out.content[0].text).toContain("Created Notion task");
		// No dedup guard → the best-effort recordExternalLink upsert path, which must tag
		// the lineage row with the chosen workspace, not the hardcoded work.
		expect(upsertCalls).toHaveLength(1);
		expect(upsertCalls[0]).toMatchObject({ provider: "notion_personal" });
	});

	it("workspace work, no dedup guard: lineage link records provider='notion_work'", async () => {
		const { upsertCalls } = stubIntegrationsAndLinks({
			notionWork: NOTION_WORK_CONFIG,
			existingLinkCount: 0,
		});
		vi.stubGlobal("fetch", stubNotionCreatePage());

		await createTaskHandler({
			workspace: "notion_work",
			title: "Ship it",
			artifact_id: "11111111-1111-1111-1111-111111111111",
		});

		expect(upsertCalls).toHaveLength(1);
		expect(upsertCalls[0]).toMatchObject({ provider: "notion_work" });
	});

	it("dedup_key + a link already exists with that exact key: skips creation, no single_task phrase", async () => {
		stubIntegrationsAndLinks({
			notionWork: NOTION_WORK_CONFIG,
			existingLinkCount: 1,
		});
		const fetchMock = stubNotionCreatePage();
		vi.stubGlobal("fetch", fetchMock);

		const out = await createTaskHandler({
			workspace: "notion_work",
			title: "Return form to Shelly",
			artifact_id: "22222222-2222-2222-2222-222222222222",
			dedup_key: "return-form-to-shelly",
		});

		expect(out.content[0].text).toMatch(/^Skipped:/);
		expect(out.content[0].text).toContain("dedup_key 'return-form-to-shelly'");
		// The single_task phrase is specific to the single_task guard; a plain dedup_key
		// skip (the well-behaved 1:N path) must not include it.
		expect(out.content[0].text).not.toContain("single_task");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	// Round-1 review finding #1: two concurrent createTask calls with the same dedup
	// key must not both create a Notion page. claimDedupSlot's raw INSERT against
	// migration 064's partial unique index is what actually closes this race — these
	// tests simulate the loser (whose INSERT lands after the winner already claimed
	// the slot) getting a real 23505 back, and assert Notion is never called on that
	// path, distinct from the plain pre-check "already linked" skip above.
	describe("concurrent dedup races (claimDedupSlot conflict handling)", () => {
		it("single_task: a 23505 on the claim (lost the race) is reported as a skipped duplicate, Notion never called", async () => {
			stubIntegrationsAndLinks({
				notionWork: NOTION_WORK_CONFIG,
				existingLinkCount: 0, // pre-check passes: the race is what catches this, not the pre-check
				claimError: { code: "23505", message: "duplicate key value violates unique constraint" },
			});
			const fetchMock = stubNotionCreatePage();
			vi.stubGlobal("fetch", fetchMock);

			const out = await createTaskHandler({
				workspace: "notion_work",
				title: "Complete marriage-licence form",
				artifact_id: "11111111-1111-1111-1111-111111111111",
				single_task: true,
			});

			expect(out.content[0].text).toMatch(/^Skipped:/);
			expect(out.content[0].text).toContain("lost a concurrent dedup race");
			expect(out.content[0].text).toContain("skipped as duplicate (single_task)");
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it("dedup_key: a 23505 on the claim (lost the race) is reported as a skipped duplicate, Notion never called", async () => {
			stubIntegrationsAndLinks({
				notionWork: NOTION_WORK_CONFIG,
				existingLinkCount: 0,
				claimError: { code: "23505", message: "duplicate key value violates unique constraint" },
			});
			const fetchMock = stubNotionCreatePage();
			vi.stubGlobal("fetch", fetchMock);

			const out = await createTaskHandler({
				workspace: "notion_work",
				title: "Return form to Shelly",
				artifact_id: "22222222-2222-2222-2222-222222222222",
				dedup_key: "return-form-to-shelly",
			});

			expect(out.content[0].text).toMatch(/^Skipped:/);
			expect(out.content[0].text).toContain("dedup_key 'return-form-to-shelly'");
			expect(out.content[0].text).toContain("lost a concurrent dedup race");
			expect(out.content[0].text).not.toContain("single_task");
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it("a non-conflict claim error (e.g. migration 064 not applied) degrades to the best-effort upsert path instead of blocking creation", async () => {
			const { upsertCalls, updateCalls } = stubIntegrationsAndLinks({
				notionWork: NOTION_WORK_CONFIG,
				existingLinkCount: 0,
				claimError: { code: "42P01", message: "relation does not exist" }, // undefined_table
			});
			vi.stubGlobal("fetch", stubNotionCreatePage());

			const out = await createTaskHandler({
				workspace: "notion_work",
				title: "Ship it",
				artifact_id: "11111111-1111-1111-1111-111111111111",
				single_task: true,
			});

			expect(out.content[0].text).toContain("Created Notion task");
			// Falls back to the pre-064 best-effort recordExternalLink (upsert), not the
			// claim-based finalize path, since there was never a successful claim to
			// finalize.
			expect(upsertCalls).toHaveLength(1);
			expect(updateCalls).toHaveLength(0);
		});
	});

	// Issue #653: the dedup slot is claimed BEFORE the Notion page is created, so a create
	// that fails in between used to leave a `__pending__` row that every later
	// `single_task` retry read as "a task is already linked" — the guard against
	// duplicates became a guard against ever succeeding, and it said nothing to
	// distinguish itself from a legitimate dedup.
	//
	// The link table stub these tests run against is stateful (claims, finalizes and
	// releases all mutate one array), so "the retry succeeds" is an observation of the
	// released slot rather than a scripted answer.
	describe("a failed create must not leave a blocking claim (issue #653)", () => {
		/** Notion rejects the create — the page does NOT exist afterwards. */
		function stubNotionCreateRejects() {
			return vi.fn(
				async () =>
					({
						ok: false,
						status: 400,
						statusText: "Bad Request",
						json: async () => ({ message: "validation failed" }),
						text: async () => '{"message":"validation failed"}',
					}) as unknown as Response,
			);
		}

		it("releases the claim when the Notion create throws, so no __pending__ row survives", async () => {
			const { insertCalls, updateCalls, deleteCalls } = stubIntegrationsAndLinks({
				notionWork: NOTION_WORK_CONFIG,
				existingLinkCount: 0,
			});
			vi.stubGlobal("fetch", stubNotionCreateRejects());

			await expect(
				createTaskHandler({
					workspace: "notion_work",
					title: "Complete marriage-licence form",
					artifact_id: "11111111-1111-1111-1111-111111111111",
					single_task: true,
				}),
			).rejects.toThrow(/Notion create page failed \(400\)/);

			// Claimed once, never finalized, and the claim was given back.
			expect(insertCalls).toHaveLength(1);
			expect(updateCalls).toHaveLength(0);
			expect(deleteCalls).toHaveLength(1);
			// Scoped to the row this attempt claimed AND to its still-pending state — a
			// release must never be able to reach a finalized link.
			expect(deleteCalls[0]).toEqual([
				["id", "claim-1"],
				["external_id", "__pending__"],
			]);
		});

		it("releases the claim on the actual reported failure: a property that isn't on the tasks DB", async () => {
			// The live 2026-08-19 repro — `properties.owner` against a DB with no such
			// property. This throws in buildNotionProperties, i.e. AFTER the claim and
			// BEFORE the Notion page call, which is the window the bug lived in.
			const { insertCalls, deleteCalls } = stubIntegrationsAndLinks({
				notionWork: {
					...NOTION_WORK_CONFIG,
					property_map: { owner: "Owner" },
				},
				existingLinkCount: 0,
			});
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: string, init: RequestInit) => {
					if (url.includes("/databases/") && init.method === "GET") {
						return {
							ok: true,
							status: 200,
							statusText: "OK",
							json: async () => ({ properties: { Name: { type: "title", title: {} } } }),
							text: async () => "",
						} as unknown as Response;
					}
					throw new Error("Notion page create must never be reached in this test");
				}),
			);

			await expect(
				createTaskHandler({
					workspace: "notion_work",
					title: "Complete marriage-licence form",
					artifact_id: "11111111-1111-1111-1111-111111111111",
					single_task: true,
					properties: { owner: "person_1" },
				}),
			).rejects.toThrow(/Notion property 'Owner' was not found on the tasks database/);

			expect(insertCalls).toHaveLength(1);
			expect(deleteCalls).toHaveLength(1);
		});

		it("does NOT release when Notion accepted the create but the body was unreadable", async () => {
			// The dangerous inversion of this whole fix: Notion returns 200 — the page EXISTS
			// — and the response body is lost on the way back (socket reset, truncated or
			// non-JSON payload). Treating that like a failed write would release the claim
			// and let the retry create a second task, i.e. trade #653's stuck slot for a
			// silent double-create. The claim must survive.
			const { insertCalls, updateCalls, deleteCalls } = stubIntegrationsAndLinks({
				notionWork: NOTION_WORK_CONFIG,
				existingLinkCount: 0,
			});
			const args = {
				workspace: "notion_work" as const,
				title: "Complete marriage-licence form",
				artifact_id: "11111111-1111-1111-1111-111111111111",
				single_task: true,
			};

			vi.stubGlobal(
				"fetch",
				vi.fn(
					async () =>
						({
							ok: true,
							status: 200,
							statusText: "OK",
							json: async () => {
								throw new TypeError("terminated");
							},
							text: async () => "",
						}) as unknown as Response,
				),
			);

			await expect(createTaskHandler(args)).rejects.toThrow(
				/could not be read[\s\S]*deliberately NOT released/,
			);

			// Claimed, never finalized, and — the point — never released.
			expect(insertCalls).toHaveLength(1);
			expect(updateCalls).toHaveLength(0);
			expect(deleteCalls).toHaveLength(0);

			// The surviving claim is what stops the retry double-creating. It refuses
			// loudly, with the remedy, instead of quietly making a second task.
			const fetchMock = stubNotionCreatePage();
			vi.stubGlobal("fetch", fetchMock);
			const retry = await createTaskHandler(args);

			expect(retry.content[0].text).toMatch(/^Blocked:/);
			expect(fetchMock).not.toHaveBeenCalled();
			expect(insertCalls).toHaveLength(1);
		});

		it("a retry after a failed create succeeds — the released slot no longer blocks it", async () => {
			const { insertCalls, updateCalls } = stubIntegrationsAndLinks({
				notionWork: NOTION_WORK_CONFIG,
				existingLinkCount: 0,
			});
			const args = {
				workspace: "notion_work" as const,
				title: "Complete marriage-licence form",
				artifact_id: "11111111-1111-1111-1111-111111111111",
				single_task: true,
			};

			vi.stubGlobal("fetch", stubNotionCreateRejects());
			await expect(createTaskHandler(args)).rejects.toThrow(/Notion create page failed/);

			// Same artifact, same single_task guard, same (stateful) link table.
			vi.stubGlobal("fetch", stubNotionCreatePage());
			const retry = await createTaskHandler(args);

			expect(retry.content[0].text).toContain("Created Notion task");
			expect(retry.content[0].text).not.toMatch(/Skipped:|Blocked:/);
			// The retry got a fresh claim (the first was released, so no 23505) and
			// finalized it with the real page id.
			expect(insertCalls).toHaveLength(2);
			expect(updateCalls).toHaveLength(1);
			expect(updateCalls[0].row).toMatchObject({ external_id: "page_1" });
		});

		it("still dedupes a genuine duplicate: a second single_task create after a SUCCESSFUL one is skipped", async () => {
			const { insertCalls } = stubIntegrationsAndLinks({
				notionWork: NOTION_WORK_CONFIG,
				existingLinkCount: 0,
			});
			const args = {
				workspace: "notion_work" as const,
				title: "Complete marriage-licence form",
				artifact_id: "11111111-1111-1111-1111-111111111111",
				single_task: true,
			};

			vi.stubGlobal("fetch", stubNotionCreatePage());
			const first = await createTaskHandler(args);
			expect(first.content[0].text).toContain("Created Notion task");

			// The finalized row is a real duplicate — releasing pending claims must not
			// have loosened this.
			const fetchMock = stubNotionCreatePage();
			vi.stubGlobal("fetch", fetchMock);
			const second = await createTaskHandler(args);

			expect(second.content[0].text).toMatch(/^Skipped:/);
			expect(second.content[0].text).toContain("already linked");
			expect(second.content[0].text).toContain("skipped as duplicate (single_task)");
			expect(fetchMock).not.toHaveBeenCalled();
			// No second claim row: the pre-check stopped it before the slot was touched.
			expect(insertCalls).toHaveLength(1);
		});

		it("an unfinished claim reports as blocked-with-a-remedy, never as a duplicate", async () => {
			// A row left by a crash (no catch block can run), so the release never happened.
			stubIntegrationsAndLinks({
				notionWork: NOTION_WORK_CONFIG,
				existingLinkCount: 0,
				pendingLinkCount: 1,
			});
			const fetchMock = stubNotionCreatePage();
			vi.stubGlobal("fetch", fetchMock);

			const out = await createTaskHandler({
				workspace: "notion_work",
				title: "Complete marriage-licence form",
				artifact_id: "11111111-1111-1111-1111-111111111111",
				single_task: true,
			});

			const text = out.content[0].text;
			// The silence is the bug: this must not read like the legitimate dedup skip.
			expect(text).toMatch(/^Blocked:/);
			expect(text).not.toContain("already linked");
			expect(text).not.toContain("skipped as duplicate (single_task)");
			expect(text).toContain("NOT a duplicate skip");
			// Names the system of record as the arbiter (ADR-040 erratum, #413) and hands
			// over the statement that clears the row.
			expect(text).toContain("ADR-040 erratum");
			expect(text).toContain(
				"DELETE FROM public.artifact_external_links WHERE artifact_id = " +
					"'11111111-1111-1111-1111-111111111111' AND provider = 'notion_work' " +
					"AND kind = 'task' AND external_id = '__pending__';",
			);
			// Refused, not reclaimed: the slot may belong to an in-flight call.
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it("does NOT release when the page exists and only the finalize fails", async () => {
			// The crash-after-write case, as far as it can be simulated: Notion has the
			// page, the lineage write does not land. Releasing here would strip the slot
			// for a task that really is in Notion, and the next retry would create a second.
			const { updateCalls, deleteCalls } = stubIntegrationsAndLinks({
				notionWork: NOTION_WORK_CONFIG,
				existingLinkCount: 0,
				finalizeError: { message: "connection reset" },
			});
			vi.stubGlobal("fetch", stubNotionCreatePage());

			const out = await createTaskHandler({
				workspace: "notion_work",
				title: "Complete marriage-licence form",
				artifact_id: "11111111-1111-1111-1111-111111111111",
				single_task: true,
			});

			expect(out.content[0].text).toContain("Created Notion task");
			expect(out.content[0].text).toContain("could not record lineage link");
			expect(updateCalls).toHaveLength(1);
			expect(deleteCalls).toHaveLength(0);
		});

		it("reports a failed release alongside the failure that caused it", async () => {
			// Losing the release puts the artifact right back in #653, so the reason has to
			// travel with the error rather than being swallowed.
			stubIntegrationsAndLinks({
				notionWork: NOTION_WORK_CONFIG,
				existingLinkCount: 0,
				releaseError: { message: "permission denied for table" },
			});
			vi.stubGlobal("fetch", stubNotionCreateRejects());

			let failure: Error | undefined;
			try {
				await createTaskHandler({
					workspace: "notion_work",
					title: "Complete marriage-licence form",
					artifact_id: "11111111-1111-1111-1111-111111111111",
					single_task: true,
				});
			} catch (e) {
				failure = e as Error;
			}

			expect(failure).toBeInstanceOf(Error);
			// Both facts, in one message: what failed, and that a retry is now blocked.
			expect(failure?.message).toContain("Notion create page failed (400)");
			expect(failure?.message).toContain("could not be released");
			expect(failure?.message).toContain("permission denied for table");
			expect(failure?.message).toContain("claim-1");
			expect(failure?.cause).toBeInstanceOf(Error);
		});
	});

	it("single_task true but no artifact_id: creates unconditionally (nothing to dedup against)", async () => {
		stubIntegrationsAndLinks({
			notionWork: NOTION_WORK_CONFIG,
			existingLinkCount: 1,
		});
		vi.stubGlobal("fetch", stubNotionCreatePage());

		const out = await createTaskHandler({
			workspace: "notion_work",
			title: "Ship it",
			single_task: true,
		});

		expect(out.content[0].text).toContain("Created Notion task");
	});
});

// Issue #145 gap 2: property passthrough. These tests mirror the fetch-recording pattern
// above but assert on the two Notion calls a `properties`-bearing request makes: a GET
// /databases/{id} (retrieveDatabaseSchema, via buildNotionProperties) followed by the
// POST /pages create — vs. exactly one call (today's create-only POST) on the fast path.
describe("createTaskHandler — property passthrough (issue #145 gap 2)", () => {
	const TASKS_DB_SCHEMA = {
		Name: { type: "title", title: {} },
		Status: {
			type: "status",
			status: { options: [{ name: "Not started" }, { name: "Done" }] },
		},
		Owner: { type: "people", people: {} },
		Meetings: { type: "relation", relation: {} },
	};

	/** Records every fetch call and dispatches GET /databases/* vs POST /pages appropriately. */
	function stubNotionWithSchema(schemaProperties: Record<string, unknown>) {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
			calls.push({ url, init });
			if (url.includes("/databases/") && init.method === "GET") {
				return {
					ok: true,
					status: 200,
					statusText: "OK",
					json: async () => ({ properties: schemaProperties }),
					text: async () => "",
				} as Response;
			}
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({ id: "page_1", url: "https://notion.so/page_1" }),
				text: async () => "",
			} as Response;
		});
		return { fetchMock, calls };
	}

	it("fast path: no `properties` supplied means no retrieveDatabaseSchema call — exactly one fetch (the create POST)", async () => {
		stubUserIntegrations({
			notion_work: {
				tasks_database_id: "db_work",
				title_property: "Name",
				property_map: {},
			},
		});
		const { fetchMock, calls } = stubNotionWithSchema(TASKS_DB_SCHEMA);
		vi.stubGlobal("fetch", fetchMock);

		const out = await createTaskHandler({ workspace: "notion_work", title: "Ship it" });

		expect(out.content[0].text).toContain("Created Notion task");
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("https://api.notion.com/v1/pages");
	});

	it("when `properties` is supplied, introspects the schema first, then creates with the built values merged in", async () => {
		stubUserIntegrations({
			notion_work: {
				tasks_database_id: "db_work",
				title_property: "Name",
				property_map: {},
				notion_user_id: "person_me",
			},
		});
		const { fetchMock, calls } = stubNotionWithSchema(TASKS_DB_SCHEMA);
		vi.stubGlobal("fetch", fetchMock);

		const out = await createTaskHandler({
			workspace: "notion_work",
			title: "Ship it",
			properties: { status: "Done" },
		});

		expect(out.content[0].text).toContain("Created Notion task");
		expect(calls).toHaveLength(2);
		expect(calls[0].url).toBe("https://api.notion.com/v1/databases/db_work");
		expect(calls[0].init.method).toBe("GET");
		expect(calls[1].url).toBe("https://api.notion.com/v1/pages");

		const body = JSON.parse(calls[1].init.body as string);
		expect(body.properties.Status).toEqual({ status: { name: "Done" } });
		// Owner defaults to notion_user_id since `properties` was supplied and owner omitted.
		expect(body.properties.Owner).toEqual({ people: [{ id: "person_me" }] });
	});

	it("passing `properties: {}` still opts into introspection and applies the owner default", async () => {
		stubUserIntegrations({
			notion_work: {
				tasks_database_id: "db_work",
				title_property: "Name",
				property_map: {},
				notion_user_id: "person_me",
			},
		});
		const { fetchMock, calls } = stubNotionWithSchema(TASKS_DB_SCHEMA);
		vi.stubGlobal("fetch", fetchMock);

		const out = await createTaskHandler({
			workspace: "notion_work",
			title: "Ship it",
			properties: {},
		});

		expect(out.content[0].text).toContain("Created Notion task");
		expect(calls).toHaveLength(2);
		const body = JSON.parse(calls[1].init.body as string);
		expect(body.properties.Owner).toEqual({ people: [{ id: "person_me" }] });
	});

	it("no notion_user_id in config and no explicit owner: owner is left unset, not invented", async () => {
		stubUserIntegrations({
			notion_work: {
				tasks_database_id: "db_work",
				title_property: "Name",
				property_map: {},
				// no notion_user_id
			},
		});
		const { fetchMock, calls } = stubNotionWithSchema(TASKS_DB_SCHEMA);
		vi.stubGlobal("fetch", fetchMock);

		await createTaskHandler({ workspace: "notion_work", title: "Ship it", properties: { status: "Done" } });

		const body = JSON.parse(calls[1].init.body as string);
		expect(body.properties.Owner).toBeUndefined();
	});

	it("an invalid select option rejects with a clear, helpful error and never calls the create POST", async () => {
		stubUserIntegrations({
			notion_work: {
				tasks_database_id: "db_work",
				title_property: "Name",
				property_map: {},
			},
		});
		const { fetchMock, calls } = stubNotionWithSchema(TASKS_DB_SCHEMA);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			createTaskHandler({ workspace: "notion_work", title: "Ship it", properties: { status: "Cancelled" } }),
		).rejects.toThrow(/Valid options: Not started, Done/);

		// Only the schema GET happened; the create POST never fired.
		expect(calls).toHaveLength(1);
	});

	it("relation passthrough links the task to a source page via property_map", async () => {
		stubUserIntegrations({
			notion_work: {
				tasks_database_id: "db_work",
				title_property: "Name",
				property_map: { relation: "Meetings" },
			},
		});
		const { fetchMock, calls } = stubNotionWithSchema(TASKS_DB_SCHEMA);
		vi.stubGlobal("fetch", fetchMock);

		await createTaskHandler({
			workspace: "notion_work",
			title: "Follow up on decision",
			properties: {
				relation: { property: "relation", page_ids: ["notion_page_meeting_1"] },
			},
		});

		const body = JSON.parse(calls[1].init.body as string);
		expect(body.properties.Meetings).toEqual({
			relation: [{ id: "notion_page_meeting_1" }],
		});
	});
});

// Issue #413: every task should be traceable to the thought that produced it. When
// task_create is called WITHOUT an artifact_id, the requesting message (source_text, or
// the title as a fallback) is auto-captured as a task_request provenance artifact and the
// task is linked to it. When an artifact_id IS given, nothing is auto-captured.
describe("createTaskHandler — provenance auto-capture (#413)", () => {
	const NOTION_WORK_CONFIG = {
		tasks_database_id: "db_work",
		title_property: "Name",
		property_map: {},
	};

	/**
	 * Stub the full provenance path: user_integrations lookup + storage upload/remove + the
	 * `artifacts` insert (the task_request row) + the `artifact_external_links` upsert (the
	 * task↔source link). Captures each so tests can assert what was persisted. Pass
	 * `artifactInsertError` to simulate the insert failing (best-effort degrade + cleanup).
	 */
	function stubProvenancePath(opts: {
		notionWork?: Record<string, unknown>;
		notionPersonal?: Record<string, unknown>;
		artifactInsertError?: { message: string };
	}) {
		const artifactInserts: Array<Record<string, unknown>> = [];
		const externalLinkUpserts: Array<Record<string, unknown>> = [];
		const uploads: Array<{ path: string; body: unknown }> = [];
		const removes: string[][] = [];

		const configByProvider: Record<string, Record<string, unknown> | undefined> = {
			notion_work: opts.notionWork,
			notion_personal: opts.notionPersonal,
		};

		(supabase.storage as any).from = vi.fn(() => ({
			upload: vi.fn(async (path: string, body: unknown) => {
				uploads.push({ path, body });
				return { error: null };
			}),
			remove: vi.fn(async (paths: string[]) => {
				removes.push(paths);
				return { error: null };
			}),
		}));

		(supabase as any).from = vi.fn((table: string) => {
			if (table === "user_integrations") {
				let currentProvider: string | undefined;
				const b: any = {
					select: () => b,
					eq: (col: string, value: string) => {
						if (col === "provider") currentProvider = value;
						return b;
					},
					maybeSingle: () => {
						const config = currentProvider
							? configByProvider[currentProvider]
							: undefined;
						return Promise.resolve(
							config
								? { data: { config, enabled: true }, error: null }
								: { data: null, error: null },
						);
					},
				};
				return b;
			}
			if (table === "artifacts") {
				return {
					insert: (row: Record<string, unknown>) => {
						artifactInserts.push(row);
						return written(opts.artifactInsertError);
					},
				};
			}
			if (table === "artifact_external_links") {
				const b: any = {
					select: () => b,
					eq: () => b,
					upsert: (row: Record<string, unknown>) => {
						externalLinkUpserts.push(row);
						return Promise.resolve({ error: null });
					},
				};
				return b;
			}
			throw new Error(`Unexpected table in test stub: ${table}`);
		});

		return { artifactInserts, externalLinkUpserts, uploads, removes };
	}

	it("auto-captures the requesting message as a task_request artifact and links the task to it when no artifact_id is given", async () => {
		const { artifactInserts, externalLinkUpserts } = stubProvenancePath({
			notionWork: NOTION_WORK_CONFIG,
		});
		vi.stubGlobal("fetch", stubNotionCreatePage());

		const out = await createTaskHandler({
			workspace: "notion_work",
			title: "Buy milk",
			source_text: "add a task to buy milk on the way home",
		});

		// One provenance artifact, carrying the request verbatim + the distinct marker.
		expect(artifactInserts).toHaveLength(1);
		expect(artifactInserts[0].content_subtype).toBe("task_request");
		expect(artifactInserts[0].plain_text).toBe(
			"add a task to buy milk on the way home",
		);

		// The task links back to that freshly-created artifact (not a caller-supplied one).
		expect(externalLinkUpserts).toHaveLength(1);
		expect(externalLinkUpserts[0].kind).toBe("task");
		expect(externalLinkUpserts[0].artifact_id).toBe(artifactInserts[0].id);
		expect(externalLinkUpserts[0].external_id).toBe("page_1");

		expect(out.content[0].text).toContain("Created Notion task: Buy milk");
		expect(out.content[0].text).toContain("Source captured as artifact");
		expect(out.content[0].text).toContain("content_subtype='task_request'");
		expect(out.content[0].text).toContain(
			`Linked to artifact ${artifactInserts[0].id}`,
		);
	});

	it("falls back to the title as the captured source when source_text is omitted", async () => {
		const { artifactInserts } = stubProvenancePath({
			notionWork: NOTION_WORK_CONFIG,
		});
		vi.stubGlobal("fetch", stubNotionCreatePage());

		await createTaskHandler({ workspace: "notion_work", title: "Call the dentist" });

		expect(artifactInserts).toHaveLength(1);
		expect(artifactInserts[0].plain_text).toBe("Call the dentist");
		expect(artifactInserts[0].content_subtype).toBe("task_request");
	});

	it("stamps surface='act_receipt' on the receipt, never null (#736)", async () => {
		// The receipt has no EXTERNAL surface to copy — nobody sent this row in —
		// but "a receipt this system wrote" is itself an envelope fact, and a
		// nameable one. Left null, the whole class was unaddressable: ADR-046 §3
		// keys the role ladder on this column, so the owner could not demote
		// receipts out of narrative without also demoting every other unstamped
		// path. `act_receipt` is deliberately shared with event_create, whose twin
		// of this function was stamped first (#584).
		const { artifactInserts } = stubProvenancePath({
			notionWork: NOTION_WORK_CONFIG,
		});
		vi.stubGlobal("fetch", stubNotionCreatePage());

		await createTaskHandler({
			workspace: "notion_work",
			title: "Renew passport",
			source_text: "add a task to renew my passport",
		});

		expect(artifactInserts).toHaveLength(1);
		expect(artifactInserts[0].surface).toBe(ARTIFACT_SURFACES.actReceipt);
		expect(artifactInserts[0].surface).not.toBeNull();
	});

	it("stamps tags=['account:personal'] for domain='angus' and tags=['account:work'] for domain='work' (#2225)", async () => {
		const personalStub = stubProvenancePath({
			notionPersonal: {
				tasks_database_id: "db_personal",
				title_property: "Name",
				property_map: {},
			},
		});
		vi.stubGlobal("fetch", stubNotionCreatePage());

		await createTaskHandler({
			domain: "angus",
			title: "Book flights",
			source_text: "book flights for holiday",
		});

		expect(personalStub.artifactInserts).toHaveLength(1);
		expect(personalStub.artifactInserts[0].content_subtype).toBe("task_request");
		expect(personalStub.artifactInserts[0].tags).toEqual(["account:personal"]);

		const workStub = stubProvenancePath({
			notionWork: NOTION_WORK_CONFIG,
		});
		vi.stubGlobal("fetch", stubNotionCreatePage());

		await createTaskHandler({
			domain: "work",
			title: "Review deck",
			source_text: "review investor deck",
		});

		expect(workStub.artifactInserts).toHaveLength(1);
		expect(workStub.artifactInserts[0].content_subtype).toBe("task_request");
		expect(workStub.artifactInserts[0].tags).toEqual(["account:work"]);
	});

	it("does NOT auto-capture a provenance artifact when artifact_id is supplied (the task already has a source)", async () => {
		const { artifactInserts, externalLinkUpserts } = stubProvenancePath({
			notionWork: NOTION_WORK_CONFIG,
		});
		vi.stubGlobal("fetch", stubNotionCreatePage());

		const out = await createTaskHandler({
			workspace: "notion_work",
			title: "Follow up",
			artifact_id: "11111111-1111-1111-1111-111111111111",
		});

		expect(artifactInserts).toHaveLength(0);
		expect(externalLinkUpserts).toHaveLength(1);
		expect(externalLinkUpserts[0].artifact_id).toBe(
			"11111111-1111-1111-1111-111111111111",
		);
		expect(out.content[0].text).not.toContain("Source captured as artifact");
	});

	it("ignores source_text when artifact_id is supplied", async () => {
		const { artifactInserts } = stubProvenancePath({
			notionWork: NOTION_WORK_CONFIG,
		});
		vi.stubGlobal("fetch", stubNotionCreatePage());

		await createTaskHandler({
			workspace: "notion_work",
			title: "Follow up",
			artifact_id: "11111111-1111-1111-1111-111111111111",
			source_text: "this should be ignored",
		});

		expect(artifactInserts).toHaveLength(0);
	});

	it("triage-defaults regression guard (#298): provenance auto-capture is unaffected by a due default firing on the same call", async () => {
		const { artifactInserts } = stubProvenancePath({
			notionWork: {
				...NOTION_WORK_CONFIG,
				property_map: { due: "Due" },
			},
		});
		vi.stubGlobal("fetch", stubNotionCreatePage());

		const out = await createTaskHandler({
			workspace: "notion_work",
			title: "Buy milk",
			source_text: "add a task to buy milk",
		});

		expect(artifactInserts).toHaveLength(1);
		expect(out.content[0].text).toContain("Defaulted due date to tomorrow");
		expect(out.content[0].text).toContain("Source captured as artifact");
	});

	it("still creates the task (best-effort) when provenance capture fails, and cleans up the storage object", async () => {
		const { externalLinkUpserts, removes } = stubProvenancePath({
			notionWork: NOTION_WORK_CONFIG,
			artifactInsertError: { message: "boom" },
		});
		vi.stubGlobal("fetch", stubNotionCreatePage());

		const out = await createTaskHandler({ workspace: "notion_work", title: "Buy milk", source_text: "buy milk" });

		expect(out.content[0].text).toContain("Created Notion task: Buy milk");
		expect(out.content[0].text).toContain(
			"could not capture task-request provenance",
		);
		// No lineage link — there is no artifact id to link to when capture failed.
		expect(externalLinkUpserts).toHaveLength(0);
		// The just-uploaded storage object is cleaned up so a failed insert doesn't orphan it.
		expect(removes).toHaveLength(1);
	});
});

// Issue #298 (capture consolidation slice 3): May-12's task triage defaults live in TASK
// CREATION, not capture — Due = tomorrow when no due date is given, Priority = the top
// tier the DB accepts (High/P1/P0, ADR-040 §3) when no priority is given. Defaults are
// explicit in the response text, never silent; explicit caller values always win.
describe("createTaskHandler — triage defaults (#298)", () => {
	/** Records every fetch call, dispatching GET /databases/* (schema) vs POST /pages. */
	function stubNotionWithSchema(schemaProperties: Record<string, unknown>) {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
			calls.push({ url, init });
			if (url.includes("/databases/") && init.method === "GET") {
				return {
					ok: true,
					status: 200,
					statusText: "OK",
					json: async () => ({ properties: schemaProperties }),
					text: async () => "",
				} as Response;
			}
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({ id: "page_1", url: "https://notion.so/page_1" }),
				text: async () => "",
			} as Response;
		});
		return { fetchMock, calls };
	}

	const SCHEMA_WITH_HML_PRIORITY = {
		Name: { type: "title", title: {} },
		Due: { type: "date", date: {} },
		Priority: {
			type: "select",
			select: { options: [{ name: "Low" }, { name: "Medium" }, { name: "High" }] },
		},
	};

	const SCHEMA_WITH_P_PRIORITY = {
		Name: { type: "title", title: {} },
		Priority: {
			type: "select",
			select: {
				options: [{ name: "P0" }, { name: "P1" }, { name: "P2" }, { name: "P3" }],
			},
		},
	};

	describe("due default", () => {
		it("no due given + 'due' mapped: defaults to tomorrow and says so explicitly", async () => {
			stubUserIntegrations({
				notion_work: {
					tasks_database_id: "db_work",
					title_property: "Name",
					property_map: { due: "Due" },
				},
			});
			const { fetchMock, calls } = stubNotionWithSchema(SCHEMA_WITH_HML_PRIORITY);
			vi.stubGlobal("fetch", fetchMock);

			const out = await createTaskHandler({ workspace: "notion_work", title: "Ship it" });

			const expected = tomorrowDateOnly();
			expect(out.content[0].text).toContain(
				`Defaulted due date to tomorrow (${expected})`,
			);
			// Priority is NOT mapped and no properties were supplied → still the fast path:
			// exactly one fetch (the create POST), no schema introspection.
			expect(calls).toHaveLength(1);
			const body = JSON.parse(calls[0].init.body as string);
			expect(body.properties.Due).toEqual({ date: { start: expected } });
		});

		it("an explicit due wins over the default, with no 'Defaulted' note", async () => {
			stubUserIntegrations({
				notion_work: {
					tasks_database_id: "db_work",
					title_property: "Name",
					property_map: { due: "Due" },
				},
			});
			const { fetchMock, calls } = stubNotionWithSchema(SCHEMA_WITH_HML_PRIORITY);
			vi.stubGlobal("fetch", fetchMock);

			const out = await createTaskHandler({ workspace: "notion_work", title: "Ship it", due: "2030-01-02" });

			expect(out.content[0].text).not.toContain("Defaulted due date");
			const body = JSON.parse(calls[0].init.body as string);
			expect(body.properties.Due).toEqual({ date: { start: "2030-01-02" } });
		});

		it("round-1 review (L1): an empty-string due is rejected at the schema, not silently treated as omitted", () => {
			// Empty string is falsy, same as `undefined`, to the `!effectiveDue` check the
			// tomorrow-default branches on — without a schema guard it would silently trigger
			// the default instead of surfacing the caller's mistake. `due` matches the
			// `.min(1)` convention already used for `source_text`/`dedup_key` elsewhere in
			// this schema.
			const result = z.object(createTaskInput).safeParse({ title: "Ship it", due: "" });
			expect(result.success).toBe(false);
		});

		it("no 'due' property mapped: no default is applied and nothing is sent (nothing to set)", async () => {
			stubUserIntegrations({
				notion_work: {
					tasks_database_id: "db_work",
					title_property: "Name",
					property_map: {},
				},
			});
			const { fetchMock, calls } = stubNotionWithSchema(SCHEMA_WITH_HML_PRIORITY);
			vi.stubGlobal("fetch", fetchMock);

			const out = await createTaskHandler({ workspace: "notion_work", title: "Ship it" });

			expect(out.content[0].text).not.toContain("Defaulted due date");
			// And no misleading "was given but not mapped" note either — nothing was given.
			expect(out.content[0].text).not.toContain("no 'due' property is mapped");
			const body = JSON.parse(calls[0].init.body as string);
			expect(body.properties.Due).toBeUndefined();
		});
	});

	describe("priority default", () => {
		it("'priority' mapped + no properties supplied: introspects, defaults to 'High', and says so", async () => {
			stubUserIntegrations({
				notion_work: {
					tasks_database_id: "db_work",
					title_property: "Name",
					property_map: { priority: "Priority" },
				},
			});
			const { fetchMock, calls } = stubNotionWithSchema(SCHEMA_WITH_HML_PRIORITY);
			vi.stubGlobal("fetch", fetchMock);

			const out = await createTaskHandler({ workspace: "notion_work", title: "Ship it" });

			expect(out.content[0].text).toContain("Defaulted priority to 'High'");
			expect(calls).toHaveLength(2);
			expect(calls[0].url).toBe("https://api.notion.com/v1/databases/db_work");
			const body = JSON.parse(calls[1].init.body as string);
			expect(body.properties.Priority).toEqual({ select: { name: "High" } });
		});

		it("P0–P4 vocabulary (ADR-040 tier 1): defaults to 'P1', not 'P0' and not an invented 'High'", async () => {
			stubUserIntegrations({
				notion_work: {
					tasks_database_id: "db_work",
					title_property: "Name",
					property_map: { priority: "Priority" },
				},
			});
			const { fetchMock, calls } = stubNotionWithSchema(SCHEMA_WITH_P_PRIORITY);
			vi.stubGlobal("fetch", fetchMock);

			const out = await createTaskHandler({ workspace: "notion_work", title: "Ship it" });

			expect(out.content[0].text).toContain("Defaulted priority to 'P1'");
			const body = JSON.parse(calls[1].init.body as string);
			expect(body.properties.Priority).toEqual({ select: { name: "P1" } });
		});

		it("an explicit properties.priority wins over the default, with no 'Defaulted' note", async () => {
			stubUserIntegrations({
				notion_work: {
					tasks_database_id: "db_work",
					title_property: "Name",
					property_map: { priority: "Priority" },
				},
			});
			const { fetchMock, calls } = stubNotionWithSchema(SCHEMA_WITH_HML_PRIORITY);
			vi.stubGlobal("fetch", fetchMock);

			const out = await createTaskHandler({
				workspace: "notion_work",
				title: "Ship it",
				properties: { priority: "Low" },
			});

			expect(out.content[0].text).not.toContain("Defaulted priority");
			const body = JSON.parse(calls[1].init.body as string);
			expect(body.properties.Priority).toEqual({ select: { name: "Low" } });
		});

		it("properties supplied without priority (priority unmapped): defaults via the 'Priority' fallback name", async () => {
			stubUserIntegrations({
				notion_work: {
					tasks_database_id: "db_work",
					title_property: "Name",
					property_map: {},
				},
			});
			const { fetchMock, calls } = stubNotionWithSchema(SCHEMA_WITH_HML_PRIORITY);
			vi.stubGlobal("fetch", fetchMock);

			const out = await createTaskHandler({ workspace: "notion_work", title: "Ship it", properties: {} });

			expect(out.content[0].text).toContain("Defaulted priority to 'High'");
			const body = JSON.parse(calls[1].init.body as string);
			expect(body.properties.Priority).toEqual({ select: { name: "High" } });
		});

		it("mapped but none of High/P1/P0 is a configured option: skips the default with an explicit note, task still created", async () => {
			stubUserIntegrations({
				notion_work: {
					tasks_database_id: "db_work",
					title_property: "Name",
					property_map: { priority: "Priority" },
				},
			});
			const { fetchMock, calls } = stubNotionWithSchema({
				Name: { type: "title", title: {} },
				Priority: {
					type: "select",
					select: { options: [{ name: "Urgent" }, { name: "Later" }] },
				},
			});
			vi.stubGlobal("fetch", fetchMock);

			const out = await createTaskHandler({ workspace: "notion_work", title: "Ship it" });

			expect(out.content[0].text).toContain("Created Notion task: Ship it");
			expect(out.content[0].text).toContain("no priority default applied");
			const body = JSON.parse(calls[1].init.body as string);
			expect(body.properties.Priority).toBeUndefined();
		});

		it("properties supplied, DB has no priority property at all (unmapped): stays quiet — nothing was promised", async () => {
			stubUserIntegrations({
				notion_work: {
					tasks_database_id: "db_work",
					title_property: "Name",
					property_map: {},
				},
			});
			const { fetchMock, calls } = stubNotionWithSchema({
				Name: { type: "title", title: {} },
				Status: {
					type: "status",
					status: { options: [{ name: "Not started" }, { name: "Done" }] },
				},
			});
			vi.stubGlobal("fetch", fetchMock);

			const out = await createTaskHandler({
				workspace: "notion_work",
				title: "Ship it",
				properties: { status: "Done" },
			});

			expect(out.content[0].text).toContain("Created Notion task: Ship it");
			expect(out.content[0].text).not.toContain("Defaulted priority");
			expect(out.content[0].text).not.toContain("no priority default applied");
			const body = JSON.parse(calls[1].init.body as string);
			expect(body.properties.Priority).toBeUndefined();
		});

		it("entering the properties path solely for the priority default does NOT start defaulting the owner (pre-#298 behaviour preserved)", async () => {
			stubUserIntegrations({
				notion_work: {
					tasks_database_id: "db_work",
					title_property: "Name",
					property_map: { priority: "Priority" },
					notion_user_id: "person_me",
				},
			});
			const { fetchMock, calls } = stubNotionWithSchema({
				...SCHEMA_WITH_HML_PRIORITY,
				Owner: { type: "people", people: {} },
			});
			vi.stubGlobal("fetch", fetchMock);

			await createTaskHandler({ workspace: "notion_work", title: "Ship it" });

			const body = JSON.parse(calls[1].init.body as string);
			expect(body.properties.Priority).toEqual({ select: { name: "High" } });
			expect(body.properties.Owner).toBeUndefined();
		});
	});

// Issue #734: create_task has no system-of-record duplicate guard. These tests exercise
// findExistingNotionTask indirectly through createTaskHandler — the guard is default-on,
// reads the target workspace's tasks database (via its `*_data_source_id`) for an OPEN
// task whose title matches, and skips creation (returning the existing page) on a hit.
describe("createTaskHandler — Tasks-DB duplicate guard (#734)", () => {
	/**
	 * Dispatches the three endpoints this guard's tests touch: POST /data_sources/{id}/query
	 * (the guard's own read), GET /databases/{id} (schema, only reached when `properties` is
	 * supplied), and POST /pages (the create). `queryResults` seeds what the data-source
	 * query returns; defaults to an empty page (no match).
	 */
	function stubNotionWithDataSourceQuery(opts: {
		queryResults?: Array<Record<string, unknown>>;
		queryShouldFail?: boolean;
	}) {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
			calls.push({ url, init });
			if (url.includes("/data_sources/") && url.endsWith("/query")) {
				if (opts.queryShouldFail) {
					return {
						ok: false,
						status: 500,
						statusText: "Internal Server Error",
						json: async () => ({ message: "internal error" }),
						text: async () => '{"message":"internal error"}',
					} as unknown as Response;
				}
				return {
					ok: true,
					status: 200,
					statusText: "OK",
					json: async () => ({
						results: opts.queryResults ?? [],
						next_cursor: null,
						has_more: false,
					}),
					text: async () => "",
				} as Response;
			}
			if (url.includes("/databases/")) {
				return {
					ok: true,
					status: 200,
					statusText: "OK",
					json: async () => ({ properties: { Name: { type: "title", title: {} } } }),
					text: async () => "",
				} as Response;
			}
			// POST /pages
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({ id: "page_new", url: "https://notion.so/page_new" }),
				text: async () => "",
			} as Response;
		});
		return { fetchMock, calls };
	}

	const GUARDED_CONFIG = {
		tasks_database_id: "db_work",
		title_property: "Name",
		property_map: {},
		// Wires the guard on: without this key resolveTasksDataSourceId returns undefined
		// and the guard is a no-op (see the "no data source id configured" test below).
		tasks_source_data_source_id: "ds_tasks_work",
	};

	/** One Notion query-result page shaped like the Name/Status schema these tests use. */
	function notionTaskRow(opts: { id?: string; title: string; status?: string }) {
		return {
			id: opts.id ?? "page_existing",
			url: `https://notion.so/${opts.id ?? "page_existing"}`,
			archived: false,
			properties: {
				Name: { type: "title", title: [{ plain_text: opts.title }] },
				...(opts.status
					? { Status: { type: "status", status: { name: opts.status } } }
					: {}),
			},
		};
	}

	it("a matching open task: skips creation, reports the existing page, no POST /pages call", async () => {
		stubUserIntegrations({ notion_work: GUARDED_CONFIG });
		const { fetchMock, calls } = stubNotionWithDataSourceQuery({
			// Case/whitespace differ from the request on purpose — the match rule is
			// exact-after-trim-and-lowercase, not byte-exact.
			queryResults: [notionTaskRow({ id: "page_dup", title: "  Ship IT  ", status: "Not started" })],
		});
		vi.stubGlobal("fetch", fetchMock);

		const out = await createTaskHandler({ workspace: "notion_work", title: "Ship it" });

		expect(out.content[0].text).toContain("Duplicate of existing task");
		expect(out.content[0].text).toContain("page_dup");
		expect(out.content[0].text).toContain("https://notion.so/page_dup");
		expect(calls.some((c) => c.url.endsWith("/pages") && c.init.method === "POST")).toBe(false);
		// The query itself hit the data-source endpoint, not the legacy database query.
		expect(calls.some((c) => c.url.includes("/data_sources/ds_tasks_work/query"))).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("no matching task: creates as before, exactly like the unguarded path", async () => {
		stubUserIntegrations({ notion_work: GUARDED_CONFIG });
		const { fetchMock, calls } = stubNotionWithDataSourceQuery({
			queryResults: [notionTaskRow({ title: "Something unrelated" })],
		});
		vi.stubGlobal("fetch", fetchMock);

		const out = await createTaskHandler({ workspace: "notion_work", title: "Ship it" });

		expect(out.content[0].text).toContain("Created Notion task: Ship it");
		expect(calls.some((c) => c.url.endsWith("/pages") && c.init.method === "POST")).toBe(true);
	});

	it("a matching task whose status is closed (Done): not treated as a duplicate, creates a new one", async () => {
		stubUserIntegrations({ notion_work: GUARDED_CONFIG });
		const { fetchMock } = stubNotionWithDataSourceQuery({
			queryResults: [notionTaskRow({ title: "Ship it", status: "Done" })],
		});
		vi.stubGlobal("fetch", fetchMock);

		const out = await createTaskHandler({ workspace: "notion_work", title: "Ship it" });

		expect(out.content[0].text).toContain("Created Notion task: Ship it");
	});

	it("skip_notion_dedup: true — creates without ever querying the data source (fast path pays nothing)", async () => {
		stubUserIntegrations({ notion_work: GUARDED_CONFIG });
		const { fetchMock, calls } = stubNotionWithDataSourceQuery({
			queryResults: [notionTaskRow({ title: "Ship it" })],
		});
		vi.stubGlobal("fetch", fetchMock);

		const out = await createTaskHandler({
			workspace: "notion_work",
			title: "Ship it",
			skip_notion_dedup: true,
		});

		expect(out.content[0].text).toContain("Created Notion task: Ship it");
		expect(calls.some((c) => c.url.includes("/data_sources/"))).toBe(false);
	});

	it("no data source id configured for the workspace: the guard is a no-op, creates as before", async () => {
		// Same config, minus tasks_source_data_source_id — resolveTasksDataSourceId
		// returns undefined, so findExistingNotionTask returns early with no query.
		stubUserIntegrations({
			notion_work: {
				tasks_database_id: "db_work",
				title_property: "Name",
				property_map: {},
			},
		});
		const { fetchMock, calls } = stubNotionWithDataSourceQuery({});
		vi.stubGlobal("fetch", fetchMock);

		const out = await createTaskHandler({ workspace: "notion_work", title: "Ship it" });

		expect(out.content[0].text).toContain("Created Notion task: Ship it");
		expect(calls.some((c) => c.url.includes("/data_sources/"))).toBe(false);
	});

	it("the Notion query fails: degrades to fail-open — creates the task and notes the guard could not run", async () => {
		stubUserIntegrations({ notion_work: GUARDED_CONFIG });
		const { fetchMock } = stubNotionWithDataSourceQuery({ queryShouldFail: true });
		vi.stubGlobal("fetch", fetchMock);

		const out = await createTaskHandler({ workspace: "notion_work", title: "Ship it" });

		expect(out.content[0].text).toContain("Created Notion task: Ship it");
		expect(out.content[0].text).toContain("Tasks-DB duplicate guard could not run");
	});

	it("a relation match (source page already linked): reported as a duplicate even with a different title", async () => {
		stubUserIntegrations({
			notion_work: { ...GUARDED_CONFIG, property_map: { relation: "Meetings" } },
		});
		const { fetchMock, calls } = stubNotionWithDataSourceQuery({
			queryResults: [
				{
					id: "page_dup_by_relation",
					url: "https://notion.so/page_dup_by_relation",
					archived: false,
					properties: {
						Name: { type: "title", title: [{ plain_text: "A completely different title" }] },
						Meetings: { type: "relation", relation: [{ id: "notion_page_meeting_1" }] },
					},
				},
			],
		});
		vi.stubGlobal("fetch", fetchMock);

		const out = await createTaskHandler({
			workspace: "notion_work",
			title: "Follow up on decision",
			properties: {
				relation: { property: "relation", page_ids: ["notion_page_meeting_1"] },
			},
		});

		expect(out.content[0].text).toContain("Duplicate of existing task");
		expect(out.content[0].text).toContain("page_dup_by_relation");
		expect(calls.some((c) => c.url.endsWith("/pages") && c.init.method === "POST")).toBe(false);
	});

	it("workspace='notion_personal' uses tasks_data_source_id (the personal schema's own key name)", async () => {
		stubUserIntegrations({
			notion_personal: {
				tasks_database_id: "db_personal",
				title_property: "Name",
				property_map: {},
				tasks_data_source_id: "ds_tasks_personal",
			},
		});
		const { fetchMock, calls } = stubNotionWithDataSourceQuery({
			queryResults: [notionTaskRow({ title: "Buy groceries" })],
		});
		vi.stubGlobal("fetch", fetchMock);

		const out = await createTaskHandler({ workspace: "notion_personal", title: "Buy groceries" });

		expect(out.content[0].text).toContain("Duplicate of existing task");
		expect(calls.some((c) => c.url.includes("/data_sources/ds_tasks_personal/query"))).toBe(true);
	});

	// --- Round-1 QA (#734) fixes ------------------------------------------------------

	it("a matched task's status is in the workspace's configured done_values (not the hardcoded set): treated as closed, creates a new task", async () => {
		// "Shipped" is not in CLOSED_STATUS_NAMES, so without consulting done_values this
		// would be (mis)read as open and block the create — the dangerous direction the
		// round-1 review flagged.
		stubUserIntegrations({
			notion_personal: {
				tasks_database_id: "db_personal",
				title_property: "Name",
				property_map: {},
				tasks_data_source_id: "ds_tasks_personal",
				automations: {
					completed_at_stamp: {
						data_source_id: "ds_tasks_personal",
						status_property: "Status",
						done_values: ["Shipped"],
						completed_at_property: "Completed at",
					},
				},
			},
		});
		const { fetchMock } = stubNotionWithDataSourceQuery({
			queryResults: [notionTaskRow({ title: "Ship it", status: "Shipped" })],
		});
		vi.stubGlobal("fetch", fetchMock);

		const out = await createTaskHandler({ workspace: "notion_personal", title: "Ship it" });

		expect(out.content[0].text).toContain("Created Notion task: Ship it");
	});

	it("a configured done_values rule for a DIFFERENT data source/status property does not apply: falls back to the hardcoded set", async () => {
		stubUserIntegrations({
			notion_personal: {
				tasks_database_id: "db_personal",
				title_property: "Name",
				property_map: {},
				tasks_data_source_id: "ds_tasks_personal",
				automations: {
					completed_at_stamp: {
						// Different data source than the one this guard queries — must not apply.
						data_source_id: "ds_some_other_db",
						status_property: "Status",
						done_values: ["Shipped"],
						completed_at_property: "Completed at",
					},
				},
			},
		});
		const { fetchMock } = stubNotionWithDataSourceQuery({
			queryResults: [notionTaskRow({ title: "Ship it", status: "Shipped" })],
		});
		vi.stubGlobal("fetch", fetchMock);

		const out = await createTaskHandler({ workspace: "notion_personal", title: "Ship it" });

		// "Shipped" isn't in the hardcoded fallback set either, so — as before this fix,
		// and correctly, since the rule doesn't apply here — it's treated as open.
		expect(out.content[0].text).toContain("Duplicate of existing task");
	});

	it("a duplicate on page 2+ of the query is still found (follows has_more/next_cursor pagination)", async () => {
		stubUserIntegrations({ notion_work: GUARDED_CONFIG });
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
			calls.push({ url, init });
			if (url.includes("/data_sources/") && url.endsWith("/query")) {
				const body = JSON.parse((init.body as string) ?? "{}");
				if (!body.start_cursor) {
					// Page 1: no match, more pages available.
					return {
						ok: true,
						status: 200,
						statusText: "OK",
						json: async () => ({
							results: [notionTaskRow({ id: "page_unrelated", title: "Something unrelated" })],
							next_cursor: "cursor_2",
							has_more: true,
						}),
						text: async () => "",
					} as Response;
				}
				// Page 2: the real match.
				return {
					ok: true,
					status: 200,
					statusText: "OK",
					json: async () => ({
						results: [notionTaskRow({ id: "page_dup", title: "Ship it", status: "Not started" })],
						next_cursor: null,
						has_more: false,
					}),
					text: async () => "",
				} as Response;
			}
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({ id: "page_new", url: "https://notion.so/page_new" }),
				text: async () => "",
			} as Response;
		});
		vi.stubGlobal("fetch", fetchMock);

		const out = await createTaskHandler({ workspace: "notion_work", title: "Ship it" });

		expect(out.content[0].text).toContain("Duplicate of existing task");
		expect(out.content[0].text).toContain("page_dup");
		const queryCalls = calls.filter((c) => c.url.includes("/data_sources/") && c.url.endsWith("/query"));
		expect(queryCalls).toHaveLength(2);
	});

	it("a relation given with no property_map['relation'] mapping: degrades to title-only matching instead of guessing a property name", async () => {
		stubUserIntegrations({
			// No `relation` key in property_map — deliberately unmapped.
			notion_work: { ...GUARDED_CONFIG, property_map: {} },
		});
		const { fetchMock, calls } = stubNotionWithDataSourceQuery({
			queryResults: [notionTaskRow({ id: "page_dup", title: "Follow up on decision" })],
		});
		vi.stubGlobal("fetch", fetchMock);

		const out = await createTaskHandler({
			workspace: "notion_work",
			title: "Follow up on decision",
			properties: {
				relation: { property: "relation", page_ids: ["notion_page_meeting_1"] },
			},
		});

		// Still catches the duplicate via title, without the query filter guessing at a
		// "Relation" property that may not exist on this database.
		expect(out.content[0].text).toContain("Duplicate of existing task");
		expect(out.content[0].text).toContain("page_dup");
		const queryCall = calls.find((c) => c.url.includes("/data_sources/") && c.url.endsWith("/query"));
		const body = JSON.parse((queryCall?.init.body as string) ?? "{}");
		expect(JSON.stringify(body.filter)).not.toContain("relation");
	});
});

describe("createTaskHandler — for_person_id promise to person (#1028)", () => {
	const PERSON_ENTITY_ID = "11111111-2222-3333-4444-555555555555";
	const TASKS_DB_SCHEMA_WITH_PERSON = {
		Name: { type: "title", title: {} },
		Person: { type: "relation", relation: {} },
	};

	it("throws if for_person_id entity does not exist for the user", async () => {
		stubUserIntegrations(
			{
				notion_work: {
					tasks_database_id: "db_work",
					title_property: "Name",
				},
			},
			{ entities: {} },
		);

		await expect(
			createTaskHandler({
				workspace: "notion_work",
				title: "Send report to Alice",
				for_person_id: PERSON_ENTITY_ID,
				skip_notion_dedup: true,
			}),
		).rejects.toThrow(/Person entity '11111111-2222-3333-4444-555555555555' not found/);
	});

	it("throws if for_person_id resolves to a non-person entity (round-1 QA finding)", async () => {
		stubUserIntegrations(
			{
				notion_work: {
					tasks_database_id: "db_work",
					title_property: "Name",
				},
			},
			{
				entities: {
					[PERSON_ENTITY_ID]: {
						id: PERSON_ENTITY_ID,
						title: "Acme Corp",
						entity_type: "organisation",
						properties: {},
					},
				},
			},
		);

		await expect(
			createTaskHandler({
				workspace: "notion_work",
				title: "Send report",
				for_person_id: PERSON_ENTITY_ID,
				skip_notion_dedup: true,
			}),
		).rejects.toThrow(/is not a person \(entity_type='organisation'\)/);
	});

	it("links relation in Notion and records artifact_entity_links when person entity has Notion page ID", async () => {
		const artifactEntityLinksUpserts: any[] = [];
		stubUserIntegrations(
			{
				notion_work: {
					tasks_database_id: "db_work",
					title_property: "Name",
					property_map: {},
				},
			},
			{
				entities: {
					[PERSON_ENTITY_ID]: {
						id: PERSON_ENTITY_ID,
						title: "Alice",
						entity_type: "people",
						properties: { notion_page_id: "alice_page_notion" },
					},
				},
				artifactEntityLinksUpserts,
			},
		);

		const { fetchMock, calls } = stubNotionWithSchema(TASKS_DB_SCHEMA_WITH_PERSON);
		vi.stubGlobal("fetch", fetchMock);

		const res = await createTaskHandler({
			workspace: "notion_work",
			title: "Promise to Alice",
			for_person_id: PERSON_ENTITY_ID,
			skip_notion_dedup: true,
		});

		expect(res.content[0].text).toContain(`Linked promise to person entity ${PERSON_ENTITY_ID}`);

		// Notion POST should include Person relation
		const createPost = calls.find((c) => c.url.endsWith("/pages") && c.init.method === "POST");
		expect(createPost).toBeDefined();
		const body = JSON.parse(createPost!.init.body as string);
		expect(body.properties.Person).toEqual({
			relation: [{ id: "alice_page_notion" }],
		});

		// artifact_entity_links should be upserted with promise_to notes
		expect(artifactEntityLinksUpserts).toHaveLength(1);
		expect(artifactEntityLinksUpserts[0]).toMatchObject({
			entity_id: PERSON_ENTITY_ID,
			link_type: "related",
			confidence_score: 1.0,
			created_by: "mcp",
			notes: "promise_to",
		});
	});

	it("creates task without Notion relation if target DB has no person relation, but still records artifact_entity_links", async () => {
		const artifactEntityLinksUpserts: any[] = [];
		stubUserIntegrations(
			{
				notion_work: {
					tasks_database_id: "db_work",
					title_property: "Name",
					property_map: {},
				},
			},
			{
				entities: {
					[PERSON_ENTITY_ID]: {
						id: PERSON_ENTITY_ID,
						title: "Alice",
						entity_type: "people",
						properties: {},
					},
				},
				artifactEntityLinksUpserts,
			},
		);

		const { fetchMock, calls } = stubNotionWithSchema({ Name: { type: "title", title: {} } });
		vi.stubGlobal("fetch", fetchMock);

		const res = await createTaskHandler({
			workspace: "notion_work",
			title: "Promise without notion person relation",
			for_person_id: PERSON_ENTITY_ID,
			skip_notion_dedup: true,
		});

		expect(res.content[0].text).toContain(`Linked promise to person entity ${PERSON_ENTITY_ID}`);

		const createPost = calls.find((c) => c.url.endsWith("/pages") && c.init.method === "POST");
		expect(createPost).toBeDefined();
		const body = JSON.parse(createPost!.init.body as string);
		expect(body.properties.Person).toBeUndefined();

		expect(artifactEntityLinksUpserts).toHaveLength(1);
		expect(artifactEntityLinksUpserts[0]).toMatchObject({
			entity_id: PERSON_ENTITY_ID,
			link_type: "related",
			notes: "promise_to",
		});
	});
});

describe("tomorrowDateOnly", () => {
	it("returns the next local calendar day as YYYY-MM-DD", () => {
		expect(tomorrowDateOnly(new Date(2026, 7, 5))).toBe("2026-08-06");
	});

	it("rolls over month and year ends", () => {
		expect(tomorrowDateOnly(new Date(2026, 7, 31))).toBe("2026-09-01");
		expect(tomorrowDateOnly(new Date(2026, 11, 31))).toBe("2027-01-01");
	});

	it("pads single-digit months and days", () => {
		expect(tomorrowDateOnly(new Date(2026, 0, 8))).toBe("2026-01-09");
	});
});
});

describe("createTaskAction (ADR-100)", () => {
	it("executes directly returning structured CreateTaskResult", async () => {
		stubStorageWrites();
		stubUserIntegrations({
			notion_work: {
				tasks_database_id: "db_work",
				title_property: "Name",
				property_map: {},
			},
		});
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			if (url.includes("/databases/") && init?.method === "GET") {
				return {
					ok: true,
					status: 200,
					statusText: "OK",
					json: async () => ({ properties: { Name: { type: "title", title: {} } } }),
					text: async () => "",
				} as Response;
			}
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({ id: "page_action_1", url: "https://notion.so/page_action_1" }),
				text: async () => "",
			} as Response;
		});
		vi.stubGlobal("fetch", fetchMock);

		const result = await executeAction(createTaskAction, {
			domain: "work",
			title: "Direct Action Task",
			skip_notion_dedup: true,
		});

		expect(result.status).toBe("created");
		expect(result.title).toBe("Direct Action Task");
		expect(result.deduplicated).toBe(false);
		expect(result.pageId).toBe("page_action_1");
		expect(result.message).toContain("Created Notion task: Direct Action Task");
	});
});
