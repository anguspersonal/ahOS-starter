import {
	DEFAULT_EXCLUDED_EXTENSIONS,
	DEFAULT_EXCLUDED_FOLDERS,
	DEFAULT_EXCLUDED_MIME_TYPES,
	evaluateExclusion as coreEvaluateExclusion,
	type ExclusionLists,
	type ExclusionResult,
} from "@ahkms/core";
import { supabase } from "../supabase.js";
import { getCurrentUserId } from "../identity.js";

/**
 * Discover exclusion policy (issue #1232, #1545).
 *
 * Configurable rules applied at discover time so code trees, build artifacts,
 * and non-document noise do not flood the pointer index. Pure rule evaluation
 * and default lists live in @ahkms/core; this module resolves env overrides
 * and owns the Supabase soft-archive cleanup path.
 */

export {
	DEFAULT_EXCLUDED_EXTENSIONS,
	DEFAULT_EXCLUDED_FOLDERS,
	DEFAULT_EXCLUDED_MIME_TYPES,
	type ExclusionLists,
	type ExclusionResult,
};

export function getExcludedFolders(): string[] {
	if (process.env.DISCOVER_EXCLUDE_FOLDERS) {
		return process.env.DISCOVER_EXCLUDE_FOLDERS.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean);
	}
	return [...DEFAULT_EXCLUDED_FOLDERS];
}

export function getExcludedExtensions(): string[] {
	if (process.env.DISCOVER_EXCLUDE_EXTENSIONS) {
		return process.env.DISCOVER_EXCLUDE_EXTENSIONS.split(",")
			.map((s) => s.trim().toLowerCase())
			.map((s) => (s.startsWith(".") ? s : `.${s}`))
			.filter(Boolean);
	}
	return [...DEFAULT_EXCLUDED_EXTENSIONS];
}

export function getExcludedMimeTypes(): string[] {
	if (process.env.DISCOVER_EXCLUDE_MIME_TYPES) {
		return process.env.DISCOVER_EXCLUDE_MIME_TYPES.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean);
	}
	return [...DEFAULT_EXCLUDED_MIME_TYPES];
}

/**
 * Evaluate an item against folder, extension, and mime-type exclusion rules,
 * applying any DISCOVER_EXCLUDE_* environment variable overrides.
 */
export function evaluateExclusion(
	item: {
		title?: string | null;
		external_id?: string | null;
		url?: string | null;
		mime_type?: string | null;
		envelope?: Record<string, unknown> | null;
	},
	lists?: ExclusionLists,
): ExclusionResult {
	return coreEvaluateExclusion(item, {
		folders: lists?.folders ?? getExcludedFolders(),
		extensions: lists?.extensions ?? getExcludedExtensions(),
		mimeTypes: lists?.mimeTypes ?? getExcludedMimeTypes(),
	});
}

export type SoftArchiveOptions = {
	dryRun?: boolean;
	limit?: number;
};

export type SoftArchiveResult = {
	scanned: number;
	matched: number;
	archived: number;
	sample: Array<{ id: string; title: string; reason: string }>;
};

/**
 * Reversible cleanup path for existing matching pointers (soft-archive with discover_excluded).
 * Requires owner approval before execution (defaults to dryRun: true).
 */
export async function softArchiveExcludedPointers(
	opts: SoftArchiveOptions = {},
): Promise<SoftArchiveResult> {
	const dryRun = opts.dryRun !== false;
	const limit = opts.limit ?? 1000;
	const userId = getCurrentUserId();

	const { data, error } = await supabase
		.from("artifacts")
		.select("id, title, source, storage_url, processing_metadata")
		.eq("user_id", userId)
		.ilike("source_channel", "discovered_%")
		.eq("archived", false)
		.order("captured_at", { ascending: false })
		.limit(limit);

	if (error) {
		throw new Error(`Failed to query discovered pointers for cleanup: ${error.message}`);
	}

	const rows = data ?? [];
	const matchedRows: Array<{ id: string; title: string; reason: string }> = [];

	for (const row of rows) {
		const metadata = (row.processing_metadata as Record<string, unknown>) ?? {};
		const discovery = (metadata.discovery as Record<string, unknown>) ?? {};
		const res = evaluateExclusion({
			title: row.title,
			external_id: row.source,
			url: row.storage_url,
			mime_type: typeof discovery.mime_type === "string" ? discovery.mime_type : null,
			envelope: (discovery.envelope as Record<string, unknown>) ?? null,
		});

		if (res.excluded && res.reason) {
			matchedRows.push({
				id: row.id,
				title: row.title ?? "(untitled)",
				reason: res.reason,
			});
		}
	}

	let archivedCount = 0;
	if (!dryRun && matchedRows.length > 0) {
		const now = new Date().toISOString();
		for (const m of matchedRows) {
			const { error: updateError } = await supabase
				.from("artifacts")
				.update({
					archived: true,
					archived_at: now,
					archived_reason: `discover_excluded:${m.reason}`,
				})
				.eq("id", m.id)
				.eq("user_id", userId);

			if (!updateError) {
				archivedCount += 1;
			}
		}
	}

	return {
		scanned: rows.length,
		matched: matchedRows.length,
		archived: archivedCount,
		sample: matchedRows.slice(0, 20),
	};
}
