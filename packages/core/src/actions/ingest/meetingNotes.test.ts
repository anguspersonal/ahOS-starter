import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DEFAULT_MEETING_NOTE_SOURCES } from "../../domain/ingest/meetingNoteEmails.js";
import type { EntityRow } from "../../ports/entities.js";
import type { GmailMessage } from "../../ports/gmail.js";
import { executeAction } from "../adapters/direct.js";
import {
	createIngestMeetingNotesAction,
	dateOnly,
	docIdFromUrl,
	extractEmails,
	formatIngestMeetingNotesMcp,
	type IngestMeetingNotesPorts,
} from "./meetingNotes.js";

const LEGACY_SCHEMA_SNAPSHOT = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	type: "object",
	properties: {
		message_id: {
			type: "string",
			minLength: 1,
			description:
				"Gmail message id to process — the [id] ingest_meeting_notes_detect reported for this meeting-note email.",
		},
		doc_id: {
			description:
				"Override the Google Doc id to ingest, when the message's own body has none, more than one, or the wrong one. Defaults to the first doc URL matched in the message.",
			type: "string",
		},
		label_name: {
			description:
				"Gmail label marking a processed meeting note (default 'meeting_note', matching scripts/meeting-notes-setup.ts). Doubles as the idempotency check: a message that already carries it is reported and left untouched — nothing is re-captured, re-labelled or re-moved.",
			type: "string",
		},
		target_folder_id: {
			description:
				"Drive folder id to file the doc under once captured. Omit to skip the move step (find or create one with scripts/meeting-notes-setup.ts).",
			type: "string",
		},
		account: {
			description:
				"Deprecated, use `domain` ('work' | 'angus'; 'angus' is this parameter's 'personal'). Which Google account to act as: personal | work.",
			type: "string",
			enum: ["personal", "work"],
		},
		domain: {
			description:
				"Which domain to act in: 'work' (the Work company workspace and account) or 'angus' (the personal one).",
			type: "string",
			enum: ["work", "angus"],
		},
	},
	required: ["message_id"],
	additionalProperties: false,
};

function encodeB64Url(s: string): string {
	return Buffer.from(s, "utf8")
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function makeMessage(opts: {
	id?: string;
	from?: string;
	to?: string;
	subject?: string;
	date?: string;
	labelIds?: string[];
	body?: string;
}): GmailMessage {
	return {
		id: opts.id ?? "msg-1",
		threadId: "thr-1",
		labelIds: opts.labelIds ?? ["INBOX", "UNREAD"],
		payload: {
			headers: [
				{ name: "From", value: opts.from ?? "Gemini Notes <gemini-notes@example.com>" },
				{ name: "To", value: opts.to ?? "Angus Hally <owner@example.com>" },
				{ name: "Subject", value: opts.subject ?? 'Notes: "Weekly Sync"' },
				{ name: "Date", value: opts.date ?? "Mon, 24 Aug 2026 10:00:00 +0000" },
			],
			mimeType: "text/plain",
			body: { data: encodeB64Url(opts.body ?? "") },
		},
	};
}

function makePorts(overrides: Partial<IngestMeetingNotesPorts> = {}) {
	let artifactCounter = 0;
	const ports: IngestMeetingNotesPorts = {
		gmail: {
			getMessage: vi.fn(async () =>
				makeMessage({
					body: "See https://docs.google.com/document/d/docId12345678901234567890/edit",
				}),
			),
			ensureLabel: vi.fn(async () => ({
				label: { id: "lbl-meeting", name: "meeting_note" },
				created: false,
			})),
			modifyLabels: vi.fn(async () => ({ id: "msg-1", labelIds: ["lbl-meeting"] })),
		},
		drive: {
			getFile: vi.fn(async ({ fileId }) => ({
				id: fileId,
				name: `Doc ${fileId}`,
				mimeType: "application/vnd.google-apps.document",
				parents: ["parent-1"],
				webViewLink: `https://docs.google.com/document/d/${fileId}`,
			})),
			downloadFile: vi.fn(async () => ({
				bytes: new TextEncoder().encode("# Meeting Notes\n\nDiscussed roadmap."),
				mimeType: "text/markdown",
				extension: "md",
			})),
			updateFile: vi.fn(async ({ fileId, addParents }) => ({
				id: fileId,
				name: `Doc ${fileId}`,
				mimeType: "application/vnd.google-apps.document",
				parents: addParents ? [addParents] : [],
			})),
		},
		config: {
			meetingNoteSources: vi.fn(async () => ({
				sources: DEFAULT_MEETING_NOTE_SOURCES,
				origin: "default" as const,
			})),
		},
		entities: {
			findByExactTitle: vi.fn(async () => []),
			insert: vi.fn(async (items) => [
				{
					id: "event-1",
					title: items[0].title,
					entity_type: items[0].entity_type,
					description: null,
					properties: items[0].properties ?? {},
					tags: items[0].tags ?? [],
					archived: false,
					archived_at: null,
					source_url: null,
					user_id: "owner-1",
					team_id: null,
					created_at: "2026-08-24T10:00:00Z",
					updated_at: "2026-08-24T10:00:00Z",
				},
			]),
		},
		links: {
			upsert: vi.fn(async (links) =>
				links.map((l, idx) => ({
					id: `link-${idx + 1}`,
					artifact_id: l.artifact_id,
					entity_id: l.entity_id,
					link_type: l.link_type ?? "primary",
				})),
			),
		},
		artifacts: {
			insert: vi.fn(async (row) => {
				artifactCounter += 1;
				return {
					id: row.id || `art-${artifactCounter}`,
					title: row.title,
					created_at: "2026-08-24T10:00:00Z",
				};
			}),
		},
		storage: {
			upload: vi.fn(async () => undefined),
			remove: vi.fn(async () => undefined),
			publicUrl: vi.fn((bucket, path) => `https://storage.example/${bucket}/${path}`),
		},
		capture: {
			capture: vi.fn(async (input) => ({
				id: "art-body-1",
				title: input.title ?? "Email body",
				tags: [],
				source_channel: "mcp",
				storage_bucket: "user-uploads",
				storage_path: "captures/art-body-1.md",
				captured_at: "2026-08-24T10:00:00Z",
				captured_at_declared: false,
				deduplicated: false,
			})),
		},
		findArtifactByDriveFileId: vi.fn(async () => null),
		ownerId: "owner-1",
		storageBucket: "user-uploads",
		embedArtifact: vi.fn(async () => "stored"),
		...overrides,
	};
	return ports;
}

describe("pure helpers", () => {
	it("docIdFromUrl extracts id from canonical Google Docs URL and returns null otherwise", () => {
		expect(docIdFromUrl("https://docs.google.com/document/d/abcDEF123456789012345/")).toBe(
			"abcDEF123456789012345",
		);
		expect(docIdFromUrl("https://example.com/whatever")).toBeNull();
	});

	it("extractEmails deduplicates and lowercases addresses", () => {
		expect(
			extractEmails(
				"Gemini Notes <gemini-notes@example.com>",
				"Angus Hally <owner@example.com>, team@work.example.com, owner@example.com",
			),
		).toEqual(["gemini-notes@example.com", "owner@example.com", "team@work.example.com"]);
		expect(extractEmails("no addresses here")).toEqual([]);
	});

	it("dateOnly reduces RFC 2822 Date header to YYYY-MM-DD", () => {
		expect(dateOnly("Mon, 24 Aug 2026 10:00:00 +0000")).toBe("2026-08-24");
		expect(dateOnly("not a date")).toBeNull();
	});
});

describe("ingest_meeting_notes action (#1541)", () => {
	it("case 1: contract parity — id, schema JSON snapshot, verbatim description, and annotations", () => {
		const action = createIngestMeetingNotesAction(makePorts());
		expect(action.id).toBe("ingest_meeting_notes");
		expect(z.toJSONSchema(action.schema)).toEqual(LEGACY_SCHEMA_SNAPSHOT);
		expect(action.description).toBe(
			"Chain a detected meeting-note email into one captured atom: fetch its Google Doc, or fall back " +
				"to the email body, capture it, and link it to the meeting's event entity. No Notion write, no " +
				"State Doc, no synthesis — this produces the atom and nothing else. Full notes: " +
				"docs/guides/tools/ingest_meeting_notes.md",
		);
		expect(action.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		});
	});

	it("case 2: message already carrying the label returns Already processed and makes no write", async () => {
		const ports = makePorts({
			gmail: {
				getMessage: vi.fn(async () =>
					makeMessage({
						labelIds: ["INBOX", "lbl-meeting"],
					}),
				),
				ensureLabel: vi.fn(async () => ({
					label: { id: "lbl-meeting", name: "meeting_note" },
					created: false,
				})),
				modifyLabels: vi.fn(),
			},
		});
		const action = createIngestMeetingNotesAction(ports);
		const out = await executeAction(
			action,
			{ message_id: "msg-1" },
			{ context: { caller: "mcp", userId: "owner-1" } },
		);

		expect(out.status).toBe("already_processed");
		expect(formatIngestMeetingNotesMcp(out)).toContain(
			'Already processed: message msg-1 ("Notes: "Weekly Sync"") already carries the \'meeting_note\' label. No changes made.',
		);
		expect(ports.artifacts.insert).not.toHaveBeenCalled();
		expect(ports.entities.insert).not.toHaveBeenCalled();
		expect(ports.links.upsert).not.toHaveBeenCalled();
		expect(ports.gmail.modifyLabels).not.toHaveBeenCalled();
		expect(ports.drive.updateFile).not.toHaveBeenCalled();
	});

	it("case 3: message matching no rule is refused with today's text and nothing is written", async () => {
		const ports = makePorts({
			gmail: {
				getMessage: vi.fn(async () =>
					makeMessage({
						from: "someone@example.com",
						subject: "Random email",
					}),
				),
				ensureLabel: vi.fn(async () => ({
					label: { id: "lbl-meeting", name: "meeting_note" },
					created: false,
				})),
				modifyLabels: vi.fn(),
			},
		});
		const action = createIngestMeetingNotesAction(ports);
		const out = await executeAction(
			action,
			{ message_id: "msg-1" },
			{ context: { caller: "mcp", userId: "owner-1" } },
		);

		expect(out.status).toBe("unmatched");
		expect(formatIngestMeetingNotesMcp(out)).toBe(
			'Message msg-1 (subject: "Random email", from: someone@example.com) does not match any configured meeting-note rule. Refusing to process — run ingest_meeting_notes_detect first to confirm this is a meeting-note email, or check user_preferences.meeting_note_sources.',
		);
		expect(ports.artifacts.insert).not.toHaveBeenCalled();
		expect(ports.entities.insert).not.toHaveBeenCalled();
		expect(ports.links.upsert).not.toHaveBeenCalled();
		expect(ports.gmail.modifyLabels).not.toHaveBeenCalled();
	});

	it("case 4: two doc URLs produce two atoms on one event entity; already-captured doc is linked without re-capture", async () => {
		const doc1 = "docOne12345678901234567";
		const doc2 = "docTwo12345678901234567";
		const ports = makePorts({
			gmail: {
				getMessage: vi.fn(async () =>
					makeMessage({
						body: `Team: https://docs.google.com/document/d/${doc1}/edit\nPersonal: https://docs.google.com/document/d/${doc2}/edit`,
					}),
				),
				ensureLabel: vi.fn(async () => ({
					label: { id: "lbl-meeting", name: "meeting_note" },
					created: false,
				})),
				modifyLabels: vi.fn(async () => ({ id: "msg-1", labelIds: ["lbl-meeting"] })),
			},
			findArtifactByDriveFileId: vi.fn(async (fileId) =>
				fileId === doc1
					? {
							id: "existing-art-1",
							title: "Existing Team Notes",
							storage_bucket: "user-uploads",
							storage_path: "drive-imports/existing.md",
							processing_status: "completed",
							source_url: `https://docs.google.com/document/d/${doc1}`,
							source_parent_folder_ids: ["parent-1"],
							source_parent_folder_path: "Notes",
						}
					: null,
			),
		});

		const action = createIngestMeetingNotesAction(ports);
		const out = await executeAction(
			action,
			{ message_id: "msg-1" },
			{ context: { caller: "mcp", userId: "owner-1" } },
		);

		expect(out.status).toBe("ingested");
		if (out.status !== "ingested") throw new Error("expected ingested");
		expect(out.atoms).toHaveLength(2);
		expect(out.atoms[0]).toMatchObject({
			artifactId: "existing-art-1",
			artifactTitle: "Existing Team Notes",
			docId: doc1,
		});
		expect(out.atoms[1].docId).toBe(doc2);

		expect(ports.drive.downloadFile).toHaveBeenCalledTimes(1);
		expect(ports.artifacts.insert).toHaveBeenCalledTimes(1);
		expect(ports.entities.findByExactTitle).toHaveBeenCalledTimes(1);
		expect(ports.entities.findByExactTitle).toHaveBeenCalledWith(
			{ entity_type: "event", title: out.title },
			"owner-1",
		);
		expect(ports.entities.insert).toHaveBeenCalledTimes(1);
		expect(ports.links.upsert).toHaveBeenCalledTimes(2);
		// #2295: the caller names only the key and created_by, so a re-link of the
		// already-captured artifact cannot carry notes or confidence_score.
		for (const [links] of vi.mocked(ports.links.upsert).mock.calls) {
			expect(links).toHaveLength(1);
			expect(links[0]).toMatchObject({ link_type: "primary", created_by: "ingest_meeting_notes" });
			expect(links[0]).not.toHaveProperty("notes");
			expect(links[0]).not.toHaveProperty("confidence_score");
		}

		const text = formatIngestMeetingNotesMcp(out);
		expect(text).toContain(`Doc ${doc1} already captured as artifact existing-art-1`);
		expect(text).toContain("Artifact 1/2: existing-art-1 — Existing Team Notes");
		expect(text).toContain(`Artifact 2/2: ${out.atoms[1].artifactId}`);
		expect(text).toContain("Event entity: event-1");
	});

	it("case 5: no doc and an empty body refuses with 'Nothing usable to capture ...'", async () => {
		const ports = makePorts({
			gmail: {
				getMessage: vi.fn(async () => makeMessage({ body: "   \n  " })),
				ensureLabel: vi.fn(async () => ({
					label: { id: "lbl-meeting", name: "meeting_note" },
					created: false,
				})),
				modifyLabels: vi.fn(),
			},
		});
		const action = createIngestMeetingNotesAction(ports);

		await expect(
			executeAction(
				action,
				{ message_id: "msg-1" },
				{ context: { caller: "mcp", userId: "owner-1" } },
			),
		).rejects.toThrow(/Nothing usable to capture: no Drive doc and an empty email body/);
		expect(ports.gmail.modifyLabels).not.toHaveBeenCalled();
	});

	it("case 6: with target_folder_id each captured doc is moved once after labelling; without it, docs are left in place", async () => {
		const callOrder: string[] = [];
		const portsWithFolder = makePorts({
			gmail: {
				getMessage: vi.fn(async () =>
					makeMessage({
						body: "https://docs.google.com/document/d/docId12345678901234567890/edit",
					}),
				),
				ensureLabel: vi.fn(async () => ({
					label: { id: "lbl-meeting", name: "meeting_note" },
					created: false,
				})),
				modifyLabels: vi.fn(async () => {
					callOrder.push("modifyLabels");
					return { id: "msg-1", labelIds: ["lbl-meeting"] };
				}),
			},
			drive: {
				getFile: vi.fn(async ({ fileId }) => ({
					id: fileId,
					name: "Weekly Sync",
					mimeType: "application/vnd.google-apps.document",
					parents: ["old-folder"],
				})),
				downloadFile: vi.fn(async () => ({
					bytes: new TextEncoder().encode("Notes"),
					mimeType: "text/markdown",
					extension: "md",
				})),
				updateFile: vi.fn(async ({ fileId, addParents }) => {
					callOrder.push("drive.updateFile");
					return {
						id: fileId,
						name: "Weekly Sync",
						mimeType: "application/vnd.google-apps.document",
						parents: addParents ? [addParents] : [],
					};
				}),
			},
		});

		const actionWithFolder = createIngestMeetingNotesAction(portsWithFolder);
		const outMoved = await executeAction(
			actionWithFolder,
			{ message_id: "msg-1", target_folder_id: "target-folder" },
			{ context: { caller: "mcp", userId: "owner-1" } },
		);

		expect(portsWithFolder.drive.updateFile).toHaveBeenCalledTimes(1);
		expect(portsWithFolder.drive.updateFile).toHaveBeenCalledWith({
			domain: "angus",
			fileId: "docId12345678901234567890",
			addParents: "target-folder",
			removeParents: "old-folder",
			fields: "id, name, mimeType, parents",
		});
		expect(callOrder).toEqual(["modifyLabels", "drive.updateFile"]);
		expect(formatIngestMeetingNotesMcp(outMoved)).toContain("Moved doc:");

		const portsWithoutFolder = makePorts();
		const actionWithoutFolder = createIngestMeetingNotesAction(portsWithoutFolder);
		const outLeft = await executeAction(
			actionWithoutFolder,
			{ message_id: "msg-1" },
			{ context: { caller: "mcp", userId: "owner-1" } },
		);
		expect(portsWithoutFolder.drive.updateFile).not.toHaveBeenCalled();
		expect(formatIngestMeetingNotesMcp(outLeft)).toContain(
			"No target_folder_id given — doc left in place.",
		);
	});

	describe("event lookup (#2294)", () => {
		const MESSAGE_DATE = "2026-08-24";

		function eventRow(id: string, title: string, updatedAt: string, date = MESSAGE_DATE): EntityRow {
			return {
				id,
				title,
				entity_type: "event",
				description: null,
				properties: { date },
				tags: [],
				archived: false,
				archived_at: null,
				source_url: null,
				user_id: "owner-1",
				team_id: null,
				created_at: updatedAt,
				updated_at: updatedAt,
			};
		}

		/**
		 * A fake of the real adapter over a fixed set of rows, newest first.
		 * `loadRows` substring-matches then slices to `limit` (what the lookup used
		 * before #2294); `findByExactTitle` matches like the adapter's query: the
		 * trimmed input against the stored title as stored, ignoring case. A stored
		 * title with surrounding whitespace is therefore not returned.
		 */
		function makeEntities(stored: EntityRow[], opts: { overMatch?: EntityRow[] } = {}) {
			return {
				loadRows: vi.fn(async (filter: { query?: string; limit?: number }) => {
					const needle = (filter.query ?? "").toLowerCase();
					const matched = stored.filter((r) => (r.title ?? "").toLowerCase().includes(needle));
					return { rows: matched.slice(0, filter.limit ?? 20), truncated: false };
				}),
				findByExactTitle: vi.fn(async (query: { entity_type: string; title: string }) => [
					...(opts.overMatch ?? []),
					...stored.filter(
						(r) =>
							r.entity_type === query.entity_type &&
							(r.title ?? "").toLowerCase() === query.title.trim().toLowerCase(),
					),
				]),
				insert: vi.fn(async () => {
					throw new Error("duplicate key value violates unique constraint");
				}),
			};
		}

		function syncMessagePorts(entities: ReturnType<typeof makeEntities>) {
			return makePorts({
				gmail: {
					getMessage: vi.fn(async () =>
						makeMessage({
							subject: 'Notes: "Sync"',
							body: "See https://docs.google.com/document/d/docId12345678901234567890/edit",
						}),
					),
					ensureLabel: vi.fn(async () => ({
						label: { id: "lbl-meeting", name: "meeting_note" },
						created: false,
					})),
					modifyLabels: vi.fn(async () => ({ id: "msg-1", labelIds: ["lbl-meeting"] })),
				},
				entities,
			});
		}

		async function run(ports: IngestMeetingNotesPorts) {
			const out = await executeAction(
				createIngestMeetingNotesAction(ports),
				{ message_id: "msg-1" },
				{ context: { caller: "mcp", userId: "owner-1" } },
			);
			if (out.status !== "ingested") throw new Error("expected ingested");
			return out;
		}

		const newerSubstringMatches = Array.from({ length: 25 }, (_, i) =>
			eventRow(`event-design-${i + 1}`, `Design Sync ${i + 1}`, `2026-09-${String(25 - i).padStart(2, "0")}T00:00:00Z`),
		);

		it("finds an existing event that sits behind 20+ newer substring matches instead of inserting a duplicate", async () => {
			const entities = makeEntities([
				...newerSubstringMatches,
				eventRow("event-existing", "Sync", "2026-08-24T10:00:00Z"),
			]);
			const out = await run(syncMessagePorts(entities));

			expect(out.title).toBe("Sync");
			expect(out.date).toBe(MESSAGE_DATE);
			expect(entities.insert).not.toHaveBeenCalled();
			expect(out.eventId).toBe("event-existing");
			expect(out.eventCreated).toBe(false);
			expect(out.notes.join("\n")).toContain("existing event entity event-existing");
		});

		it("resolves an existing event whose title differs only by case", async () => {
			const entities = makeEntities([eventRow("event-existing", "sync", "2026-08-24T10:00:00Z")]);
			const out = await run(syncMessagePorts(entities));

			expect(entities.insert).not.toHaveBeenCalled();
			expect(out.eventId).toBe("event-existing");
		});

		it("does not find a stored title with surrounding whitespace, and falls through to the insert", async () => {
			// Known gap, stated in the port doc: the query compares the stored title
			// untrimmed, so this row is not returned and the action tries to insert.
			const entities = makeEntities([eventRow("event-existing", " sync ", "2026-08-24T10:00:00Z")]);

			await expect(run(syncMessagePorts(entities))).rejects.toThrow(
				"duplicate key value violates unique constraint",
			);
			expect(entities.findByExactTitle).toHaveBeenCalledTimes(1);
			expect(entities.insert).toHaveBeenCalledTimes(1);
		});

		it("ignores a non-exact row the port over-matched", async () => {
			const entities = makeEntities([eventRow("event-existing", "Sync", "2026-08-24T10:00:00Z")], {
				overMatch: [eventRow("event-other", "Sync-up with Alex", "2026-09-30T00:00:00Z")],
			});
			const out = await run(syncMessagePorts(entities));

			expect(entities.insert).not.toHaveBeenCalled();
			expect(out.eventId).toBe("event-existing");
		});

		it("throws when the entity repository has no findByExactTitle", async () => {
			const ports = makePorts({
				entities: { insert: vi.fn() } as unknown as IngestMeetingNotesPorts["entities"],
			});

			await expect(
				executeAction(
					createIngestMeetingNotesAction(ports),
					{ message_id: "msg-1" },
					{ context: { caller: "mcp", userId: "owner-1" } },
				),
			).rejects.toThrow("EntityRepository.findByExactTitle is not wired");
			expect(ports.entities.insert).not.toHaveBeenCalled();
		});
	});
});
