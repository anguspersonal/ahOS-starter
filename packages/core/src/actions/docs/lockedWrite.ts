import type { ArtifactRepository } from "../../ports/artifacts.js";
import type { Domain } from "../../domain/domains.js";
import type {
	DocsBatchUpdateReply,
	DocsBatchUpdateRequest,
	DocsPort,
	DocsWriteControl,
} from "../../ports/docs.js";

/** The ports every locked Docs write takes: `docs_batch_update`, `docs_replace_text`, `docs_append`. */
export interface DocsLockedWritePorts {
	docs: DocsPort;
	artifacts?: Pick<ArtifactRepository, "appendDocEditAudit">;
}

export interface DocsLockedWriteParams {
	/** Action id, used to tag the stderr audit line. */
	tool: string;
	domain: Domain;
	documentId: string;
	requiredRevisionId: string;
	requests: DocsBatchUpdateRequest[];
	suggest?: boolean;
}

export interface DocsLockedWriteResult {
	revisionBefore: string;
	revisionAfter: string | undefined;
	suggest: boolean;
	replies: DocsBatchUpdateReply[];
}

const REVISION_MISMATCH_TEXT = "does not match the latest revision";

/**
 * Maps Google's stale-revision refusal to a "re-read" error, or returns undefined.
 * Keyed on the signature Google sent in the #2308 probe: HTTP 400, INVALID_ARGUMENT,
 * "The required revision ID '<id>' does not match the latest revision."
 */
export function toDocsRevisionMismatchError(
	err: unknown,
	requiredRevisionId: string,
): Error | undefined {
	if (!(err instanceof Error)) return undefined;
	const { status, googleStatus } = err as { status?: unknown; googleStatus?: unknown };
	if (status !== 400 || googleStatus !== "INVALID_ARGUMENT") return undefined;
	if (!err.message.includes(REVISION_MISMATCH_TEXT)) return undefined;
	return new Error(
		`Doc changed since your read (revision mismatch: required '${requiredRevisionId}'). ` +
			`Re-read the document with docs_get and rebuild your batchUpdate requests. (Google detail: ${err.message})`,
	);
}

function logStderrAudit(args: {
	tool: string;
	documentId: string;
	revisionBefore: string;
	revisionAfter?: string;
	requestCount: number;
	suggest?: boolean;
}): void {
	console.error(
		`[${args.tool}] docId=${args.documentId} revisionBefore=${args.revisionBefore} ` +
			`revisionAfter=${args.revisionAfter ?? "(pending)"} requestCount=${args.requestCount} ` +
			`suggest=${args.suggest === true}`,
	);
}

/**
 * The one locked `batchUpdate`: sends `writeControl.requiredRevisionId` (plus
 * `writeMode: 'SUGGEST'` when asked), maps a stale revision to the re-read error,
 * refuses to fall back to a direct edit when suggestion mode is refused, and
 * writes the edit audit entry. Never retries.
 */
export async function runDocsLockedWrite(
	{ docs, artifacts }: DocsLockedWritePorts,
	params: DocsLockedWriteParams,
): Promise<DocsLockedWriteResult> {
	const { tool, domain, documentId, requiredRevisionId, requests } = params;
	const suggest = params.suggest === true;

	const writeControl: DocsWriteControl = { requiredRevisionId };
	if (suggest) {
		writeControl.writeMode = "SUGGEST";
	}

	logStderrAudit({
		tool,
		documentId,
		revisionBefore: requiredRevisionId,
		requestCount: requests.length,
		suggest,
	});

	let res;
	try {
		res = await docs.batchUpdate!({ domain, documentId, requests, writeControl });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);

		const mismatch = toDocsRevisionMismatchError(err, requiredRevisionId);
		if (mismatch) throw mismatch;

		if (suggest) {
			throw new Error(
				`Google refused suggestion mode (suggest: true): ${message}. ` +
					`The edits were NOT applied, and ahKMS will never fall back to a direct edit.`,
			);
		}

		throw err;
	}

	const revisionAfter = res.writeControl?.requiredRevisionId ?? res.revisionId ?? undefined;

	logStderrAudit({
		tool,
		documentId,
		revisionBefore: requiredRevisionId,
		revisionAfter,
		requestCount: requests.length,
		suggest,
	});

	try {
		await artifacts?.appendDocEditAudit?.(documentId, {
			timestamp: new Date().toISOString(),
			revision_before: requiredRevisionId,
			revision_after: revisionAfter ?? null,
			request_count: requests.length,
			suggest,
		});
	} catch (err) {
		if (!(err instanceof Error && err.name === "AdapterUnavailableError")) {
			console.error(
				`[${tool}] Note: Failed to append to artifact audit trail: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}

	return {
		revisionBefore: requiredRevisionId,
		revisionAfter,
		suggest,
		replies: res.replies ?? [],
	};
}
