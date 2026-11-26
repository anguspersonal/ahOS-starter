/**
 * Discover exclusion policy (issue #1232, #1545).
 *
 * Pure configurable rules applied at discover time so code trees, build artifacts,
 * and non-document noise do not flood the pointer index. Free of Node environment and
 * Supabase imports; callers pass override lists when env overrides apply.
 */

export const DEFAULT_EXCLUDED_FOLDERS = Object.freeze([
	"node_modules",
	".git",
	".next",
	"dist",
	"build",
	".turbo",
	"target",
	"out",
	"coverage",
	".cache",
	".venv",
	"vendor",
	"__pycache__",
]);

export const DEFAULT_EXCLUDED_EXTENSIONS = Object.freeze([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".rs",
	".go",
	".java",
	".c",
	".cpp",
	".h",
	".cs",
	".rb",
	".php",
	".map",
	".lock",
	".sum",
	".o",
	".obj",
	".class",
	".pyc",
	".wasm",
	".dylib",
	".so",
	".dll",
	".min.js",
	".min.css",
	".ds_store",
]);

export const DEFAULT_EXCLUDED_MIME_TYPES = Object.freeze([
	"text/javascript",
	"application/javascript",
	"text/x-typescript",
	"text/x-python",
	"text/x-java-source",
	"text/x-c",
	"text/x-rust",
	"text/x-go",
	"application/x-sh",
	"application/x-tar",
	"application/zip",
	"application/gzip",
	"application/x-bzip2",
	"application/x-7z-compressed",
]);

export type ExclusionLists = {
	folders?: readonly string[];
	extensions?: readonly string[];
	mimeTypes?: readonly string[];
};

export type ExclusionResult = {
	excluded: boolean;
	reason?: string;
};

/**
 * Evaluate an item against folder, extension, and mime-type exclusion rules.
 */
export function evaluateExclusion(
	item: {
		title?: string | null;
		external_id?: string | null;
		url?: string | null;
		mime_type?: string | null;
		envelope?: Record<string, unknown> | null;
	},
	lists: ExclusionLists = {},
): ExclusionResult {
	const excludedMimes = lists.mimeTypes ?? DEFAULT_EXCLUDED_MIME_TYPES;
	const excludedFolders = lists.folders ?? DEFAULT_EXCLUDED_FOLDERS;
	const excludedExts = lists.extensions ?? DEFAULT_EXCLUDED_EXTENSIONS;

	// 1. Check mime type
	if (item.mime_type) {
		const mime = item.mime_type.trim().toLowerCase();
		if (excludedMimes.includes(mime)) {
			return { excluded: true, reason: `excluded_mime_type:${mime}` };
		}
	}

	// 2. Check folder names across title, external_id, url, and envelope.path
	const pathCandidates: string[] = [];
	if (item.title) pathCandidates.push(item.title);
	if (item.external_id) pathCandidates.push(item.external_id);
	if (item.url) {
		try {
			const parsed = new URL(item.url);
			pathCandidates.push(decodeURIComponent(parsed.pathname));
		} catch {
			pathCandidates.push(item.url);
		}
	}
	if (item.envelope?.path && typeof item.envelope.path === "string") {
		pathCandidates.push(item.envelope.path);
	}

	for (const candidate of pathCandidates) {
		const segments = candidate
			.split(/[/\\]+/)
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean);
		for (const segment of segments) {
			if (excludedFolders.includes(segment)) {
				return { excluded: true, reason: `excluded_folder:${segment}` };
			}
		}
	}

	// 3. Check extensions on title, external_id, and filename candidates
	const filenameCandidates: string[] = [];
	if (item.title) filenameCandidates.push(item.title.trim().toLowerCase());
	if (item.external_id) filenameCandidates.push(item.external_id.trim().toLowerCase());
	if (item.envelope?.filename && typeof item.envelope.filename === "string") {
		filenameCandidates.push(item.envelope.filename.trim().toLowerCase());
	}

	for (const name of filenameCandidates) {
		for (const ext of excludedExts) {
			if (name.endsWith(ext)) {
				return { excluded: true, reason: `excluded_extension:${ext}` };
			}
		}
	}

	return { excluded: false };
}
