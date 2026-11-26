import { describe, expect, it, vi } from "vitest";
import { createNotionUserListAction } from "./userList.js";
import type { NotionPort, NotionUser } from "../../ports/notion.js";

const ctx = { caller: "test", requestId: "r1" };
const fakePort = (users: NotionUser[] | (() => Promise<NotionUser[]>) = []): NotionPort =>
	({ listUsers: vi.fn(typeof users === "function" ? users : async () => users) }) as unknown as NotionPort;

describe("notion_user_list", () => {
	it("lists people sorted by name before bots, byte-identical to dev", async () => {
		const action = createNotionUserListAction(
			fakePort([
				{ id: "bot-1", name: "ahKMS", type: "bot" },
				{ id: "user-2", name: "Briana", type: "person", email: "briana@example.com" },
				{ id: "user-1", name: "Angus", type: "person", email: "owner@example.com" },
			]),
		);
		const out = await action.run({ domain: "work" }, ctx);
		expect(out.count).toBe(3);
		expect(out.users.map((u) => u.id)).toEqual(["user-1", "user-2", "bot-1"]);
		expect(action.formatMcp!(out)).toBe(
			"Notion users (work), 3 total:\n  Angus — person <owner@example.com> — user-1\n  Briana — person <briana@example.com> — user-2\n  ahKMS — bot — bot-1",
		);
	});

	it("explains an empty list rather than implying the workspace is empty", async () => {
		const action = createNotionUserListAction(fakePort([]));
		const out = await action.run({ domain: "angus" }, ctx);
		expect(action.formatMcp!(out)).toBe(
			"No users visible in the 'angus' workspace. An integration sees members only where it has been granted access.",
		);
	});

	it("requires domain and adds the cross-workspace hint on a 404 NotionApiError", async () => {
		const notFound = Object.assign(new Error("Notion API error (404): Could not find users"), { name: "NotionApiError" as const, status: 404 });
		const action = createNotionUserListAction(fakePort(async () => { throw notFound; }));
		await expect(action.run({} as any, ctx)).rejects.toThrow(/`domain` is required to list Notion users/);
		await expect(action.run({ domain: "work" }, ctx)).rejects.toThrow(/retry with domain='angus'/);
	});
});
