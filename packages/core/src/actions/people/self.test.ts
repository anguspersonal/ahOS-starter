import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { executeAction } from "../adapters/direct.js";
import type { ActionContext } from "../types.js";
import type { PeopleSelfRepository, SelfEntityRow } from "../../ports/people.js";
import { createFakeSupabase } from "../../adapters/fakeSupabase.testkit.js";
import {
	createSupabasePeopleRepository,
	SELF_PREFS_MIGRATION_HINT,
	type PeopleSupabaseClient,
} from "../../adapters/supabase/people.js";
import { createPersonSelfAction, formatPersonSelfMcp, PERSON_SELF_DESCRIPTION } from "./self.js";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const SELF_ID = "11111111-1111-4111-8111-111111111111";
const CTX: ActionContext = { caller: "mcp", requestId: "req-person-self-1", userId: USER_ID };

const PERSON_SELF_JSON_SCHEMA_SNAPSHOT = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	type: "object",
	properties: {
		display_name: {
			description: "Owner's display name; seeds identity + names a newly-created self entity.",
			type: "string",
			minLength: 1,
		},
		emails: {
			description: "Owner's email addresses, used to match references to the owner (dedupe-by-email).",
			type: "array",
			items: { type: "string" },
		},
	},
	additionalProperties: false,
};

function makeFakeSelfRepo(overrides: Partial<PeopleSelfRepository> = {}): PeopleSelfRepository {
	return {
		readSelfPreferences: vi.fn(async () => ({ self_entity_id: null, identity: {}, exists: false })),
		writeSelfPreferences: vi.fn(async () => undefined),
		findSelfEntityById: vi.fn(async () => null),
		findSelfEntityByFlag: vi.fn(async () => null),
		findSelfEntityByEmail: vi.fn(async () => null),
		findSelfEntityByName: vi.fn(async () => null),
		createSelfEntity: vi.fn(async (e) => ({ id: e.id, title: e.title, properties: e.properties })),
		markSelfEntity: vi.fn(async () => undefined),
		...overrides,
	};
}

describe("person_self core action (#1512)", () => {
	it("1. contract parity: id, JSON schema snapshot, verbatim description, annotations, and default exposure", () => {
		const action = createPersonSelfAction(makeFakeSelfRepo());
		expect(action.id).toBe("person_self");
		expect(z.toJSONSchema(action.schema)).toEqual(PERSON_SELF_JSON_SCHEMA_SNAPSHOT);
		expect(action.description).toBe(PERSON_SELF_DESCRIPTION);
		expect(action.description).toBe(
			"Resolve (or create) the owner's 'self' entity \u2014 the single people entity that represents the user in the graph (ADR-024). Returns its id, which is the endpoint for owner-relationships (e.g. self -[engaged_to]-> someone). Optionally seed the owner's display name + emails on first call so references to the owner can be deduped. Idempotent; caches the pointer in user_preferences.",
		);
		expect(action.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
		expect(action.expose).toEqual({ mcp: true, http: true, ui_agent: true, worker: true, cli: false, a2a: false });
	});

	it("2. resolution order: cached pointer -> properties.is_self -> identity email -> display name -> create", async () => {
		const hitRow: SelfEntityRow = { id: SELF_ID, title: "Angus", properties: {} };

		const repoPointer = makeFakeSelfRepo({
			readSelfPreferences: vi.fn(async () => ({ self_entity_id: SELF_ID, identity: {}, exists: true })),
			findSelfEntityById: vi.fn(async () => hitRow),
		});
		expect(formatPersonSelfMcp(await executeAction(createPersonSelfAction(repoPointer), {}, { context: CTX }))).toContain("resolved via cached pointer");
		expect(repoPointer.findSelfEntityByFlag).not.toHaveBeenCalled();
		expect(repoPointer.markSelfEntity).toHaveBeenCalledWith(hitRow, USER_ID);

		const repoFlag = makeFakeSelfRepo({
			readSelfPreferences: vi.fn(async () => ({ self_entity_id: "99999999-9999-4999-8999-999999999999", identity: {}, exists: true })),
			findSelfEntityByFlag: vi.fn(async () => hitRow),
		});
		expect(formatPersonSelfMcp(await executeAction(createPersonSelfAction(repoFlag), {}, { context: CTX }))).toContain("resolved via properties.is_self");
		expect(repoFlag.findSelfEntityByEmail).not.toHaveBeenCalled();

		const repoEmail = makeFakeSelfRepo({ findSelfEntityByEmail: vi.fn(async () => hitRow) });
		expect(formatPersonSelfMcp(await executeAction(createPersonSelfAction(repoEmail), { emails: ["Owner@Example.com"], display_name: "Angus" }, { context: CTX }))).toContain("resolved via identity email");
		expect(repoEmail.findSelfEntityByName).not.toHaveBeenCalled();

		const repoName = makeFakeSelfRepo({ findSelfEntityByName: vi.fn(async () => hitRow) });
		expect(formatPersonSelfMcp(await executeAction(createPersonSelfAction(repoName), { display_name: "Angus" }, { context: CTX }))).toContain("resolved via display name");
		expect(repoName.createSelfEntity).not.toHaveBeenCalled();
	});

	it("3 & 4. create + prefs writeback: stamps is_self, scalar email, UUID, 'Me' fallback, and writes deduplicated lower-cased emails once", async () => {
		const mintedId = "22222222-2222-4222-8222-222222222222";
		const uuidSpy = vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(mintedId);
		const repo = makeFakeSelfRepo({
			readSelfPreferences: vi.fn(async () => ({ self_entity_id: null, identity: { emails: ["owner@old.example"] }, exists: true })),
		});

		const res = await executeAction(
			createPersonSelfAction(repo),
			{ display_name: "Angus Hally", emails: ["OWNER@OLD.EXAMPLE", "Owner@New.Example", "owner@new.example"] },
			{ context: CTX },
		);
		uuidSpy.mockRestore();

		expect(repo.createSelfEntity).toHaveBeenCalledWith(
			{ id: mintedId, title: "Angus Hally", properties: { is_self: true, emails: ["owner@old.example", "owner@new.example"], email: "owner@old.example" } },
			USER_ID,
		);
		expect(repo.writeSelfPreferences).toHaveBeenCalledTimes(1);
		expect(repo.writeSelfPreferences).toHaveBeenCalledWith(
			true,
			mintedId,
			{ display_name: "Angus Hally", emails: ["owner@old.example", "owner@new.example"] },
			USER_ID,
		);
		expect(formatPersonSelfMcp(res)).toBe(
			`Self entity ${mintedId} ("Angus Hally") \u2014 created. Use this id as the endpoint for owner-relationships (e.g. self -[engaged_to]-> \u2026).`,
		);

		const repoDefault = makeFakeSelfRepo();
		const resDefault = await executeAction(createPersonSelfAction(repoDefault), {}, { context: CTX });
		expect(resDefault.title).toBe("Me");
	});

	it("5. missing-column error on user_preferences carries migration 053 hint", async () => {
		const fake = createFakeSupabase(() => ({
			data: null,
			error: { code: "42703", message: "column user_preferences.self_entity_id does not exist" },
		}));
		const repo = createSupabasePeopleRepository({ client: fake.client as unknown as PeopleSupabaseClient, ownerId: USER_ID });
		await expect(executeAction(createPersonSelfAction(repo), {}, { context: CTX })).rejects.toThrow(SELF_PREFS_MIGRATION_HINT);
	});
});
