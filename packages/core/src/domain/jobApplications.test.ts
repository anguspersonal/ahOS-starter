import { describe, expect, it } from "vitest";
import { EDGE_TYPES } from "./vocab.js";
import {
	addUtcDays,
	addUtcWorkingDays,
	APPLICATION_CHANNEL_SLUGS,
	APPLICATION_CHANNELS,
	AUTO_CLOSE_DAYS,
	buildPreApplicationTaskSpec,
	daysBetweenUtcDates,
	defaultNextActionForStage,
	deriveLastActionAt,
	derivePipelineMetrics,
	DEX_JOBS_ALIAS_DENYLIST,
	evaluateApplicationCadence,
	FOLLOWUP_CADENCE_DAYS,
	formatJobApplicationTitle,
	getApplicationChannelTerm,
	getJobApplicationStageDefinition,
	getRoleCategoryTerm,
	isApplicationChannel,
	isForbiddenDexJobsAlias,
	isJobApplicationStage,
	isJobSiteChannelKind,
	isRoleCategory,
	isSilent,
	isSubmitted,
	isTerminalStage,
	isToReviewStage,
	JOB_APPLICATION_CV_EDGE,
	JOB_APPLICATION_ENTITY_KIND,
	JOB_APPLICATION_PARTICIPANT_EDGES,
	JOB_APPLICATION_STAGE_SLUGS,
	JOB_APPLICATION_STAGES,
	JOB_SEARCH_AREA_TITLE,
	JOB_SEARCH_DOMAIN,
	normaliseRoleTitle,
	PRE_APPLICATION_TASK_DUE_DAYS,
	PRE_APPLICATION_TASK_PRIORITY,
	PRE_APPLICATION_TASK_TITLE,
	reachedInterview,
	ROLE_CATEGORIES,
	ROLE_CATEGORY_SLUGS,
	SILENT_THRESHOLD_DAYS,
	statusForStage,
	type JobApplicationRecord,
	type JobApplicationStage,
} from "./jobApplications.js";
import type { TaskStatusSlug } from "./taskDimensions.js";

const APPENDIX_A_AS_OF = "2026-11-22";

const APPENDIX_A_FIXTURE: readonly JobApplicationRecord[] = [
	{
		org: "WORK-SELF",
		role_title: "Founding Product Lead, Maya Enterprise",
		role_category: "product",
		channel: "jumpstart",
		applied_on: null,
		stage: "screening",
		stage_history: [
			{ stage: "applied", at: "2026-11-21" },
			{ stage: "screening", at: "2026-11-21" },
		],
	},
	{
		org: "Telemachus",
		role_title: "Special Projects Lead",
		role_category: "ops_chief_of_staff",
		channel: "jumpstart",
		applied_on: null,
		stage: "screening",
		stage_history: [
			{ stage: "applied", at: "2026-11-02" },
			{ stage: "screening", at: "2026-11-02" },
			{ stage: "screening", at: "2026-11-06" },
		],
	},
	{
		org: "36 Labs",
		role_title: "Lead Product Engineer",
		role_category: "product",
		channel: "jack_and_jill",
		stage: "matched",
		stage_history: [{ stage: "matched", at: "2026-11-22" }],
	},
	{
		org: "HelmGuard AI",
		role_title: "Founding Product Engineer",
		role_category: "product",
		channel: "jack_and_jill",
		stage: "matched",
		stage_history: [{ stage: "matched", at: "2026-11-22" }],
	},
	{
		org: "FireCheckr",
		role_title: "Founding Engineer",
		role_category: "ai_engineering",
		channel: "jack_and_jill",
		stage: "matched",
		stage_history: [{ stage: "matched", at: "2026-11-22" }],
	},
	{
		org: "Stealth startup (a16z speedrun)",
		role_title: "Founding Engineer",
		role_category: "ai_engineering",
		channel: "jack_and_jill",
		stage: "matched",
		stage_history: [{ stage: "matched", at: "2026-11-22" }],
	},
	{
		org: "Novabook",
		role_title: "Chief of Staff",
		role_category: "ops_chief_of_staff",
		channel: "jumpstart",
		stage: "matched",
		stage_history: [{ stage: "matched", at: "2026-11-21" }],
	},
	{
		org: "Kiki Club",
		role_title: "Founding Chief of Staff",
		role_category: "ops_chief_of_staff",
		channel: "jumpstart",
		stage: "matched",
		stage_history: [{ stage: "matched", at: "2026-11-17" }],
	},
	{
		org: "UCL Estates",
		role_title: "Associate Director, Data and Digital",
		role_category: "data_leadership",
		channel: "company_site",
		applied_on: "2026-10-07",
		stage: "applied",
		stage_history: [{ stage: "applied", at: "2026-10-07" }],
	},
	{
		org: "Trade Nation",
		role_title: "Head of Data & AI",
		role_category: "data_leadership",
		channel: "company_site",
		applied_on: "2026-10-08",
		stage: "applied",
		stage_history: [{ stage: "applied", at: "2026-10-08" }],
	},
	{
		org: "Cohere",
		role_title: "Applied AI Engineer, Agents & Automations",
		role_category: "ai_engineering",
		channel: "company_site",
		applied_on: "2026-10-05",
		stage: "applied",
		stage_history: [{ stage: "applied", at: "2026-10-05" }],
	},
	{
		org: "Calibre",
		role_title: "AI Product Engineer",
		role_category: "product",
		channel: "dex_jobs",
		applied_on: "2026-10-08",
		stage: "applied",
		stage_history: [{ stage: "applied", at: "2026-10-08" }],
	},
	{
		org: "Catches",
		role_title: "AI Engineer",
		role_category: "ai_engineering",
		channel: "dex_jobs",
		applied_on: "2026-10-08",
		stage: "applied",
		stage_history: [{ stage: "applied", at: "2026-10-08" }],
	},
	{
		org: "Augur",
		role_title: "Forward Deployed Engineer",
		role_category: "ai_engineering",
		channel: "dex_jobs",
		applied_on: "2026-10-11",
		stage: "applied",
		stage_history: [{ stage: "applied", at: "2026-10-11" }],
	},
	{
		org: "ModelML",
		role_title: "Applied AI Engineer",
		role_category: "ai_engineering",
		channel: "dex_jobs",
		applied_on: "2026-10-11",
		stage: "applied",
		stage_history: [{ stage: "applied", at: "2026-10-11" }],
	},
	{
		org: "Rome AI",
		role_title: "Product Engineer",
		role_category: "product",
		channel: "dex_jobs",
		applied_on: "2026-10-11",
		stage: "applied",
		stage_history: [{ stage: "applied", at: "2026-10-11" }],
	},
	{
		org: "Benford",
		role_title: "Founding Engineer",
		role_category: "ai_engineering",
		channel: "dex_jobs",
		applied_on: "2026-10-13",
		stage: "applied",
		stage_history: [{ stage: "applied", at: "2026-10-13" }],
	},
	{
		org: "Nous",
		role_title: "Senior Operations & Automation Associate",
		role_category: "ops_chief_of_staff",
		channel: "jumpstart",
		applied_on: null,
		stage: "rejected",
		closed_on: "2026-11-20",
		stage_history: [
			{ stage: "applied", at: "2026-11-16" },
			{ stage: "rejected", at: "2026-11-20" },
		],
	},
	{
		org: "Omnea",
		role_title: "AI Solutions Lead",
		role_category: "solutions",
		channel: "jumpstart",
		applied_on: null,
		stage: "rejected",
		closed_on: "2026-11-16",
		stage_history: [
			{ stage: "applied", at: "2026-11-12" },
			{ stage: "rejected", at: "2026-11-16" },
		],
	},
	{
		org: "Glide",
		role_title: "Solutions Engineer",
		role_category: "solutions",
		channel: "jumpstart",
		applied_on: null,
		stage: "rejected",
		closed_on: "2026-11-13",
		stage_history: [
			{ stage: "applied", at: "2026-11-09" },
			{ stage: "rejected", at: "2026-11-13" },
		],
	},
	{
		org: "Veeva Systems",
		role_title: "Strategy Director, OpenData",
		role_category: "data_leadership",
		channel: "company_site",
		applied_on: "2026-11-06",
		stage: "rejected",
		closed_on: "2026-11-12",
		stage_history: [
			{ stage: "applied", at: "2026-11-06" },
			{ stage: "rejected", at: "2026-11-12" },
		],
	},
	{
		org: "Stackfix",
		role_title: "Founding Applied AI Engineer",
		role_category: "ai_engineering",
		channel: "cord",
		applied_on: "2026-10-06",
		stage: "rejected",
		closed_on: "2026-10-09",
		stage_history: [
			{ stage: "applied", at: "2026-10-06" },
			{ stage: "rejected", at: "2026-10-09" },
		],
	},
	{
		org: "Brainlabs",
		role_title: "Director, Data Strategy",
		role_category: "data_leadership",
		channel: "company_site",
		applied_on: "2026-10-06",
		stage: "rejected",
		closed_on: "2026-10-07",
		stage_history: [
			{ stage: "applied", at: "2026-10-06" },
			{ stage: "rejected", at: "2026-10-07" },
		],
	},
	{
		org: "Novatus",
		role_title: "Manager, Data & AI",
		role_category: "data_leadership",
		channel: "company_site",
		applied_on: "2026-10-05",
		stage: "rejected",
		closed_on: "2026-10-06",
		stage_history: [
			{ stage: "applied", at: "2026-10-05" },
			{ stage: "rejected", at: "2026-10-06" },
		],
	},
	{
		org: "Undisclosed pension fund (via Saragossa)",
		role_title: "AI Strategy Lead",
		role_category: "data_leadership",
		channel: "recruiter",
		applied_on: null,
		stage: "drafting",
		stage_history: [{ stage: "drafting", at: "2026-09-29" }],
	},
	{
		org: "EWOR",
		role_title: "Founder Fellowship",
		role_category: "other",
		channel: "company_site",
		applied_on: null,
		stage: "drafting",
		stage_history: [{ stage: "drafting", at: "2026-10-13" }],
	},
	{
		org: "Undisclosed (via Data Idols)",
		role_title: "Head of Data",
		role_category: "data_leadership",
		channel: "recruiter",
		applied_on: null,
		stage: "drafting",
		stage_history: [
			{ stage: "drafting", at: "2026-10-07" },
			{ stage: "drafting", at: "2026-10-14" },
		],
	},
];

describe("ADR-120 job application constants & EDGE_TYPES alignment", () => {
	it("pins locked domain constants, participant edges, and Dex collision denylist", () => {
		expect(JOB_APPLICATION_ENTITY_KIND).toBe("job_application");
		expect(JOB_SEARCH_AREA_TITLE).toBe("Job Search");
		expect(JOB_SEARCH_DOMAIN).toBe("angus");
		expect(JOB_APPLICATION_CV_EDGE).toBe("references");
		expect(SILENT_THRESHOLD_DAYS).toBe(14);
		expect(FOLLOWUP_CADENCE_DAYS).toEqual([7, 14, 28]);
		expect(AUTO_CLOSE_DAYS).toBe(42);
		expect(PRE_APPLICATION_TASK_TITLE).toBe("Decide: apply or pass");
		expect(PRE_APPLICATION_TASK_DUE_DAYS).toBe(3);
		expect(PRE_APPLICATION_TASK_PRIORITY).toBe(4);

		for (const edge of JOB_APPLICATION_PARTICIPANT_EDGES) {
			expect(EDGE_TYPES).toContain(edge);
		}
		expect(EDGE_TYPES).toContain(JOB_APPLICATION_CV_EDGE);

		for (const forbidden of DEX_JOBS_ALIAS_DENYLIST) {
			expect(isForbiddenDexJobsAlias(forbidden)).toBe(true);
		}
		expect(isForbiddenDexJobsAlias("Dex")).toBe(true);
		expect(isForbiddenDexJobsAlias("Dex jobs")).toBe(false);
		expect(isForbiddenDexJobsAlias("meetdex.ai")).toBe(false);
	});

	it("validates role categories, application channels, and job-site channel kinds", () => {
		expect(ROLE_CATEGORY_SLUGS).toEqual([
			"product",
			"ai_engineering",
			"data_leadership",
			"ops_chief_of_staff",
			"solutions",
			"other",
		]);
		expect(ROLE_CATEGORIES).toHaveLength(6);
		for (const slug of ROLE_CATEGORY_SLUGS) {
			expect(isRoleCategory(slug)).toBe(true);
			expect(getRoleCategoryTerm(slug).slug).toBe(slug);
		}
		expect(isRoleCategory("finance")).toBe(false);

		expect(APPLICATION_CHANNELS).toHaveLength(8);
		for (const slug of APPLICATION_CHANNEL_SLUGS) {
			expect(isApplicationChannel(slug)).toBe(true);
			expect(getApplicationChannelTerm(slug).slug).toBe(slug);
		}
		expect(isApplicationChannel("linkedin_easy_apply")).toBe(false);

		expect(isJobSiteChannelKind("marketplace")).toBe(true);
		expect(isJobSiteChannelKind("unknown")).toBe(false);
	});
});

describe("statusForStage and 11-stage lifecycle rules (#2439 Decision 1)", () => {
	const EXPECTED_STAGE_STATUS: Record<JobApplicationStage, TaskStatusSlug> = {
		identified: "proposed",
		matched: "proposed",
		drafting: "todo",
		applied: "in_progress",
		screening: "in_progress",
		interviewing: "in_progress",
		offer: "in_progress",
		accepted: "done",
		rejected: "cancelled",
		withdrawn: "cancelled",
		closed_no_reply: "cancelled",
	};

	it("maps all 11 stages deterministically to ADR-117 TaskStatusSlug", () => {
		expect(JOB_APPLICATION_STAGE_SLUGS).toHaveLength(11);
		expect(JOB_APPLICATION_STAGES).toHaveLength(11);

		for (const stage of JOB_APPLICATION_STAGE_SLUGS) {
			expect(isJobApplicationStage(stage)).toBe(true);
			expect(statusForStage(stage)).toBe(EXPECTED_STAGE_STATUS[stage]);
			expect(getJobApplicationStageDefinition(stage).slug).toBe(stage);
		}
		expect(isJobApplicationStage("archived")).toBe(false);
	});

	it("marks identified and matched as non-terminal, non-submitted, to_review with Decide task (+3d, P4)", () => {
		for (const stage of ["identified", "matched"] as const) {
			const def = getJobApplicationStageDefinition(stage);
			expect(def.terminal).toBe(false);
			expect(def.submitted).toBe(false);
			expect(isTerminalStage(stage)).toBe(false);
			expect(isToReviewStage(stage)).toBe(true);

			const task = buildPreApplicationTaskSpec(stage, "2026-11-22");
			expect(task.title).toBe("Decide: apply or pass");
			expect(task.due_date).toBe("2026-11-25");
			expect(task.priority_level).toBe(4);
			expect(task.status).toBe("todo");

			const defaultSpec = defaultNextActionForStage(stage);
			expect(defaultSpec?.title).toBe("Decide: apply or pass");
			expect(defaultSpec?.due_days).toBe(3);
			expect(defaultSpec?.priority_level).toBe(4);
		}
		expect(isToReviewStage("drafting")).toBe(false);
		expect(statusForStage("drafting")).toBe("todo");
	});

	it("handles terminal stages and default next actions across every stage", () => {
		expect(isTerminalStage("accepted")).toBe(true);
		expect(isTerminalStage("rejected")).toBe(true);
		expect(isTerminalStage("withdrawn")).toBe(true);
		expect(isTerminalStage("closed_no_reply")).toBe(true);
		expect(isTerminalStage("applied")).toBe(false);

		expect(defaultNextActionForStage("drafting")?.title).toBe("Finish or drop");
		expect(defaultNextActionForStage("applied")?.due_days).toBe(7);
		expect(defaultNextActionForStage("screening")?.title).toBe("Book the call");
		expect(
			defaultNextActionForStage("screening", { screeningCallHeld: true })?.title,
		).toBe("Follow up for the outcome");
		expect(defaultNextActionForStage("interviewing")?.energy_mode).toBe(
			"deep_work",
		);
		expect(defaultNextActionForStage("offer")?.priority_level).toBe(7);
		expect(defaultNextActionForStage("accepted")).toBeNull();
		expect(defaultNextActionForStage("rejected")).toBeNull();
		expect(defaultNextActionForStage("withdrawn")).toBeNull();
		expect(defaultNextActionForStage("closed_no_reply")).toBeNull();
	});

	it("handles isSubmitted including withdrawn with/without applied_on", () => {
		expect(
			isSubmitted({ stage: "identified", applied_on: null }),
		).toBe(false);
		expect(isSubmitted({ stage: "matched", applied_on: null })).toBe(false);
		expect(isSubmitted({ stage: "drafting", applied_on: null })).toBe(false);
		expect(
			isSubmitted({ stage: "applied", applied_on: "2026-11-01" }),
		).toBe(true);
		expect(
			isSubmitted({ stage: "withdrawn", applied_on: null }),
		).toBe(false);
		expect(
			isSubmitted({ stage: "withdrawn", applied_on: "2026-11-01" }),
		).toBe(true);
		expect(
			isSubmitted({ stage: "closed_no_reply", applied_on: "2026-10-01" }),
		).toBe(true);
	});

	it("detects reachedInterview from stage or stage_history (including post-screening rejections)", () => {
		expect(reachedInterview({ stage: "applied", stage_history: [] })).toBe(
			false,
		);
		expect(reachedInterview({ stage: "screening" })).toBe(true);
		expect(
			reachedInterview({
				stage: "rejected",
				stage_history: [
					{ stage: "applied", at: "2026-11-01" },
					{ stage: "screening", at: "2026-11-05" },
					{ stage: "rejected", at: "2026-11-10" },
				],
			}),
		).toBe(true);
	});
});

describe("isSilent (14d) and 7/14/28/42d cadence evaluator (#2439 Decisions 4 & 5)", () => {
	it("flags applied as silent at 14 days and not silent at 13 days", () => {
		const app: JobApplicationRecord = {
			org: "Acme",
			role_title: "Product Lead",
			role_category: "product",
			channel: "company_site",
			stage: "applied",
			applied_on: "2026-11-08",
		};

		expect(isSilent(app, "2026-11-21")).toBe(false); // 13 days
		expect(isSilent(app, "2026-11-22")).toBe(true); // 14 days
	});

	it("resets silence clock when last_inbound_at is later than applied_on, clamps pre-application inbound dates, and ignores non-applied stages", () => {
		const withInbound: JobApplicationRecord = {
			org: "Acme",
			role_title: "Product Lead",
			role_category: "product",
			channel: "company_site",
			stage: "applied",
			applied_on: "2026-11-01",
			last_inbound_at: "2026-11-10",
		};
		expect(isSilent(withInbound, "2026-11-23")).toBe(false); // 13 days since inbound
		expect(isSilent(withInbound, "2026-11-24")).toBe(true); // 14 days since inbound

		// Pre-application inbound message must not start silence clock before applied_on
		const withPreAppInbound: JobApplicationRecord = {
			...withInbound,
			applied_on: "2026-11-10",
			last_inbound_at: "2026-11-01",
		};
		expect(isSilent(withPreAppInbound, "2026-11-23")).toBe(false); // 13 days since applied_on
		expect(isSilent(withPreAppInbound, "2026-11-24")).toBe(true); // 14 days since applied_on

		expect(
			isSilent(
				{
					...withInbound,
					stage: "screening",
				},
				"2026-12-31",
			),
		).toBe(false);
	});

	it("evaluates 7d, 14d, 28d chase milestones and 42d closed_no_reply auto-close", () => {
		const base: JobApplicationRecord = {
			org: "Acme",
			role_title: "AI Engineer",
			role_category: "ai_engineering",
			channel: "dex_jobs",
			stage: "applied",
			applied_on: "2026-10-01",
		};

		// Day 6 -> none
		const day6 = evaluateApplicationCadence(base, "2026-10-07");
		expect(day6.daysElapsed).toBe(6);
		expect(day6.action).toBe("none");
		expect(day6.silent).toBe(false);
		expect(day6.shouldAutoClose).toBe(false);

		// Day 7 (1w) -> chase_1w
		const day7 = evaluateApplicationCadence(base, "2026-10-08");
		expect(day7.daysElapsed).toBe(7);
		expect(day7.action).toBe("chase_1w");
		expect(day7.milestoneDays).toBe(7);
		expect(day7.chaseNumber).toBe(1);
		expect(day7.silent).toBe(false);
		expect(day7.shouldAutoClose).toBe(false);
		expect(day7.taskSpec?.status).toBe("proposed");

		// Day 13 -> still 1w chase, not silent
		const day13 = evaluateApplicationCadence(base, "2026-10-14");
		expect(day13.action).toBe("chase_1w");
		expect(day13.silent).toBe(false);

		// Day 14 (2w) -> chase_2w + silent
		const day14 = evaluateApplicationCadence(base, "2026-10-15");
		expect(day14.daysElapsed).toBe(14);
		expect(day14.action).toBe("chase_2w");
		expect(day14.milestoneDays).toBe(14);
		expect(day14.chaseNumber).toBe(2);
		expect(day14.silent).toBe(true);
		expect(day14.shouldAutoClose).toBe(false);

		// Day 28 (4w) -> chase_4w + silent
		const day28 = evaluateApplicationCadence(base, "2026-10-29");
		expect(day28.daysElapsed).toBe(28);
		expect(day28.action).toBe("chase_4w");
		expect(day28.milestoneDays).toBe(28);
		expect(day28.chaseNumber).toBe(3);
		expect(day28.silent).toBe(true);
		expect(day28.shouldAutoClose).toBe(false);

		// Day 41 -> still chase_4w
		const day41 = evaluateApplicationCadence(base, "2026-11-11");
		expect(day41.daysElapsed).toBe(41);
		expect(day41.action).toBe("chase_4w");
		expect(day41.shouldAutoClose).toBe(false);

		// Day 42 (6w) -> auto_close as closed_no_reply (cancelled)
		const day42 = evaluateApplicationCadence(base, "2026-11-12");
		expect(day42.daysElapsed).toBe(42);
		expect(day42.action).toBe("auto_close");
		expect(day42.milestoneDays).toBe(42);
		expect(day42.silent).toBe(true);
		expect(day42.shouldAutoClose).toBe(true);
		expect(day42.nextStage).toBe("closed_no_reply");
		expect(day42.nextStatus).toBe("cancelled");
		expect(day42.taskSpec).toBeNull();
	});
});

describe("Appendix A 27-row pipeline metrics fixture (as of 2026-11-22)", () => {
	it("reproduces exact overall, channel, and category counts", () => {
		expect(APPENDIX_A_FIXTURE).toHaveLength(27);

		const metrics = derivePipelineMetrics(APPENDIX_A_FIXTURE, APPENDIX_A_AS_OF);

		// Overall
		expect(metrics.total).toBe(27);
		expect(metrics.submitted).toBe(18);
		expect(metrics.reached_interview).toBe(2);
		expect(metrics.rejected).toBe(7);
		expect(metrics.silent).toBe(9);
		expect(metrics.to_review).toBe(6);
		expect(metrics.drafting).toBe(3);
		expect(metrics.interview_rate).toBeCloseTo(2 / 18, 6);

		// By channel
		expect(metrics.by_channel.jumpstart).toMatchObject({
			submitted: 5,
			reached_interview: 2,
			rejected: 3,
			silent: 0,
			to_review: 2,
		});
		expect(metrics.by_channel.company_site).toMatchObject({
			submitted: 6,
			reached_interview: 0,
			rejected: 3,
			silent: 3,
			drafting: 1,
		});
		expect(metrics.by_channel.dex_jobs).toMatchObject({
			submitted: 6,
			reached_interview: 0,
			rejected: 0,
			silent: 6,
		});
		expect(metrics.by_channel.cord).toMatchObject({
			submitted: 1,
			reached_interview: 0,
			rejected: 1,
			silent: 0,
		});
		expect(metrics.by_channel.jack_and_jill).toMatchObject({
			submitted: 0,
			reached_interview: 0,
			to_review: 4,
		});
		expect(metrics.by_channel.recruiter).toMatchObject({
			submitted: 0,
			drafting: 2,
		});

		// By category
		expect(metrics.by_category.product).toMatchObject({
			submitted: 3,
			reached_interview: 1,
			silent: 2,
			to_review: 2,
		});
		expect(metrics.by_category.ops_chief_of_staff).toMatchObject({
			submitted: 2,
			reached_interview: 1,
			rejected: 1,
			to_review: 2,
		});
		expect(metrics.by_category.ai_engineering).toMatchObject({
			submitted: 6,
			reached_interview: 0,
			rejected: 1,
			silent: 5,
			to_review: 2,
		});
		expect(metrics.by_category.data_leadership).toMatchObject({
			submitted: 5,
			reached_interview: 0,
			rejected: 3,
			silent: 2,
			drafting: 2,
		});
		expect(metrics.by_category.solutions).toMatchObject({
			submitted: 2,
			reached_interview: 0,
			rejected: 2,
		});
		expect(metrics.by_category.other).toMatchObject({
			submitted: 0,
			drafting: 1,
		});
	});

	it("counts identified alongside matched in to_review", () => {
		const mixed = [
			...APPENDIX_A_FIXTURE,
			{
				org: "Anthropic",
				role_title: "Product Lead",
				role_category: "product" as const,
				channel: "direct_outreach" as const,
				stage: "identified" as const,
			},
		];
		const metrics = derivePipelineMetrics(mixed, APPENDIX_A_AS_OF);
		expect(metrics.total).toBe(28);
		expect(metrics.to_review).toBe(7);
		expect(metrics.submitted).toBe(18);
	});
});

describe("date, formatting, and last-action pure helpers", () => {
	it("computes UTC day deltas, honors non-UTC ISO offsets, calendar/working day offsets, title formatting, and last action", () => {
		expect(daysBetweenUtcDates("2026-11-08", "2026-11-22")).toBe(14);
		// 2026-10-01T23:30:00-05:00 is 2026-10-02T04:30:00Z (Oct 2 UTC)
		expect(
			daysBetweenUtcDates("2026-10-01T23:30:00-05:00", "2026-10-15T00:00:00Z"),
		).toBe(13);
		expect(addUtcDays("2026-10-01T23:30:00-05:00", 0)).toBe("2026-10-02");
		expect(addUtcDays("2026-11-22", 3)).toBe("2026-11-25");
		// Friday 2026-11-20 + 1 working day -> Monday 2026-11-23
		expect(addUtcWorkingDays("2026-11-20", 1)).toBe("2026-11-23");
		expect(normaliseRoleTitle("  Founding Product Lead, Maya Enterprise! ")).toBe(
			"founding product lead maya enterprise",
		);
		expect(
			formatJobApplicationTitle("WORK-SELF", "Founding Product Lead"),
		).toBe("WORK-SELF · Founding Product Lead");

		expect(
			deriveLastActionAt({
				linkedEmailDates: ["2026-11-02T10:00:00Z"],
				sentMailDates: ["2026-11-21T16:30:00Z"],
				stageHistory: [{ stage: "screening", at: "2026-11-21T09:00:00Z" }],
				completedTaskDates: ["2026-11-06T12:00:00Z"],
			}),
		).toBe("2026-11-21T16:30:00Z");
		expect(deriveLastActionAt({})).toBeNull();
	});
});
