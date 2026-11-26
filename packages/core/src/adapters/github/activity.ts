import {
	describeItem,
	type GithubActivityPort,
	type GithubItem,
	type SearchWindow,
} from "../../ports/github.js";

export { describeItem, type GithubActivityPort, type GithubItem, type SearchWindow };

// Thin GitHub REST client for the ingest path (#1010, #1531). Raw fetch rather than Octokit,
// for the same reason google/gmail.ts and notion.ts are: every request is stubbable
// with a global fetch mock, so the whole path is unit-testable with no live token.
//
// READ ONLY. Nothing here writes: no issue creation, no comments, no merges. The MCP
// GitHub connector already does all of that far better than a hand-rolled client
// would, and duplicating it buys nothing. What the connector cannot do is put GitHub
// activity INTO the knowledge store, which is the only reason this file exists.

const DEFAULT_GITHUB_API = "https://api.github.com";

export type GithubActivityTokenFn = (repo?: string) => Promise<string>;

export interface GithubActivityAdapterOptions {
	fetch?: typeof globalThis.fetch;
	baseUrl?: string;
}

function redactToken(text: string, token: string): string {
	if (!token) return text;
	return text.split(token).join("[REDACTED]");
}

type SearchItemWire = {
	html_url?: string;
	number?: number;
	repository_url?: string;
	title?: string;
	body?: string | null;
	state?: string;
	pull_request?: { merged_at?: string | null };
	user?: { login?: string };
	labels?: { name?: string }[];
	created_at?: string;
	updated_at?: string;
	closed_at?: string | null;
	comments?: number;
};

/** `https://api.github.com/repos/owner/name` -> `owner/name`. */
function repoFromUrl(repositoryUrl: string | undefined, htmlUrl: string): string {
	if (repositoryUrl) return repositoryUrl.split("/repos/")[1] ?? "";
	// Fall back to the html_url, which is the only field guaranteed present.
	const m = /github\.com\/([^/]+\/[^/]+)\//.exec(htmlUrl);
	return m?.[1] ?? "";
}

function parseItem(w: SearchItemWire, involvement: string): GithubItem {
	const url = w.html_url ?? "";
	return {
		url,
		number: w.number ?? 0,
		repo: repoFromUrl(w.repository_url, url),
		title: w.title ?? "(no title)",
		body: w.body ?? "",
		state: w.state ?? "unknown",
		// The search API marks a PR by the presence of this object, not by a type field.
		isPullRequest: w.pull_request !== undefined,
		merged: Boolean(w.pull_request?.merged_at),
		author: w.user?.login ?? "",
		labels: (w.labels ?? []).map((l) => l.name ?? "").filter(Boolean),
		createdAt: w.created_at ?? "",
		updatedAt: w.updated_at ?? "",
		closedAt: w.closed_at ?? "",
		comments: w.comments ?? 0,
		involvement: [involvement],
	};
}

export function createGithubActivityAdapter(
	getToken: GithubActivityTokenFn,
	options: GithubActivityAdapterOptions = {},
): GithubActivityPort {
	const baseUrl = (options.baseUrl ?? DEFAULT_GITHUB_API).replace(/\/+$/, "");

	async function githubFetch<T>(path: string, repo?: string): Promise<T> {
		const rawToken = await getToken(repo);
		const token = typeof rawToken === "string" ? rawToken.trim() : "";
		if (!token) {
			throw new Error("Missing GitHub credential for activity request.");
		}
		const fetchFn = options.fetch ?? globalThis.fetch;
		let res: Response;
		try {
			res = await fetchFn(`${baseUrl}${path}`, {
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
					"User-Agent": "ahkms-github-ingest",
				},
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(redactToken(msg, token));
		}
		if (!res.ok) {
			const rawDetail = await res.text().catch(() => "");
			const detail = redactToken(rawDetail, token);
			// 403 with a rate-limit body is the commonest failure and looks nothing like
			// the 401 people expect, so the status and body both travel in the message.
			const error = new Error(
				`GitHub GET ${path} failed (${res.status}): ${detail.slice(0, 400) || res.statusText}`,
			) as Error & { status?: number };
			error.status = res.status;
			throw error;
		}
		return (await res.json()) as T;
	}

	return {
		/** The authenticated user's login, which every "activity by me" query is keyed on. */
		async getViewerLogin(repo?: string): Promise<string> {
			const me = await githubFetch<{ login?: string }>("/user", repo);
			if (!me.login) throw new Error("GitHub /user returned no login for this token.");
			return me.login;
		},

		/**
		 * Issues and pull requests the viewer authored or commented on, in a window.
		 *
		 * TWO queries, not one. GitHub's search grammar has no reliable OR across qualifiers,
		 * and the single-qualifier alternative, `involves:`, is wrong for this purpose: it also
		 * matches items where the viewer was merely MENTIONED or assigned. "Someone typed my
		 * name" is not activity by me, and pulling it in would quietly turn a record of what
		 * the owner did into a notifications feed.
		 *
		 * Results are merged on url, and an item matching both queries keeps both reasons, so
		 * "I opened it and discussed it" stays distinguishable from "I only commented".
		 */
		async searchMyActivity(w: SearchWindow): Promise<GithubItem[]> {
			const range = w.until ? `${w.since}..${w.until}` : `>=${w.since}`;
			const scope = w.repo ? ` repo:${w.repo}` : "";

			const merged = new Map<string, GithubItem>();
			for (const [qualifier, reason] of [
				["author", "authored"],
				["commenter", "commented"],
			] as const) {
				const q = encodeURIComponent(`${qualifier}:${w.login} updated:${range}${scope}`);
				const res = await githubFetch<{ items?: SearchItemWire[] }>(
					`/search/issues?q=${q}&sort=updated&order=desc&per_page=${w.perQuery}`,
					w.repo,
				);
				for (const raw of res.items ?? []) {
					const item = parseItem(raw, reason);
					if (!item.url) continue;
					const prior = merged.get(item.url);
					if (prior) prior.involvement.push(reason);
					else merged.set(item.url, item);
				}
			}

			return [...merged.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		},
	};
}

