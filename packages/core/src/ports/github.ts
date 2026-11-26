/**
 * Ports for GitHub issue interactions (ADR-101 §1, §4).
 * Types only. No external SDKs or environment dependencies.
 */

export interface IssueRef {
	number: number;
	url: string;
}

export interface CreateIssueInput {
	title: string;
	body?: string;
	labels?: string[];
}

export interface GithubIssuesPort {
	findOpenIssueByTitle(repo: string, title: string): Promise<IssueRef | null>;
	createIssue(repo: string, input: CreateIssueInput): Promise<IssueRef>;
	createComment?(repo: string, number: number, body: string): Promise<{ id: number; html_url: string }>;
	addLabels?(repo: string, number: number, labels: string[]): Promise<{ labels: string[] }>;
	removeLabel?(repo: string, number: number, label: string): Promise<{ removed: boolean }>;
}

export interface GithubPullRequestRead {
	number: number;
	title: string;
	state: string;
	draft: boolean;
	merged: boolean;
	head: { ref: string; sha: string };
	base: { ref: string; sha: string };
	author: string | null;
	html_url: string;
	additions: number;
	deletions: number;
	changed_files: number;
	created_at: string;
	updated_at: string;
	body: string | null;
	mergeable: boolean | null;
	mergeable_state: string | null;
}

export interface GithubPullListItem {
	number: number;
	title: string;
	state: string;
	draft: boolean;
	head_ref: string;
	base_ref: string;
	author: string | null;
	updated_at: string;
	html_url: string;
}

export interface GithubPullFileItem {
	filename: string;
	status: string;
	additions: number;
	deletions: number;
	changes: number;
	previous_filename: string | null;
	patch?: string;
}

export interface GithubPullCommitItem {
	sha: string;
	message: string;
	author: string | null;
	date: string | null;
}

export interface GithubPullReviewItem {
	id: number;
	user: string | null;
	state: string;
	submitted_at: string | null;
	body: string | null;
}

export interface GithubIssueRead {
	number: number;
	title: string;
	state: string;
	state_reason: string | null;
	labels: string[];
	assignees: string[];
	author: string | null;
	is_pull_request: boolean;
	comments: number;
	created_at: string;
	updated_at: string;
	closed_at: string | null;
	html_url: string;
	body: string | null;
}

export interface GithubIssueCommentItem {
	id: number;
	author: string | null;
	created_at: string;
	updated_at: string;
	body: string | null;
	html_url: string;
}

export interface GithubIssueTimelineItem {
	event: string;
	actor: string | null;
	created_at: string | null;
	label?: string | null;
	commit_id?: string | null;
	source_issue_number?: number | null;
	closing_pr_number?: number | null;
}

export interface GithubIssueSearchItem {
	repo: string;
	number: number;
	title: string;
	state: string;
	is_pull_request: boolean;
	updated_at: string;
	html_url: string;
}

export interface GithubIssueSearchResult {
	items: GithubIssueSearchItem[];
	total_count: number;
	incomplete_results: boolean;
	next_cursor: string | null;
}

export interface GithubPagedResult<T> {
	items: T[];
	next_cursor: string | null;
}

export interface ListPullsParams {
	state?: "open" | "closed" | "all";
	head?: string;
	base?: string;
	limit: number;
	page: number;
}

export interface GithubRepositoryRead {
	full_name: string;
	private: boolean;
	default_branch: string;
	description: string | null;
	archived: boolean;
	pushed_at: string | null;
	open_issues_count: number;
	html_url: string;
}

export interface GithubBranchRead {
	exists: boolean;
	name?: string;
	sha?: string;
	protected?: boolean;
}

export interface GithubFileRead {
	path: string;
	ref: string;
	sha: string;
	size: number;
	binary: boolean;
	text?: string;
}

export interface GithubDirEntry {
	name: string;
	path: string;
	type: string;
	size: number;
}

export function encodeRepoPathSegments(rawPath: string): { normalizedPath: string; encodedPath: string } {
	const trimmed = rawPath.replace(/^\/+|\/+$/g, "");
	if (!trimmed) {
		return { normalizedPath: "", encodedPath: "" };
	}
	const segments = trimmed.split("/");
	for (const seg of segments) {
		if (seg === ".." || seg === "." || seg.length === 0) {
			throw new Error(`Invalid repository path "${rawPath}": path traversal ("..") or empty segments are not allowed.`);
		}
	}
	return {
		normalizedPath: segments.join("/"),
		encodedPath: segments.map((s) => encodeURIComponent(s)).join("/"),
	};
}

export interface GithubWorkflowRunRead {
	id: number;
	name: string | null;
	event: string;
	status: string | null;
	conclusion: string | null;
	head_sha: string;
	head_branch: string | null;
	run_attempt: number;
	created_at: string;
	html_url: string;
}

export interface GithubWorkflowRunListResult {
	items: GithubWorkflowRunRead[];
	next_cursor: string | null;
	total_count: number;
}

export interface GithubListWorkflowRunsOptions {
	head_sha?: string;
	branch?: string;
	status?: string;
	limit: number;
	page: number;
}

export interface GithubWorkflowJobStepRead {
	name: string;
	number: number;
	conclusion: string | null;
}

export interface GithubWorkflowJobRead {
	id: number;
	name: string;
	status: string;
	conclusion: string | null;
	started_at: string | null;
	completed_at: string | null;
	steps: GithubWorkflowJobStepRead[];
}

export interface GithubWorkflowJobListResult {
	items: GithubWorkflowJobRead[];
	next_cursor: string | null;
}

export interface GithubListWorkflowRunJobsOptions {
	limit: number;
	page: number;
}

export type GithubJobLogRead =
	| { expired: true }
	| { expired?: false; log: string };

export interface GithubReadPort {
	getPull(repo: string, number: number): Promise<GithubPullRequestRead>;
	getPullDiff(repo: string, number: number): Promise<string>;
	listPulls?(repo: string, params: ListPullsParams): Promise<GithubPagedResult<GithubPullListItem>>;
	listPullFiles?(repo: string, number: number, params: { limit: number; page: number }): Promise<GithubPagedResult<GithubPullFileItem>>;
	listPullCommits?(repo: string, number: number, params: { limit: number; page: number }): Promise<GithubPagedResult<GithubPullCommitItem>>;
	listPullReviews?(repo: string, number: number, params: { limit: number; page: number }): Promise<GithubPagedResult<GithubPullReviewItem>>;
	getIssue?(repo: string, number: number): Promise<GithubIssueRead>;
	listIssueComments?(
		repo: string,
		number: number,
		params: { limit: number; page: number; since?: string },
	): Promise<GithubPagedResult<GithubIssueCommentItem>>;
	listIssueTimeline?(
		repo: string,
		number: number,
		params: { limit: number; page: number },
	): Promise<GithubPagedResult<GithubIssueTimelineItem>>;
	searchIssues?(
		query: string,
		params: { limit: number; page: number },
	): Promise<GithubIssueSearchResult>;
	getRepository?(repo: string): Promise<GithubRepositoryRead>;
	getBranch?(repo: string, branch: string): Promise<GithubBranchRead>;
	getFile?(repo: string, path: string, ref?: string): Promise<GithubFileRead>;
	listDirectory?(repo: string, path: string, ref?: string): Promise<GithubDirEntry[]>;
	listWorkflowRuns?(repo: string, options: GithubListWorkflowRunsOptions): Promise<GithubWorkflowRunListResult>;
	listWorkflowRunJobs?(
		repo: string,
		runId: number,
		options: GithubListWorkflowRunJobsOptions,
	): Promise<GithubWorkflowJobListResult>;
	getJobLog?(repo: string, jobId: number): Promise<GithubJobLogRead>;
}

export interface PullRef { number: number; html_url: string; head_sha: string }
export interface CreatePullInput { title: string; head: string; base: string; body?: string; draft?: boolean }
export interface UpdatePullInput { title?: string; body?: string }
export interface UpdatedPullRef { number: number; title: string; state: string; html_url: string }
export type PullReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
export interface CreatePullReviewInput { event: PullReviewEvent; body?: string }
export interface PullReviewRef { id: number; html_url: string; state: string }

export interface GithubPullsPort {
	findOpenPull(repo: string, head: string, base: string): Promise<PullRef | null>;
	createPull(repo: string, input: CreatePullInput): Promise<PullRef>;
	updatePull(repo: string, number: number, patch: UpdatePullInput): Promise<UpdatedPullRef>;
	closePull(repo: string, number: number): Promise<{ number: number; state: string }>;
	createReview?(repo: string, number: number, input: CreatePullReviewInput): Promise<PullReviewRef>;
	createPullRequestReview?(repo: string, number: number, input: CreatePullReviewInput): Promise<PullReviewRef>;
	listOpenPullsFromHead?(repo: string, head: string): Promise<PullRef[]>;
	deleteBranch?(repo: string, branch: string): Promise<{ deleted: boolean }>;
	getRepository?(repo: string): Promise<Pick<GithubRepositoryRead, "default_branch"> & Partial<GithubRepositoryRead>>;
}

export type GithubItem = {
	/** Stable across renames and the dedup key downstream. */
	url: string;
	number: number;
	repo: string;
	title: string;
	body: string;
	state: string;
	isPullRequest: boolean;
	/** For a PR: whether it actually landed, which `state` alone does not say. */
	merged: boolean;
	author: string;
	labels: string[];
	createdAt: string;
	updatedAt: string;
	closedAt: string;
	comments: number;
	/** Why this item matched: authored by the viewer, commented on, or both. */
	involvement: string[];
};

export type SearchWindow = {
	login: string;
	since: string;
	until?: string;
	/** Restrict to one `owner/name`. Omitted, every repo the token can see. */
	repo?: string;
	perQuery: number;
};

export interface GithubActivityPort {
	getViewerLogin(repo?: string): Promise<string>;
	searchMyActivity(window: SearchWindow): Promise<GithubItem[]>;
}

/** `owner/repo#12 Title` plus the state words that actually differ between kinds. */
export function describeItem(i: GithubItem): string {
	const kind = i.isPullRequest ? (i.merged ? "merged PR" : `${i.state} PR`) : `${i.state} issue`;
	return `${i.repo}#${i.number} ${i.title} (${kind}, ${i.involvement.join(" and ")})`;
}
