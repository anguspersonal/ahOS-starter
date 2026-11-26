import { z } from "zod";
import { DOMAINS, type Domain } from "../../domain/domains.js";
import type { ActionContext, ActionDefinition } from "../types.js";
import { defineAction } from "../defineAction.js";
import type { NotionApiError, NotionPort, NotionUser } from "../../ports/notion.js";

const DOMAIN_PROVIDER: Record<Domain, string> = { work: "notion_work", angus: "notion_personal" };

function requireDomain(domain: Domain | undefined, doing: string): Domain {
	if (!domain) {
		throw new Error(
			`\`domain\` is required to ${doing} — 'work' (the Work workspace) or 'angus' (the personal one). There is no default: each domain resolves its own Notion token, and the workspaces have disjoint page access.`,
		);
	}
	return domain;
}

function isNotionNotFound(err: unknown): boolean {
	return err instanceof Error && err.name === "NotionApiError" && (err as NotionApiError).status === 404;
}

function crossWorkspaceHint(domain: Domain): string {
	const other = DOMAINS.find((d) => d !== domain);
	return `Not found in the '${domain}' workspace (provider '${DOMAIN_PROVIDER[domain]}'). The two workspaces have disjoint page access — if this page lives in the other one, retry with domain='${other}'.`;
}

export const notionUserListInput = {
	domain: z.enum(DOMAINS).describe(
		"Which workspace: 'work' (work) or 'angus' (personal). Required, no default — each is a separate Notion integration with its own members.",
	),
} as const;

export const notionUserListInputSchema = z.object(notionUserListInput);
export type NotionUserListCall = z.infer<typeof notionUserListInputSchema>;
export type NotionUserListInput = NotionUserListCall;

export const notionUserItemSchema = z.object({ id: z.string(), name: z.string(), type: z.string(), email: z.string().optional() });
export type NotionUserItem = z.infer<typeof notionUserItemSchema>;

export const notionUserListOutputSchema = z.object({
	domain: z.enum(DOMAINS),
	users: z.array(notionUserItemSchema),
	count: z.number(),
});
export type NotionUserListOutput = z.infer<typeof notionUserListOutputSchema>;

export function formatNotionUserListMcp(result: NotionUserListOutput): string {
	if (result.users.length === 0) {
		return `No users visible in the '${result.domain}' workspace. An integration sees members only where it has been granted access.`;
	}
	return [
		`Notion users (${result.domain}), ${result.users.length} total:`,
		...result.users.map((u) => `  ${u.name} — ${u.type}${u.email ? ` <${u.email}>` : ""} — ${u.id}`),
	].join("\n");
}

export function createNotionUserListAction(
	port: NotionPort,
): ActionDefinition<typeof notionUserListInputSchema, NotionUserListOutput> {
	return defineAction({
		id: "notion_user_list",
		name: "notion_user_list",
		description:
			"List the people and bots in one Notion workspace with their ids, for filling a person-typed property. Read these rather than reusing an id from a skill body: a stale id assigns real work to nobody, and says nothing when it does.",
		domain: "integrations",
		schema: notionUserListInputSchema,
		outputSchema: notionUserListOutputSchema,
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		formatMcp: formatNotionUserListMcp,
		async run(input: NotionUserListInput, _context: ActionContext): Promise<NotionUserListOutput> {
			const domain = requireDomain(input.domain, "list Notion users");
			let users: NotionUser[];
			try {
				users = await port.listUsers({ workspace: domain });
			} catch (err) {
				if (isNotionNotFound(err)) {
					throw new Error(`${err instanceof Error ? err.message : String(err)}\n${crossWorkspaceHint(domain)}`);
				}
				throw err;
			}
			const ordered = [...users].sort((a, b) =>
				(a.type === "bot") !== (b.type === "bot") ? (a.type === "bot" ? 1 : -1) : a.name.localeCompare(b.name),
			);
			return { domain, users: ordered, count: ordered.length };
		},
	});
}
