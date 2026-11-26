import { z } from "zod";
import { DOMAINS, DOMAIN_PROVIDER, type Domain } from "../../domain/domains.js";
import { DailyLogUnwiredError, resolveDailyLogPortTarget } from "../../domain/dailyLogTarget.js";
import type { ConfigRepository } from "../../ports/config.js";
import type { ExternalLinkRepository } from "../../ports/externalLinks.js";
import type { NotionDatabaseResponse, NotionPort } from "../../ports/notion.js";
import { defineAction } from "../defineAction.js";
import { markdownToBlocks, type BlockPayload } from "../notion/blocks.js";
import {
	assertPropertiesMatchSchema,
	requireDatabaseProperties,
	resolveTitleProperty,
	type NotionDatabaseSchema,
} from "../notion/schemaGuard.js";
import type { ActionDefinition } from "../types.js";
import { resolveOrCreateContact } from "./contactCreate.js";
import { externalAttendee, resolveAttendees } from "./meetingCreate.js";
import { ROLES, assertOption, findRole, resolveRole } from "./propertyRoles.js";
import { unwiredRecordTargetError } from "./recordTarget.js";

// create_communication (#422, #741).
//
// Closes the cap-time sink mechanic named in ADR-022 Erratum 1: Recent Communications
// becomes a pure projection over canonical stores (the Meetings database and the
// Investor CRM), written through via this tool.
//
// Routing rules (#422):
// - Work domain routes to the Work Meetings DB or Investor CRM per config/audience.
// - Angus domain routes to the personal Meeting Notes DB (or whatever its config names).
//
// Private-meeting rule (#741, ADR-053 §6 amendment):
// - The Daily Log body is the one permitted surface for a communication that arose
//   from a private meeting, in the `angus` domain only. Never the State Doc, never
//   the Team, Investor or Advisor projections, never the Work Meetings DB.
//   `create_communication` refuses a `source: private_meeting` write to any other
//   destination and says why.

const CHILDREN_PER_CALL = 100;

export const createCommunicationInput = {
	domain: z
		.enum(DOMAINS)
		.describe(
			"Which workspace: 'work' or 'angus'. Required, no default — each is a separate Notion integration.",
		),
	title: z.string().min(1).describe("Communication title or summary. Required and must not be blank."),
	date: z
		.string()
		.optional()
		.describe("Date (YYYY-MM-DD) or ISO datetime. Defaults to current date/time if omitted."),
	audience: z
		.string()
		.optional()
		.describe(
			"Audience register / spec, e.g. 'investor', 'team', 'advisor', 'bri', 'mitesh'. If 'investor', routes to Investor CRM; otherwise routes to Meetings DB.",
		),
	destination: z
		.enum(["meetings", "investor_crm", "daily_log"])
		.optional()
		.describe(
			"Explicit destination override ('meetings', 'investor_crm', or 'daily_log'). If omitted, routes automatically by audience ('investor' -> investor_crm, others -> meetings).",
		),
	source: z
		.string()
		.optional()
		.describe(
			"Source of the communication, e.g. 'private_meeting', 'meeting', 'email', 'slack'. Note: 'private_meeting' may ONLY be routed to the Daily Log body in the 'angus' domain (ADR-053 §6 amendment).",
		),
	body: z.string().optional().describe("Communication notes or body as Markdown."),
	artifact_id: z.string().uuid().optional().describe("Lineage: source atom id (recorded under kind='communication')."),
	single_communication: z
		.boolean()
		.optional()
		.describe(
			"Dedup: when true with artifact_id, skips creation if ANY kind='communication' link exists for this artifact in this workspace.",
		),
	dedup_key: z.string().min(1).optional().describe("Dedup: stable per-communication key for 1:N case."),
	type: z
		.string()
		.optional()
		.describe(
			"Communication / meeting type option, validated against schema if destination has a type role.",
		),
	attendees: z
		.array(z.string())
		.optional()
		.describe("Internal attendees as Notion user ids or exact display names."),
	external: z
		.array(externalAttendee)
		.optional()
		.describe("External attendees as existing contact page ids or contact objects."),
	source_url: z.string().optional().describe("Link to the calendar event, message, or thread."),
	date_property: z
		.string()
		.optional()
		.describe("Name the date property explicitly, for a destination with more than one."),
	properties: z
		.record(z.string(), z.unknown())
		.optional()
		.describe("Custom Notion properties matching destination schema."),
} as const;

export const createCommunicationSchema = z.object(createCommunicationInput);
export type CreateCommunicationCall = z.infer<typeof createCommunicationSchema>;

export interface CommunicationCreatePorts {
	notion: NotionPort;
	externalLinks: Pick<
		ExternalLinkRepository,
		| "inspectDedupSlot"
		| "claimDedupSlot"
		| "finalizeExternalLink"
		| "recordExternalLink"
		| "releaseClaimForFailedWrite"
		| "interruptedClaimMessage"
	>;
	config?: Pick<ConfigRepository, "loadConfigDetailed">;
}

export type CommunicationCreateOutput = {
	text: string;
	id?: string;
	url?: string;
	destination?: "meetings" | "investor_crm" | "daily_log";
	domain?: Domain;
	skipped?: boolean;
};

function toDatabaseSchema(raw: NotionDatabaseResponse["properties"] = {}): NotionDatabaseSchema {
	return {
		properties: Object.keys(raw).map((name) => {
			const p = raw[name];
			const type = p?.type ?? "unknown";
			const options = (p?.select ?? p?.multi_select ?? p?.status)?.options
				?.map((o) => o.name)
				.filter(Boolean);
			return { name, type, ...(options?.length ? { options } : {}) };
		}),
	};
}

async function runCommunicationCreate(
	args: CreateCommunicationCall,
	ports: CommunicationCreatePorts,
): Promise<CommunicationCreateOutput> {
	if (!args.domain) {
		throw new Error(
			"`domain` is required to create a communication \u2014 'work' (the Work workspace) or 'angus' (the personal one). There is no default: each domain resolves its own Notion token, and the workspaces have disjoint page access.",
		);
	}
	const domain = args.domain;

	const title = args.title.trim();
	if (!title) {
		throw new Error("`title` is required and must not be blank.");
	}

	let destination = args.destination;
	if (!destination) {
		if (args.source?.toLowerCase() === "private_meeting" && domain === "angus") {
			destination = "daily_log";
		} else if (args.audience?.toLowerCase() === "investor") {
			destination = "investor_crm";
		} else {
			destination = "meetings";
		}
	}

	// #741 / ADR-053 §6 amendment
	if (args.source?.toLowerCase() === "private_meeting") {
		if (domain !== "angus" || destination !== "daily_log") {
			throw new Error(
				"Communications from a private meeting may only be written to the Daily Log body in the 'angus' domain (ADR-053 §6 amendment). Never the State Doc, never the Team, Investor or Advisor projections, never the Work Meetings DB.",
			);
		}
	}

	const provider = DOMAIN_PROVIDER[domain];
	const dedupOn =
		Boolean(args.artifact_id) && (Boolean(args.single_communication) || Boolean(args.dedup_key));
	let claimedLinkId: string | null = null;

	if (dedupOn && args.artifact_id) {
		const slot = await ports.externalLinks.inspectDedupSlot(
			args.artifact_id,
			provider,
			"communication",
			args.dedup_key,
		);
		if (slot === "linked") {
			return {
				skipped: true,
				destination,
				domain,
				text: `Skipped duplicate communication: artifact '${args.artifact_id}' already has a communication link in '${provider}'.`,
			};
		}
		if (slot === "pending") {
			return {
				skipped: true,
				destination,
				domain,
				text: ports.externalLinks.interruptedClaimMessage({
					artifactId: args.artifact_id,
					provider,
					kind: "communication",
					dedupKey: args.dedup_key,
				}),
			};
		}

		const claim = await ports.externalLinks.claimDedupSlot(
			args.artifact_id,
			provider,
			"communication",
			args.dedup_key ?? null,
		);
		if (!claim.claimed) {
			if (claim.reason === "conflict") {
				return {
					skipped: true,
					destination,
					domain,
					text: `Skipped duplicate communication: conflicting claim for artifact '${args.artifact_id}' in '${provider}'.`,
				};
			}
			claimedLinkId = null;
		} else {
			claimedLinkId = claim.linkId;
		}
	}

	let pageId = "";
	let pageUrl: string | null = null;
	const notes: string[] = [];
	let isDailyLogAppend = false;

	try {
		if (destination === "daily_log") {
			const target = ports.notion.resolveDailyLogTarget
				? await ports.notion.resolveDailyLogTarget(domain)
				: ports.config
					? await resolveDailyLogPortTarget(domain, ports.config)
					: (() => {
							throw new DailyLogUnwiredError(domain, provider);
						})();
			const date = args.date
				? args.date.includes("T")
					? args.date.split("T")[0]
					: args.date
				: new Date().toISOString().split("T")[0];

			// The data source carries the properties under the current Notion API (#2285).
			const schema = toDatabaseSchema(
				await requireDatabaseProperties(ports.notion, {
					workspace: target.workspace,
					databaseId: target.databaseId,
					dataSourceId: target.dataSourceId,
				}),
			);
			const dateProp = schema.properties.find((p) => p.type === "date")?.name ?? "Date";

			let existingPageId: string | null = null;
			let existingPageUrl: string | null = null;

			if (target.dataSourceId) {
				try {
					const existing = await ports.notion.queryDataSource({
						workspace: target.workspace,
						dataSourceId: target.dataSourceId,
						filter: { property: dateProp, date: { equals: date } },
						pageSize: 1,
					});
					if (existing.results.length > 0) {
						existingPageId = existing.results[0].id;
						existingPageUrl = (existing.results[0] as { url?: string }).url ?? null;
					}
				} catch (err) {
					// Fall through to refusal below — but log it, so a persistent
					// misconfiguration (e.g. a renamed date property) is diagnosable.
					console.debug(
						`create_communication: Daily Log lookup for '${domain}' failed: ${
							err instanceof Error ? err.message : String(err)
						}`,
					);
				}
			}

			if (!existingPageId) {
				throw new Error(
					`no Daily Log entry for ${date} in '${domain}'; only the dos ritual creates Daily Log entries (#1139); run dos or pass a date that has an entry`,
				);
			}

			const headingBlock: BlockPayload = {
				object: "block",
				type: "heading_3",
				heading_3: {
					rich_text: [{ type: "text", text: { content: `Communication: ${title}` } }],
				},
			};
			const bodyBlocks = args.body ? markdownToBlocks(args.body) : [];
			const blocks = [headingBlock, ...bodyBlocks];

			isDailyLogAppend = true;
			pageId = existingPageId;
			pageUrl = existingPageUrl || `https://www.notion.so/${pageId.replace(/-/g, "")}`;
			for (let i = 0; i < blocks.length; i += CHILDREN_PER_CALL) {
				try {
					await ports.notion.appendBlockChildren({
						workspace: target.workspace,
						blockId: pageId,
						children: blocks.slice(i, i + CHILDREN_PER_CALL),
					});
				} catch (err) {
					// The Daily Log page already exists — an append failure here must not be
					// treated as a failed write (which would release the dedup claim for a
					// page that partially already has this content). Note it and move on,
					// mirroring the meetings/investor_crm branch below.
					notes.push(
						`The communication was appended to the Daily Log, but ${
							blocks.length - i
						} further block(s) of the body could not be written: ${
							err instanceof Error ? err.message : String(err)
						}`,
					);
					break;
				}
			}
		} else {
			// destination === "meetings" || destination === "investor_crm"
			if (!ports.notion.resolveRecordTarget) throw unwiredRecordTargetError(destination, domain);
			const target = await ports.notion.resolveRecordTarget(destination, domain);
			// The data source carries the properties under the current Notion API (#2285).
			const schema = toDatabaseSchema(
				await requireDatabaseProperties(ports.notion, {
					workspace: target.workspace,
					databaseId: target.databaseId,
					dataSourceId: target.dataSourceId,
				}),
			);

			const titleProperty = resolveTitleProperty(schema, target.databaseId);
			const dateProperty = resolveRole(schema, ROLES.meetingDate, target.databaseId, args.date_property);

			const dateVal = args.date ?? new Date().toISOString();
			const properties: Record<string, unknown> = {
				[titleProperty]: { title: [{ text: { content: title } }] },
				[dateProperty]: { date: { start: dateVal } },
			};

			if (args.type) {
				const typeProp = findRole(schema, ROLES.meetingType);
				if (typeProp) {
					assertOption(schema, typeProp, args.type, "type");
					properties[typeProp] = { select: { name: args.type } };
				}
			}

			if (args.attendees && args.attendees.length > 0) {
				const attendeesProp = findRole(schema, ROLES.attendees);
				if (attendeesProp) {
					const ids = await resolveAttendees(args.attendees, ports.notion, domain);
					properties[attendeesProp] = { people: ids.map((id) => ({ object: "user", id })) };
				}
			}

			if (args.external && args.external.length > 0) {
				const externalProp = findRole(schema, ROLES.external);
				if (externalProp) {
					const ids: string[] = [];
					for (const entry of args.external) {
						if (typeof entry === "string") {
							ids.push(entry);
							continue;
						}
						const contact = await resolveOrCreateContact(domain, entry, ports.notion);
						ids.push(contact.id);
						notes.push(
							contact.created
								? `Created contact '${contact.name}': ${contact.id}`
								: `Reused existing contact '${contact.name}': ${contact.id}`,
						);
					}
					properties[externalProp] = { relation: ids.map((id) => ({ id })) };
				}
			}

			if (args.source_url) {
				const sourceUrlProp = findRole(schema, ROLES.sourceUrl);
				if (sourceUrlProp) {
					properties[sourceUrlProp] = { url: args.source_url };
				}
			}

			if (args.properties) {
				assertPropertiesMatchSchema(args.properties, schema, {
					destination,
					reserved: {
						title: titleProperty,
						...(dateProperty ? { date: dateProperty } : {}),
					},
				});
				Object.assign(properties, args.properties);
			}

			const blocks: BlockPayload[] = args.body ? markdownToBlocks(args.body) : [];

			const page = await ports.notion.createPage({
				workspace: target.workspace,
				databaseId: target.databaseId,
				properties,
				children: blocks.slice(0, CHILDREN_PER_CALL),
			});
			pageId = page.id;
			pageUrl = page.url || `https://www.notion.so/${page.id.replace(/-/g, "")}`;

			const rest = blocks.slice(CHILDREN_PER_CALL);
			for (let i = 0; i < rest.length; i += CHILDREN_PER_CALL) {
				try {
					await ports.notion.appendBlockChildren({
						workspace: target.workspace,
						blockId: page.id,
						children: rest.slice(i, i + CHILDREN_PER_CALL),
					});
				} catch (err) {
					notes.push(
						`The communication exists, but ${rest.length - i} further block(s) of the body could not be appended: ${
							err instanceof Error ? err.message : String(err)
						}`,
					);
					break;
				}
			}
		}
	} catch (error) {
		if (!claimedLinkId) throw error;
		throw await ports.externalLinks.releaseClaimForFailedWrite(claimedLinkId, error);
	}

	if (claimedLinkId) {
		await ports.externalLinks.finalizeExternalLink(claimedLinkId, pageId, pageUrl);
	} else if (args.artifact_id) {
		await ports.externalLinks.recordExternalLink(args.artifact_id, {
			provider,
			kind: "communication",
			external_id: pageId,
			external_url: pageUrl,
			dedup_key: args.dedup_key ?? null,
		});
	}

	const headerText = isDailyLogAppend
		? `Appended communication '${title}' to Daily Log in '${domain}': ${pageId}`
		: `Created communication '${title}' in '${domain}' (${destination}): ${pageId}`;
	const resolvedUrl = pageUrl || `https://www.notion.so/${pageId.replace(/-/g, "")}`;

	return {
		id: pageId,
		url: resolvedUrl,
		destination,
		domain,
		text: [headerText, resolvedUrl, ...notes].join("\n"),
	};
}

export function createCommunicationCreateAction(
	ports: CommunicationCreatePorts,
): ActionDefinition<typeof createCommunicationSchema, CommunicationCreateOutput> {
	return defineAction({
		id: "communication_create",
		description:
			"Create or file a communication in the appropriate destination per domain and audience register " +
			"(Meetings database or Investor CRM; Daily Log body for private meetings in the 'angus' domain). " +
			"Mirrors task_create with lineage (artifact_id, kind='communication') and dedup guards (single_communication, dedup_key). " +
			"Refuses a private_meeting write to any public destination (ADR-053 §6 amendment).",
		schema: createCommunicationSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		formatMcp: (out) => out.text,
		run: (args) => runCommunicationCreate(args, ports),
	});
}
