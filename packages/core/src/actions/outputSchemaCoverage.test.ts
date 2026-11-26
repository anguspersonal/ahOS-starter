import { describe, expect, it } from "vitest";
import { buildRegistry } from "./buildRegistry.js";

const CHECKED = [
	"github_branch_delete",
	"github_branch_get",
	"github_comment_create",
	"github_dir_list",
	"github_file_get",
	"github_issue_comment_list",
	"github_issue_create",
	"github_issue_get",
	"github_issue_search",
	"github_issue_timeline",
	"github_job_log_get",
	"github_label_add",
	"github_label_remove",
	"github_pr_close",
	"github_pr_commit_list",
	"github_pr_create",
	"github_pr_diff",
	"github_pr_file_list",
	"github_pr_get",
	"github_pr_list",
	"github_pr_mergeability",
	"github_pr_review_list",
	"github_pr_update",
	"github_repo_get",
	"github_review_create",
	"github_run_job_list",
	"github_run_list",
] as const;

// Non-github schemas tracked for follow-up coverage in #2404.
const PENDING = [
	"entity_path",
	"graph_node_level",
	"linkedin_post",
	"notion_block_delete",
	"notion_comment_create",
	"notion_comment_list",
	"notion_database_get",
	"notion_database_query",
	"notion_page_create",
	"notion_page_get",
	"notion_page_update",
	"notion_search",
	"notion_user_list",
	"review_lesson_record",
	"sheets_write",
	"slack_message_delete",
	"slack_message_update",
	"slack_post",
	"slack_reaction_add",
	"state_doc_update",
] as const;

describe("outputSchema coverage (#2400)", () => {
	it("covers every action declaring outputSchema via CHECKED + PENDING with no overlap or stale entries", () => {
		const registry = buildRegistry({});
		const withOutputSchema = registry
			.list()
			.filter((action) => action.outputSchema !== undefined)
			.map((action) => action.id)
			.sort();

		const checkedSet = new Set<string>(CHECKED);
		const pendingSet = new Set<string>(PENDING);

		expect(checkedSet.size).toBe(CHECKED.length);
		expect(pendingSet.size).toBe(PENDING.length);

		const overlap = CHECKED.filter((id) => pendingSet.has(id));
		expect(overlap).toEqual([]);

		const expected = [...CHECKED, ...PENDING].sort();
		expect(withOutputSchema).toEqual(expected);
	});
});
