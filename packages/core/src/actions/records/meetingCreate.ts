import { z } from "zod";
import { DOMAINS, type Domain } from "../../domain/domains.js";
import type { ActionDefinition } from "../types.js";
import { defineAction } from "../defineAction.js";
import type { NotionPort, NotionUser } from "../../ports/notion.js";
import { markdownToBlocks, type BlockPayload } from "../notion/blocks.js";
import {
	requireDatabaseProperties,
	resolveTitleProperty,
	type NotionDatabaseSchema,
} from "../notion/schemaGuard.js";
import { resolveOrCreateContact } from "./contactCreate.js";
import { ROLES, assertOption, resolveRole } from "./propertyRoles.js";
import { unwiredRecordTargetError } from "./recordTarget.js";

let defaultMeetingPort: NotionPort | undefined;
const requirePort = (port = defaultMeetingPort): NotionPort => {
	if (!port) throw new Error("NotionPort is required for meeting_create.");
	return port;
};

// meeting_create (#1059, #1469). The opinionated half of the Notion surface: notion_page_create
// can already write this row, but only if the caller knows that the datetime property is
// called "Event time", that Type's options are a fixed vocabulary, that internal
// attendees are workspace user ids while external ones are relations to Contacts, and
// that a contact has to exist before it can be related to.

const CHILDREN_PER_CALL = 100;

export const externalAttendee = z.union([
	z.string().describe("An existing contact page id."),
	z.object({
		name: z.string(),
		email: z.string().optional(),
		company: z.string().optional(),
		role: z.string().optional(),
		contact_type: z.string().optional(),
	}),
]);

export const meetingCreateInput = {
	domain: z
		.enum(DOMAINS)
		.describe(
			"Which workspace: 'work' (Meetings) or 'angus' (Meeting Notes). Required, no default — each is a separate Notion integration.",
		),
	title: z.string().describe("Meeting title. Sentence case, descriptive and concise."),
	start: z
		.string()
		.describe(
			"Start as an ISO 8601 datetime, e.g. 2026-09-15T10:15:00+01:00. Include the offset; a bare date loses the time.",
		),
	end: z.string().optional().describe("End as an ISO 8601 datetime. Written as the date property's end."),
	type: z
		.string()
		.optional()
		.describe(
			"Validated against the destination's own Type options before anything is written — read them with notion_database_get rather than guessing.",
		),
	attendees: z
		.array(z.string())
		.optional()
		.describe(
			"Internal attendees, as Notion user ids or exact display names. Names are resolved against the workspace's user list; an unknown or ambiguous name is an error, never a dropped attendee.",
		),
	external: z
		.array(externalAttendee)
		.optional()
		.describe(
			'External attendees, as existing contact page ids or objects like {"name":"Ada Lovelace","email":"ada@example.com"}. Objects are resolved through the same dedup as contact_create, so an existing contact is reused rather than duplicated.',
		),
	body: z.string().optional().describe("Meeting notes as Markdown — headings, bullets, paragraphs."),
	source_url: z.string().optional().describe("Link to the calendar event or call."),
	date_property: z
		.string()
		.optional()
		.describe("Name the date property explicitly, for a database with more than one."),
} as const;

export const meetingCreateSchema = z.object(meetingCreateInput);
export type MeetingCreateCall = z.infer<typeof meetingCreateSchema>;

export type MeetingCreateOutput = {
	id: string;
	url: string;
	title: string;
	domain: Domain;
	notes: string[];
};

/**
 * Internal attendees as Notion user ids.
 *
 * A name that matches nothing, or matches two people, is an ERROR rather than a skipped
 * attendee. Notion accepts a `people` array containing only the ids it recognises, so
 * the alternative is a meeting that reports success with the wrong people on it.
 */
export async function resolveAttendees(
	names: string[],
	portOrToken: NotionPort | string | undefined,
	domain: Domain,
	port = defaultMeetingPort,
): Promise<string[]> {
	// A 36-character dashed uuid is an id already; anything else needs looking up.
	const looksLikeId = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
	if (names.every(looksLikeId)) return names;

	const activePort =
		typeof portOrToken === "object" && portOrToken !== null
			? portOrToken
			: requirePort(port);

	let users: NotionUser[] = [];
	try {
		users = await activePort.listUsers({ workspace: domain });
	} catch (err) {
		throw new Error(
			`Could not read the '${domain}' workspace's user list to resolve attendee names: ${
				err instanceof Error ? err.message : String(err)
			}. Pass Notion user ids directly, or use notion_user_list to find them.`,
		);
	}

	return names.map((given) => {
		if (looksLikeId(given)) return given;
		const wanted = given.trim().toLowerCase();
		const matches = users.filter(
			(u) => u.name.toLowerCase() === wanted || (u.email && u.email.toLowerCase() === wanted),
		);
		if (matches.length === 1) return matches[0].id;
		const people = users.filter((u) => u.type !== "bot").map((u) => u.name);
		throw new Error(
			matches.length === 0
				? `No user named '${given}' in the '${domain}' workspace, so the meeting was not created. Known people: ${people.join(", ") || "(none visible)"}.`
				: `'${given}' matches ${matches.length} users in the '${domain}' workspace. Pass the id instead — notion_user_list prints them.`,
		);
	});
}

export function createMeetingCreateAction(
	port: NotionPort,
): ActionDefinition<typeof meetingCreateSchema, MeetingCreateOutput> {
	if (!("__unavailable__" in (port as object))) defaultMeetingPort = port;
	return defineAction({
		id: "meeting_create",
		description:
			"File a meeting in either workspace with its time, type, internal attendees and external contacts. Every convention is checked against the live database schema first: an unknown Type option, an unresolvable attendee name, or a value the database has nowhere to put all fail before anything is written.",
		schema: meetingCreateSchema,
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		formatMcp: (m) =>
			[
				`Created meeting '${m.title}' in '${m.domain}': ${m.id}`,
				m.url || `https://www.notion.so/${m.id.replace(/-/g, "")}`,
				...m.notes,
			].join("\n"),
		async run(args) {
			if (!args.domain) {
				throw new Error(
					"`domain` is required to create a meeting — 'work' (the Work workspace) or 'angus' (the personal one). There is no default: each domain resolves its own Notion token, and the workspaces have disjoint page access.",
				);
			}
			const domain = args.domain;
			if (!port.resolveRecordTarget) throw unwiredRecordTargetError("meetings", domain);
			const target = await port.resolveRecordTarget("meetings", domain);
			// The data source carries the properties under the current Notion API (#2285).
			const raw = await requireDatabaseProperties(port, {
				workspace: target.workspace,
				databaseId: target.databaseId,
				dataSourceId: target.dataSourceId,
			});
			const schema: NotionDatabaseSchema = {
				properties: Object.keys(raw).map((name) => {
					const p = raw[name];
					const type = p?.type ?? "unknown";
					const options = (p?.select ?? p?.multi_select ?? p?.status)?.options
						?.map((o) => o.name)
						.filter(Boolean);
					return { name, type, ...(options?.length ? { options } : {}) };
				}),
			};

			const title = args.title.trim();
			if (!title) throw new Error("`title` is required and must not be blank.");
			if (!args.start.trim()) {
				throw new Error("`start` is required — a meeting with no time cannot be found by date.");
			}

			const titleProperty = resolveTitleProperty(schema, target.databaseId);
			const dateProperty = resolveRole(schema, ROLES.meetingDate, target.databaseId, args.date_property);

			const properties: Record<string, unknown> = {
				[titleProperty]: { title: [{ text: { content: title } }] },
				[dateProperty]: { date: { start: args.start, ...(args.end ? { end: args.end } : {}) } },
			};

			if (args.type) {
				const property = resolveRole(schema, ROLES.meetingType, target.databaseId);
				assertOption(schema, property, args.type, "type");
				properties[property] = { select: { name: args.type } };
			}

			if (args.attendees && args.attendees.length > 0) {
				const property = resolveRole(schema, ROLES.attendees, target.databaseId);
				const ids = await resolveAttendees(args.attendees, port, domain);
				properties[property] = { people: ids.map((id) => ({ object: "user", id })) };
			}

			if (args.source_url) {
				properties[resolveRole(schema, ROLES.sourceUrl, target.databaseId)] = { url: args.source_url };
			}

			const notes: string[] = [];
			if (args.external && args.external.length > 0) {
				const property = resolveRole(schema, ROLES.external, target.databaseId);
				const ids: string[] = [];
				for (const entry of args.external) {
					if (typeof entry === "string") {
						ids.push(entry);
						continue;
					}
					const contact = await resolveOrCreateContact(domain, entry, port);
					ids.push(contact.id);
					notes.push(
						contact.created
							? `Created contact '${contact.name}': ${contact.id}`
							: `Reused existing contact '${contact.name}': ${contact.id}`,
					);
				}
				properties[property] = { relation: ids.map((id) => ({ id })) };
			}

			const blocks: BlockPayload[] = args.body ? markdownToBlocks(args.body) : [];

			const page = await port.createPage({
				workspace: target.workspace,
				databaseId: target.databaseId,
				properties,
				children: blocks.slice(0, CHILDREN_PER_CALL),
			});

			const rest = blocks.slice(CHILDREN_PER_CALL);
			for (let i = 0; i < rest.length; i += CHILDREN_PER_CALL) {
				try {
					await port.appendBlockChildren({
						workspace: target.workspace,
						blockId: page.id,
						children: rest.slice(i, i + CHILDREN_PER_CALL),
					});
				} catch (err) {
					notes.push(
						`The meeting exists, but ${rest.length - i} further block(s) of the body could not be appended: ${
							err instanceof Error ? err.message : String(err)
						}`,
					);
					break;
				}
			}

			return {
				id: page.id,
				url: page.url || `https://www.notion.so/${page.id.replace(/-/g, "")}`,
				title,
				domain,
				notes,
			};
		},
	});
}
