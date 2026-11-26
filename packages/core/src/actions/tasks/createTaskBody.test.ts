import { describe, expect, it, vi } from "vitest";
import { ExternalItemCreatedButUnreadable, externalItemWasCreated } from "../outwardWrite.js";
import { formatCreateTaskMcp } from "./createTask.js";
import { runCreateTask, type CreateTaskPorts } from "./createTaskBody.js";
import { notionDuplicateText, skippedDuplicateText } from "./createTaskRules.js";

const OWNER = "owner-1";
const ARTIFACT = "art-1";
const PAGE = { id: "page_1", url: "https://notion.so/page_1" };
const OPEN_TWIN = {
	id: "page_0",
	url: "https://notion.so/page_0",
	properties: { Name: { title: [{ plain_text: " buy MILK " }] }, Status: { status: { name: "To do" } } },
};

/** Fake core ports: a configured Work workspace, an empty Tasks DB, and a free ledger. */
function fakePorts() {
	const released: string[] = [];
	const ports = {
		notion: {
			queryDataSource: vi.fn(async () => ({ results: [] as unknown[], has_more: false })),
			retrieveDatabase: vi.fn(async () => ({ properties: {} })),
			createPage: vi.fn(async () => PAGE),
		},
		config: {
			loadConfig: vi.fn(async () => ({
				tasks_database_id: "db_tasks",
				tasks_source_data_source_id: "ds_tasks",
				title_property: "Name",
				property_map: {},
			})),
		},
		links: {
			inspectDedupSlot: vi.fn(async () => "free"),
			claimDedupSlot: vi.fn(async () => ({ claimed: true, linkId: "claim_1" }) as object),
			finalizeExternalLink: vi.fn(async () => ({ ok: true })),
			recordExternalLink: vi.fn(async () => ({ ok: true })),
			// The adapter's rule (#653): release unless the error proves the page exists.
			releaseClaimForFailedWrite: vi.fn(async (linkId: string | null, error: unknown) => {
				if (linkId && !externalItemWasCreated(error)) released.push(linkId);
				return error;
			}),
			interruptedClaimMessage: vi.fn(() => "An earlier create is unfinished."),
		},
		artifacts: { insert: vi.fn(async (row: Record<string, unknown>) => row) },
		storage: {
			upload: vi.fn(async () => {}),
			remove: vi.fn(async () => {}),
			publicUrl: (bucket: string, path: string) => `https://storage.test/${bucket}/${path}`,
		},
		entities: { getById: vi.fn(async (): Promise<object | null> => null) },
		entityLinks: { upsert: vi.fn(async () => []) },
		storageBucket: "bucket",
	};
	const run = (args: Record<string, unknown>) =>
		runCreateTask(ports as unknown as CreateTaskPorts, { title: "Buy milk", ...args } as never, OWNER);
	return { ports, released, run };
}

describe("runCreateTask over core ports (#1662)", () => {
	it("refuses a call with no domain before any port is called (#820)", async () => {
		const { ports, run } = fakePorts();
		await expect(run({})).rejects.toThrow(
			"`domain` is required to create a task — 'work' (the Work workspace) or 'angus' (the personal one). There is no default",
		);
		for (const port of [ports.notion, ports.config, ports.links, ports.artifacts, ports.entities]) {
			for (const method of Object.values(port)) expect(method).not.toHaveBeenCalled();
		}
	});

	it("Tasks-DB guard: an open task with a matching title skips, records lineage and takes no claim", async () => {
		const { ports, run } = fakePorts();
		ports.notion.queryDataSource.mockResolvedValue({ results: [OPEN_TWIN], has_more: false });
		const out = await run({ domain: "work", artifact_id: ARTIFACT, single_task: true });
		expect(out).toMatchObject({ status: "skipped_duplicate", pageId: "page_0", deduplicated: true });
		expect(out.message).toBe(
			`${notionDuplicateText({ title: "Buy milk", page: OPEN_TWIN, pageUrl: OPEN_TWIN.url })}\nLinked to artifact ${ARTIFACT}`,
		);
		expect(ports.links.recordExternalLink).toHaveBeenCalledWith(
			ARTIFACT,
			expect.objectContaining({ provider: "notion_work", kind: "task", external_id: "page_0" }),
		);
		expect(ports.links.claimDedupSlot).not.toHaveBeenCalled();
		expect(ports.notion.createPage).not.toHaveBeenCalled();
	});

	it("Tasks-DB guard: a failed query adds the note and proceeds; skip_notion_dedup makes no query", async () => {
		const { ports, run } = fakePorts();
		ports.notion.queryDataSource.mockRejectedValue(new Error("notion is down"));
		const out = await run({ domain: "work", artifact_id: ARTIFACT });
		expect(out.status).toBe("created");
		expect(out.message).toContain(
			"\n(Tasks-DB duplicate guard could not run: notion is down - proceeded without it)",
		);
		ports.notion.queryDataSource.mockClear();
		expect((await run({ domain: "work", artifact_id: ARTIFACT, skip_notion_dedup: true })).status).toBe("created");
		expect(ports.notion.queryDataSource).not.toHaveBeenCalled();
	});

	it("ledger guard: linked skips, pending reports the unfinished claim, a lost claim race skips with the race note", async () => {
		const { ports, run } = fakePorts();
		const args = { domain: "work", artifact_id: ARTIFACT, single_task: true };
		const skipped = { artifactId: ARTIFACT, singleTask: true };
		ports.links.inspectDedupSlot.mockResolvedValueOnce("linked");
		expect(await run(args)).toMatchObject({ status: "skipped_duplicate", message: skippedDuplicateText(skipped) });
		ports.links.inspectDedupSlot.mockResolvedValueOnce("pending");
		expect(await run(args)).toMatchObject({
			status: "interrupted_claim",
			deduplicated: false,
			message: "An earlier create is unfinished.",
		});
		expect(ports.links.claimDedupSlot).not.toHaveBeenCalled();
		ports.links.claimDedupSlot.mockResolvedValueOnce({ claimed: false, reason: "conflict" });
		expect(await run(args)).toMatchObject({
			status: "skipped_duplicate",
			message: skippedDuplicateText({ ...skipped, raceLost: true }),
		});
		expect(ports.notion.createPage).not.toHaveBeenCalled();
	});

	it("a createPage failure releases the claim and rethrows; an unreadable success is not released on (#653)", async () => {
		const { ports, released, run } = fakePorts();
		const args = { domain: "work", artifact_id: ARTIFACT, single_task: true };
		const failure = new Error("socket hang up");
		ports.notion.createPage.mockRejectedValueOnce(failure);
		await expect(run(args)).rejects.toBe(failure);
		expect(released).toEqual(["claim_1"]);
		const unreadable = new ExternalItemCreatedButUnreadable("A Notion page", new Error("bad JSON"));
		ports.notion.createPage.mockRejectedValueOnce(unreadable);
		await expect(run(args)).rejects.toBe(unreadable);
		expect(released).toEqual(["claim_1"]);
		expect(ports.links.finalizeExternalLink).not.toHaveBeenCalled();
	});

	it("no artifact_id: one upload and one act_receipt task_request insert; a failed insert removes the object", async () => {
		const { ports, run } = fakePorts();
		const out = await run({ domain: "angus", source_text: "remind me to buy milk" });
		expect(ports.storage.upload).toHaveBeenCalledTimes(1);
		expect(ports.artifacts.insert).toHaveBeenCalledTimes(1);
		const row = ports.artifacts.insert.mock.calls[0][0];
		expect(row).toMatchObject({
			user_id: OWNER,
			surface: "act_receipt",
			content_subtype: "task_request",
			plain_text: "remind me to buy milk",
			storage_path: `notes/${OWNER}/${row.id}.md`,
			tags: ["account:personal"],
		});
		expect(out.message).toContain(
			`\nSource captured as artifact ${row.id} (content_subtype='task_request')\nLinked to artifact ${row.id}`,
		);

		ports.artifacts.insert.mockRejectedValueOnce(new Error("boom"));
		const degraded = await run({ domain: "angus" });
		expect(degraded.status).toBe("created");
		expect(degraded.message).toContain(
			"\n(could not capture task-request provenance: artifact insert failed: boom)",
		);
		expect(ports.storage.remove).toHaveBeenCalledTimes(1);
	});

	it("for_person_id: a non-people entity is rejected; a person gets the promise_to link", async () => {
		const { ports, run } = fakePorts();
		const args = { domain: "work", artifact_id: ARTIFACT, for_person_id: "ent-1" };
		ports.entities.getById.mockResolvedValueOnce({ id: "ent-1", entity_type: "organisation" });
		await expect(run(args)).rejects.toThrow(
			"Entity 'ent-1' is not a person (entity_type='organisation'); for_person_id requires entity_type='people'.",
		);
		expect(ports.notion.createPage).not.toHaveBeenCalled();
		ports.entities.getById.mockResolvedValueOnce({ id: "ent-1", entity_type: "people", properties: {} });
		const out = await run(args);
		expect(ports.entities.getById).toHaveBeenLastCalledWith("ent-1", OWNER);
		expect(ports.entityLinks.upsert).toHaveBeenCalledWith(
			[expect.objectContaining({ artifact_id: ARTIFACT, entity_id: "ent-1", link_type: "related", notes: "promise_to" })],
			{ userId: OWNER },
		);
		expect(out.message).toContain("\nLinked promise to person entity ent-1");
	});

	it("error texts read as dev's: adapter prefixes are stripped, a NotionApiError is reworded", async () => {
		const { ports, run } = fakePorts();
		const args = { domain: "work", artifact_id: ARTIFACT, for_person_id: "ent-1" };
		ports.entities.getById.mockRejectedValueOnce(new Error("Entities get failed: connection reset"));
		await expect(run(args)).rejects.toThrow("Failed to check person entity 'ent-1': connection reset");

		ports.entities.getById.mockResolvedValueOnce({ id: "ent-1", entity_type: "people", properties: {} });
		ports.entityLinks.upsert.mockRejectedValueOnce(
			new Error("Upsert artifact_entity_links failed: permission denied"),
		);
		const degraded = await run(args);
		expect(degraded.message).toContain("\n(could not record person promise link: permission denied)");

		const notionError = Object.assign(new Error("Notion API error (502): bad gateway"), {
			name: "NotionApiError",
			status: 502,
		});
		ports.notion.queryDataSource.mockRejectedValueOnce(notionError);
		const guarded = await run({ domain: "work", artifact_id: ARTIFACT });
		expect(guarded.message).toContain(
			"\n(Tasks-DB duplicate guard could not run: Notion data source query failed (502): bad gateway - proceeded without it)",
		);
	});

	it("formatMcp text for a created task is dev's, byte for byte", async () => {
		const { ports, run } = fakePorts();
		const out = await run({ domain: "work", artifact_id: ARTIFACT, notes: "2 litres" });
		expect(formatCreateTaskMcp(out)).toBe(
			`Created Notion task: Buy milk\nPage: ${PAGE.url}\nLinked to artifact ${ARTIFACT}`,
		);
		expect(ports.notion.createPage).toHaveBeenCalledWith({
			workspace: "work",
			databaseId: "db_tasks",
			properties: { Name: { title: [{ text: { content: "Buy milk" } }] } },
			children: [expect.objectContaining({ type: "paragraph" })],
		});
	});
});
