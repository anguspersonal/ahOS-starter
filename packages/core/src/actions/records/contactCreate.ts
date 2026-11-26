import { z } from "zod";
import { DOMAINS, type Domain } from "../../domain/domains.js";
import type { ActionDefinition } from "../types.js";
import { defineAction } from "../defineAction.js";
import type { NotionPort, NotionResolvedRecordTarget } from "../../ports/notion.js";
import {
	requireDatabaseProperties,
	resolveTitleProperty,
	type NotionDatabaseSchema,
} from "../notion/schemaGuard.js";
import { ROLES, assertOption, findRole, resolveRole } from "./propertyRoles.js";
import { unwiredRecordTargetError } from "./recordTarget.js";

let defaultContactPort: NotionPort | undefined;
const requirePort = (port = defaultContactPort): NotionPort => {
	if (!port) throw new Error("NotionPort is required for contact_create.");
	return port;
};

// contact_create (#1059). A contact is the record most likely to be created twice: it
// is created as a side effect of filing something else (a meeting's external attendees),
// by whichever surface happens to be filing, and nobody checks first.
//
// So dedup is the feature, not a safeguard bolted on. The tool is declared
// `idempotentHint: true` and means it: calling it twice with the same email returns the
// same page and writes nothing the second time. Notion has no unique constraint and no
// upsert, so "already exists" has to be a query this tool makes, before the create.
//
// Email first, exact name second. Email because it is the identifier people actually
// collide on; name second because plenty of contacts have no email, and an exact name
// match is better than a guaranteed duplicate. Fuzzy matching is deliberately absent —
// merging two real people because their names are similar is worse than one duplicate,
// and it is not reversible by the person who notices.

export const contactCreateInput = {
	domain: z
		.enum(DOMAINS)
		.describe(
			"Which workspace: 'work' (Contacts) or 'angus' (People). Required, no default — each is a separate Notion integration.",
		),
	name: z.string().describe("The contact's full name. Used as the page title, and as the dedup key when no email is given."),
	email: z
		.string()
		.optional()
		.describe("Email address. The primary dedup key: an existing contact with this email is returned rather than duplicated."),
	company: z.string().optional().describe("Company or organisation."),
	role: z.string().optional().describe("Job title or role."),
	contact_type: z
		.string()
		.optional()
		.describe(
			"Validated against the destination's own options before anything is written — read them with notion_database_get. Required by the Work Contacts database.",
		),
} as const;

const contactCreateSchema = z.object(contactCreateInput);
export type ContactCreateCall = z.infer<typeof contactCreateSchema>;

export type ResolvedContact = { id: string; url: string; created: boolean; name: string };

/** Read one property's plain text off a queried page, for comparing titles. */
function plainText(value: unknown): string {
	if (!value || typeof value !== "object") return "";
	const v = value as Record<string, unknown>;
	for (const key of ["title", "rich_text"]) {
		const runs = v[key];
		if (Array.isArray(runs)) {
			return runs
				.map((r) => (r && typeof r === "object" ? ((r as { plain_text?: string }).plain_text ?? "") : ""))
				.join("")
				.trim();
		}
	}
	if (typeof v.email === "string") return v.email.trim();
	return "";
}

/**
 * An existing contact matching email (preferred) or exact name, or null.
 *
 * The email query is a real Notion filter; the name check reads a page of rows and
 * compares titles here. That asymmetry is intentional: Notion's `title` filter is a
 * `contains`-style match on rich text, so asking it for an exact name would return
 * "Angus Hally Jr" for "Angus Hally" and silently return the wrong person's page.
 */
export async function findExistingContact(
	target: NotionResolvedRecordTarget,
	schema: NotionDatabaseSchema,
	args: { name: string; email?: string },
	port = defaultContactPort,
): Promise<{ id: string; url: string; name: string } | null> {
	const activePort = requirePort(port);
	const titleProperty = resolveTitleProperty(schema, target.databaseId);
	const emailProperty = findRole(schema, ROLES.email);

	if (args.email && emailProperty) {
		const hit = await activePort.queryDataSource({
			workspace: target.workspace,
			dataSourceId: target.dataSourceId,
			pageSize: 2,
			filter: { property: emailProperty, email: { equals: args.email } },
		});
		const page = hit.results.find((p) => !p.archived);
		if (page) {
			return {
				id: page.id,
				url: `https://www.notion.so/${page.id.replace(/-/g, "")}`,
				name: plainText(page.properties?.[titleProperty]) || args.name,
			};
		}
	}

	const wanted = args.name.trim().toLowerCase();
	let cursor: string | undefined;
	// Bounded: three pages. An unbounded scan of a CRM to avoid one duplicate is a worse
	// trade than the duplicate, and the email path is the one that actually carries.
	for (let page = 0; page < 3; page++) {
		const batch = await activePort.queryDataSource({
			workspace: target.workspace,
			dataSourceId: target.dataSourceId,
			pageSize: 100,
			cursor,
		});
		for (const row of batch.results) {
			if (row.archived) continue;
			const title = plainText(row.properties?.[titleProperty]);
			if (title.toLowerCase() === wanted) {
				return {
					id: row.id,
					url: `https://www.notion.so/${row.id.replace(/-/g, "")}`,
					name: title,
				};
			}
		}
		if (!batch.has_more || !batch.next_cursor) break;
		cursor = batch.next_cursor;
	}

	return null;
}

/** The shared body, so meeting_create can resolve its external attendees the same way. */
export async function resolveOrCreateContact(
	domain: Domain,
	args: Omit<ContactCreateCall, "domain">,
	port = defaultContactPort,
): Promise<ResolvedContact> {
	const activePort = requirePort(port);
	if (!activePort.resolveRecordTarget) throw unwiredRecordTargetError("contacts", domain);
	const target = await activePort.resolveRecordTarget("contacts", domain);
	// The data source carries the properties under the current Notion API (#2285).
	const raw = await requireDatabaseProperties(activePort, {
		workspace: target.workspace,
		databaseId: target.databaseId,
		dataSourceId: target.dataSourceId,
	});
	const schema: NotionDatabaseSchema = {
		properties: Object.keys(raw).map((name) => {
			const p = raw[name];
			const type = p?.type ?? "unknown";
			const options = (p?.select ?? p?.multi_select ?? p?.status)?.options?.map((o) => o.name).filter(Boolean);
			return { name, type, ...(options?.length ? { options } : {}) };
		}),
	};
	const titleProperty = resolveTitleProperty(schema, target.databaseId);

	const name = args.name.trim();
	if (!name) throw new Error("`name` is required and must not be blank.");

	const existing = await findExistingContact(target, schema, { name, email: args.email }, activePort);
	if (existing) return { ...existing, created: false };

	const properties: Record<string, unknown> = {
		[titleProperty]: { title: [{ text: { content: name } }] },
	};

	// Each of these throws rather than dropping when the caller supplied a value the
	// database cannot hold — see notionPropertyRoles.ts.
	if (args.email) {
		properties[resolveRole(schema, ROLES.email, target.databaseId)] = { email: args.email };
	}
	if (args.contact_type) {
		const property = resolveRole(schema, ROLES.contactType, target.databaseId);
		assertOption(schema, property, args.contact_type, "contact_type");
		properties[property] = { select: { name: args.contact_type } };
	}
	for (const [value, role, argument] of [
		[args.company, ROLES.company, "company"],
		[args.role, ROLES.contactRole, "role"],
	] as const) {
		if (!value) continue;
		const property = resolveRole(schema, role, target.databaseId);
		const declared = schema.properties.find((p) => p.name === property);
		if (declared?.type === "select") {
			assertOption(schema, property, value, argument);
			properties[property] = { select: { name: value } };
		} else if (declared?.type === "relation") {
			throw new Error(
				`'${property}' is a relation on this database, so \`${argument}\` cannot be set from a plain string — it needs the id of a page in the related database. Create or find that page first, then set the property with notion_page_create or notion_page_update.`,
			);
		} else {
			properties[property] = { rich_text: [{ text: { content: value } }] };
		}
	}

	const page = await activePort.createPage({ workspace: target.workspace, databaseId: target.databaseId, properties });
	return {
		id: page.id,
		url: page.url || `https://www.notion.so/${page.id.replace(/-/g, "")}`,
		created: true,
		name,
	};
}

export type ContactCreateOutput = ResolvedContact & { domain: Domain };

export function createContactCreateAction(
	port: NotionPort,
): ActionDefinition<typeof contactCreateSchema, ContactCreateOutput> {
	if (!("__unavailable__" in (port as object))) defaultContactPort = port;
	return defineAction({
		id: "contact_create",
		description:
			"Create a contact in either workspace, or return the existing one. Deduplicates on email first and exact name second, so calling it twice writes once — which is what makes it safe for meeting_create to call per external attendee.",
		schema: contactCreateSchema,
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		formatMcp: (c) =>
			[
				c.created
					? `Created contact '${c.name}' in '${c.domain}': ${c.id}`
					: `Contact '${c.name}' already exists in '${c.domain}' — returning it, nothing was written: ${c.id}`,
				c.url,
			].join("\n"),
		async run(args) {
			if (!args.domain) {
				throw new Error(
					"`domain` is required to create a contact — 'work' (the Work workspace) or 'angus' (the personal one). There is no default: each domain resolves its own Notion token, and the workspaces have disjoint page access.",
				);
			}
			return { ...(await resolveOrCreateContact(args.domain, args, port)), domain: args.domain };
		},
	});
}
