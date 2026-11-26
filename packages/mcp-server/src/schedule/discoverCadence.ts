import { runDriveDiscoverCadence } from "./driveDiscoverCadence.js";
import { runNotionDiscoverCadence } from "./notionDiscoverCadence.js";
import { runGmailAttachmentDiscoverCadence } from "./gmailAttachmentDiscoverCadence.js";

// The discover cadence inventories every wired connector under one lock and one
// interval (ADR-016 Slice 3, #53/#339). Drive first, then Notion; each connector
// is internally isolated — a no-op when its credentials are unset, never throws,
// and records its own scheduler_runs row — so one connector's failure never aborts
// the other. Sharing the "discover" lock (rather than a per-connector lock) keeps
// this migration-free: a new lock key would need a seeded scheduler_locks row.
//
// Gmail attachments (#1210) run last, on the same terms, and only when
// KMS_GMAIL_ATTACHMENT_DISCOVER_ENABLED is set (the check lives in the connector).
// Last because its first runs drain a backlog in bounded steps, and a slow Gmail
// run should never delay the two sources that are already live.
export async function runDiscoverCadence(): Promise<void> {
	await runDriveDiscoverCadence();
	await runNotionDiscoverCadence();
	await runGmailAttachmentDiscoverCadence();
}
