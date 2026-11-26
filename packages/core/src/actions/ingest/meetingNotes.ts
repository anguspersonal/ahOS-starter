import { z } from "zod";
import { ARTIFACT_SURFACES, slugify } from "../../domain/artifacts.js";
import { optionalDomainInput } from "../../domain/domainInput.js";
import { reconcileDomain, type Domain } from "../../domain/domains.js";
import { matchMeetingNoteEmail } from "../../domain/ingest/meetingNoteEmails.js";
import { originationFor } from "../../domain/ingest/discoverPointers.js";
import { DRIVE_CONNECTOR_BY_ACCOUNT } from "../../domain/ingest/selection.js";
import { MEETING_NOTE_CONTENT_SUBTYPE } from "../../domain/vocab.js";
import type {
	ArtifactRepository,
	CapturePort,
	CaptureResult,
} from "../../ports/artifacts.js";
import type { ConfigRepository } from "../../ports/config.js";
import { formatFile, isFolder, type DrivePort } from "../../ports/drive.js";
import type { EntityRepository, LinkRepository } from "../../ports/entities.js";
import {
	LABEL_INBOX,
	LABEL_UNREAD,
	parseMessage,
	type GmailPort,
} from "../../ports/gmail.js";
import type { StoragePort } from "../../ports/storage.js";
import { executeAction } from "../adapters/direct.js";
import {
	DEFAULT_GOOGLE_ACCOUNT,
	googleAccountInput,
	type GoogleAccount,
} from "../appsscript/account.js";
import { createCaptureAction } from "../artifacts/capture.js";
import { defineAction } from "../defineAction.js";
import type { captureSchema } from "../domain/capture.js";
import { FOLDER_PATH_FIELDS, IMPORT_FILE_FIELDS } from "../drive/importFile.js";
import type { DriveArtifactLookup } from "../drive/ingest.js";
import type { ActionDefinition } from "../types.js";

export const meetingNotesIngestInput = {
	message_id: z
		.string()
		.min(1)
		.describe(
			"Gmail message id to process — the [id] ingest_meeting_notes_detect reported for this meeting-note email.",
		),
	doc_id: z
		.string()
		.optional()
		.describe(
			"Override the Google Doc id to ingest, when the message's own body has none, more than one, or the wrong one. Defaults to the first doc URL matched in the message.",
		),
	label_name: z
		.string()
		.optional()
		.describe(
			"Gmail label marking a processed meeting note (default 'meeting_note', matching scripts/meeting-notes-setup.ts). Doubles as the idempotency check: a message that already carries it is reported and left untouched — nothing is re-captured, re-labelled or re-moved.",
		),
	target_folder_id: z
		.string()
		.optional()
		.describe(
			"Drive folder id to file the doc under once captured. Omit to skip the move step (find or create one with scripts/meeting-notes-setup.ts).",
		),
	account: googleAccountInput,
	domain: optionalDomainInput,
} as const;

export const meetingNotesIngestSchema = z.object(meetingNotesIngestInput);
export type MeetingNotesIngestInput = z.infer<typeof meetingNotesIngestSchema>;

export const INGEST_MEETING_NOTES_DESCRIPTION =
	"Chain a detected meeting-note email into one captured atom: fetch its Google Doc, or fall back " +
	"to the email body, capture it, and link it to the meeting's event entity. No Notion write, no " +
	"State Doc, no synthesis — this produces the atom and nothing else. Full notes: " +
	"docs/guides/tools/ingest_meeting_notes.md";

const DOC_URL_ID = /\/document\/d\/([A-Za-z0-9_-]{20,})/;

export function docIdFromUrl(url: string): string | null {
	const m = DOC_URL_ID.exec(url);
	return m ? m[1] : null;
}

/** Every email address in one or more RFC 5322 address-list header values. */
export function extractEmails(...headerValues: string[]): string[] {
	const seen = new Set<string>();
	for (const value of headerValues) {
		for (const m of value.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+/g)) {
			seen.add(m[0].toLowerCase());
		}
	}
	return [...seen];
}

/** Gmail's `Date` header (RFC 2822) as a bare `YYYY-MM-DD`, or null if unparseable. */
export function dateOnly(headerDate: string): string | null {
	const parsed = new Date(headerDate);
	if (Number.isNaN(parsed.getTime())) return null;
	return parsed.toISOString().slice(0, 10);
}

export interface IngestMeetingNotesAtom {
	artifactId: string;
	artifactTitle: string;
	docId: string | null;
}

export type IngestMeetingNotesOutput =
	| {
			status: "already_processed";
			messageId: string;
			subject: string;
			labelName: string;
	  }
	| {
			status: "unmatched";
			messageId: string;
			subject: string;
			from: string;
	  }
	| {
			status: "ingested";
			title: string;
			date: string | null;
			atoms: IngestMeetingNotesAtom[];
			eventId: string;
			eventCreated: boolean;
			notes: string[];
	  };

export interface IngestMeetingNotesPorts {
	gmail: Pick<GmailPort, "getMessage" | "ensureLabel" | "modifyLabels">;
	drive: Pick<DrivePort, "getFile" | "downloadFile" | "updateFile">;
	config: Pick<ConfigRepository, "meetingNoteSources">;
	entities: Pick<EntityRepository, "findByExactTitle" | "insert">;
	links: Pick<LinkRepository, "upsert">;
	artifacts: Pick<ArtifactRepository, "insert">;
	storage: Pick<StoragePort, "upload" | "remove" | "publicUrl">;
	capture: CapturePort | ActionDefinition<typeof captureSchema, CaptureResult>;
	findArtifactByDriveFileId?: (fileId: string) => Promise<DriveArtifactLookup | null>;
	ownerId?: string | (() => string | undefined);
	storageBucket?: string | (() => string);
	embedArtifact?: (
		id: string,
		fields: {
			title?: string;
			description?: string;
			plain_text?: string;
		},
	) => Promise<unknown>;
}

function isTextual(mimeType: string): boolean {
	return (
		mimeType.startsWith("text/") ||
		mimeType === "application/json" ||
		mimeType === "application/xml"
	);
}

function deriveExtension(name: string, exported: string | null): string | null {
	if (exported) return exported;
	const dot = name.lastIndexOf(".");
	if (dot > 0 && dot < name.length - 1) return name.slice(dot + 1).toLowerCase();
	return null;
}

async function loadFolderPath(
	drive: Pick<DrivePort, "getFile">,
	domain: Domain,
	folderId: string,
): Promise<{ ids: string[]; path: string | null }> {
	const ids: string[] = [];
	const names: string[] = [];
	let currentId = folderId;

	for (let depth = 0; depth < 20; depth += 1) {
		const meta = await drive.getFile({
			domain,
			fileId: currentId,
			fields: FOLDER_PATH_FIELDS,
		});
		if (!isFolder(meta.mimeType)) break;

		const id = meta.id ?? currentId;
		ids.unshift(id);
		names.unshift(meta.name ?? id);

		const parentId = meta.parents?.[0];
		if (!parentId || parentId === "root" || parentId === currentId) break;
		currentId = parentId;
	}

	return { ids, path: names.length ? names.join(" / ") : null };
}

async function resolveEventEntity(
	entities: Pick<EntityRepository, "findByExactTitle" | "insert">,
	opts: {
		title: string;
		date: string | null;
		attendees: string[];
		userId?: string;
	},
): Promise<{ id: string; created: boolean }> {
	if (!entities.findByExactTitle) {
		throw new Error("EntityRepository.findByExactTitle is not wired");
	}
	// The title is matched in the query. `loadRows({ query })` is a substring search
	// over a recent-rows window cut to `limit`, so it can drop the real event (#2294).
	const rows = await entities.findByExactTitle(
		{ entity_type: "event", title: opts.title },
		opts.userId,
	);
	// Same key as the unique index on entities: lower(trim(title)).
	const titleKey = opts.title.trim().toLowerCase();
	const exactRows = rows.filter((row) => (row.title ?? "").trim().toLowerCase() === titleKey);
	const match = opts.date
		? exactRows.find((row) => (row.properties as { date?: string } | null)?.date === opts.date)
		: exactRows[0];
	if (match) return { id: match.id, created: false };

	const created = await entities.insert(
		[
			{
				entity_type: "event",
				title: opts.title,
				properties: {
					...(opts.date ? { date: opts.date } : {}),
					...(opts.attendees.length ? { attendees: opts.attendees } : {}),
				},
				tags: [],
			},
		],
		opts.userId,
	);
	if (!created[0]) {
		throw new Error("Event entity creation failed: no row returned");
	}
	return { id: created[0].id, created: true };
}

export function formatIngestMeetingNotesMcp(out: IngestMeetingNotesOutput): string {
	if (out.status === "already_processed") {
		return `Already processed: message ${out.messageId} ("${out.subject}") already carries the '${out.labelName}' label. No changes made.`;
	}
	if (out.status === "unmatched") {
		return `Message ${out.messageId} (subject: "${out.subject}", from: ${out.from}) does not match any configured meeting-note rule. Refusing to process — run ingest_meeting_notes_detect first to confirm this is a meeting-note email, or check user_preferences.meeting_note_sources.`;
	}

	return [
		`Meeting: ${out.title}${out.date ? ` (${out.date})` : ""}`,
		...out.atoms.map(
			(a, i) =>
				`${out.atoms.length === 1 ? "Artifact" : `Artifact ${i + 1}/${out.atoms.length}`}: ${a.artifactId} — ${a.artifactTitle}`,
		),
		`Event entity: ${out.eventId}`,
		"",
		...out.notes,
	].join("\n");
}

export function createIngestMeetingNotesAction(
	ports: IngestMeetingNotesPorts,
): ActionDefinition<typeof meetingNotesIngestSchema, IngestMeetingNotesOutput> {
	const captureAction =
		"run" in ports.capture ? ports.capture : createCaptureAction(ports.capture);

	return defineAction({
		id: "ingest_meeting_notes",
		domain: "integrations",
		description: INGEST_MEETING_NOTES_DESCRIPTION,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		schema: meetingNotesIngestSchema,
		formatMcp: formatIngestMeetingNotesMcp,
		async run(args, ctx): Promise<IngestMeetingNotesOutput> {
			const domain: Domain =
				reconcileDomain(args.domain, args.account, "account") ?? "angus";
			const account: GoogleAccount =
				domain === "work" ? "work" : DEFAULT_GOOGLE_ACCOUNT;
			const labelName = args.label_name ?? "meeting_note";
			const notes: string[] = [];

			const raw = await ports.gmail.getMessage({ domain, messageId: args.message_id });
			const message = parseMessage(raw);

			// Idempotency (issue #873 "Re-runnable"): the label IS the processed marker for
			// this message. Checked before any write, so a repeated call on an already-done
			// message is a pure read.
			const { label } = await ports.gmail.ensureLabel({ domain, name: labelName });
			if (message.labelIds.includes(label.id)) {
				return {
					status: "already_processed",
					messageId: args.message_id,
					subject: message.subject,
					labelName,
				};
			}

			if (!ports.config.meetingNoteSources) {
				throw new Error("ConfigRepository.meetingNoteSources is not wired");
			}
			const { sources } = await ports.config.meetingNoteSources(ctx?.userId);
			const match = matchMeetingNoteEmail(message, sources);
			if (!match) {
				return {
					status: "unmatched",
					messageId: args.message_id,
					subject: message.subject,
					from: message.from,
				};
			}

			const title = match.meeting_title ?? (message.subject || "(untitled meeting)");
			const date = dateOnly(message.date);
			const attendees = extractEmails(message.from, message.to);
			const docIds = args.doc_id
				? [args.doc_id]
				: [
						...new Set(
							match.doc_urls
								.map(docIdFromUrl)
								.filter((id): id is string => id !== null),
						),
					];

			const userId =
				(ctx?.userId || undefined) ??
				(typeof ports.ownerId === "function" ? ports.ownerId() : ports.ownerId) ??
				"";
			const bucket =
				(typeof ports.storageBucket === "function"
					? ports.storageBucket()
					: ports.storageBucket) ?? "user-uploads";

			const atoms: IngestMeetingNotesAtom[] = [];

			for (const docId of docIds) {
				if (ports.findArtifactByDriveFileId) {
					const existing = await ports.findArtifactByDriveFileId(docId);
					if (existing) {
						atoms.push({
							artifactId: existing.id,
							artifactTitle: existing.title ?? title,
							docId,
						});
						notes.push(
							`Doc ${docId} already captured as artifact ${existing.id} — linking it rather than re-capturing.`,
						);
						continue;
					}
				}

				try {
					const meta = await ports.drive.getFile({
						domain,
						fileId: docId,
						fields: IMPORT_FILE_FIELDS,
					});
					const driveName = meta.name ?? "drive-file";
					const driveMime = meta.mimeType ?? "";
					const driveFileId = meta.id ?? docId;
					const parents = meta.parents ?? [];

					if (isFolder(driveMime)) {
						throw new Error(
							`${docId} is a folder — import individual files instead.`,
						);
					}

					const parentPath = parents[0]
						? (await loadFolderPath(ports.drive, domain, parents[0])).path
						: null;

					const {
						bytes,
						mimeType,
						extension: exportedExt,
					} = await ports.drive.downloadFile({
						domain,
						fileId: docId,
						mimeType: driveMime,
					});

					const id = globalThis.crypto.randomUUID();
					const ext = deriveExtension(driveName, exportedExt);
					const storagePath = `drive-imports/${userId}/${id}${ext ? `.${ext}` : ""}`;
					const storageUrl = ports.storage.publicUrl(bucket, storagePath);
					const artifactTitle = docIds.length === 1 ? title : driveName;
					const filename = `${slugify(artifactTitle)}-${id.slice(0, 8)}${ext ? `.${ext}` : ""}`;
					const sourceUrl =
						meta.webViewLink ?? `https://drive.google.com/file/d/${docId}`;

					try {
						await ports.storage.upload(bucket, storagePath, bytes, {
							contentType: mimeType,
						});
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						throw new Error(`Storage upload failed: ${msg}`);
					}

					const originatedAt = originationFor(DRIVE_CONNECTOR_BY_ACCOUNT[account], {
						source_created_at: meta.createdTime ?? undefined,
						source_modified_at: meta.modifiedTime ?? undefined,
					});

					const textual = isTextual(mimeType);
					const plainText = textual ? new TextDecoder("utf-8").decode(bytes) : null;
					const processingStatus = textual ? "completed" : "pending";

					let inserted: { id: string; title: string };
					try {
						inserted = await ports.artifacts.insert({
							id,
							user_id: userId,
							storage_bucket: bucket,
							storage_path: storagePath,
							storage_url: storageUrl,
							filename,
							original_file_name: driveName,
							file_type: mimeType,
							content_type: mimeType,
							file_extension: ext,
							file_size: bytes.byteLength,
							artifact_type: "original",
							captured_at: new Date().toISOString(),
							...(originatedAt ? { originated_at: originatedAt } : {}),
							source: sourceUrl,
							source_url: sourceUrl,
							source_drive_file_id: driveFileId,
							source_parent_folder_ids: parents,
							source_parent_folder_path: parentPath,
							source_channel: "google_drive",
							surface: ARTIFACT_SURFACES.driveImport,
							lifecycle_stage: "uploaded",
							processing_status: processingStatus,
							title: artifactTitle,
							plain_text: plainText,
							tags: [],
							content_subtype: MEETING_NOTE_CONTENT_SUBTYPE,
						});
					} catch (err) {
						try {
							await ports.storage.remove(bucket, [storagePath]);
						} catch (removeErr) {
							void removeErr;
						}
						const msg = err instanceof Error ? err.message : String(err);
						throw new Error(`Insert failed: ${msg}`);
					}

					const resolvedTitle = inserted.title ?? artifactTitle;

					if (textual && ports.embedArtifact) {
						await ports.embedArtifact(inserted.id, {
							title: resolvedTitle,
							plain_text: plainText ?? undefined,
						});
					}

					atoms.push({
						artifactId: inserted.id,
						artifactTitle: resolvedTitle,
						docId,
					});
					notes.push(`Captured doc ${docId} as artifact ${inserted.id}.`);
				} catch (error) {
					notes.push(
						`Could not fetch doc ${docId} (${error instanceof Error ? error.message : String(error)}).`,
					);
				}
			}

			if (atoms.length === 0) {
				notes.push(
					docIds.length === 0
						? "No Google Doc link found in the message — capturing the email body instead."
						: "No doc could be fetched — falling back to the email body.",
				);
				if (!message.body.trim()) {
					throw new Error(
						`Nothing usable to capture: no Drive doc and an empty email body for "${message.subject}". Stopping rather than capturing an empty shell.`,
					);
				}
				const captured = await executeAction(
					captureAction,
					{
						text: message.body,
						title,
						content_subtype: MEETING_NOTE_CONTENT_SUBTYPE,
					},
					{ context: { caller: "internal", userId: ctx?.userId } },
				);
				atoms.push({
					artifactId: captured.id,
					artifactTitle: captured.title,
					docId: null,
				});
			}

			const event = await resolveEventEntity(ports.entities, {
				title,
				date,
				attendees,
				userId: ctx?.userId,
			});
			if (!ports.links.upsert) {
				throw new Error("LinkRepository.upsert is not wired");
			}
			for (const atom of atoms) {
				await ports.links.upsert(
					[
						{
							artifact_id: atom.artifactId,
							entity_id: event.id,
							link_type: "primary",
							created_by: "ingest_meeting_notes",
						},
					],
					{ userId: ctx?.userId },
				);
			}
			const linkedIds = atoms.map((a) => a.artifactId).join(", ");
			const plural = atoms.length === 1 ? "artifact" : `${atoms.length} artifacts`;
			notes.push(
				event.created
					? `Created event entity ${event.id} ("${title}"${date ? `, ${date}` : ""}) and linked ${plural} ${linkedIds} to it (link_type='primary').`
					: `Linked ${plural} ${linkedIds} to existing event entity ${event.id} ("${title}") as additional sources.`,
			);

			await ports.gmail.modifyLabels({
				domain,
				target: { kind: "message", id: args.message_id },
				addLabelIds: [label.id],
				removeLabelIds: [LABEL_UNREAD, LABEL_INBOX],
			});
			notes.push(`Labelled '${labelName}', marked read, archived.`);

			const capturedDocIds = atoms
				.map((a) => a.docId)
				.filter((id): id is string => id !== null);
			if (capturedDocIds.length && args.target_folder_id) {
				for (const docId of capturedDocIds) {
					const current = await ports.drive.getFile({
						domain,
						fileId: docId,
						fields: "id, name, parents",
					});
					const parents = current.parents ?? [];
					if (parents.includes(args.target_folder_id)) {
						notes.push(`Doc ${docId} already filed in the target folder.`);
						continue;
					}
					const moved = await ports.drive.updateFile({
						domain,
						fileId: docId,
						addParents: args.target_folder_id,
						removeParents: parents.join(",") || undefined,
						fields: "id, name, mimeType, parents",
					});
					notes.push(`Moved doc:\n${formatFile(moved)}`);
				}
			} else if (capturedDocIds.length) {
				notes.push(
					capturedDocIds.length === 1
						? "No target_folder_id given — doc left in place."
						: `No target_folder_id given — ${capturedDocIds.length} docs left in place.`,
				);
			}

			return {
				status: "ingested",
				title,
				date,
				atoms,
				eventId: event.id,
				eventCreated: event.created,
				notes,
			};
		},
	});
}
