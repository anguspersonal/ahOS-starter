import { describe, expect, it } from "vitest";
import {
	assertFilterApplied,
	assertPathInProject,
	assertPolicyDeclared,
	assertWriteAllowed,
	HOGQL_PROPERTY_ACCESS_HINT,
	isRetroactiveWrite,
	postHogConnectionConfigSchema,
	stampFor,
	withHogqlPropertyHint,
	type FilterPolicy,
	type PostHogConnection,
	type WritePolicy,
} from "./contract.js";

// writePolicy defaults to null because that is the state most cases care about:
// undeclared, which refuses. A test that wants writes has to say so, the same way a
// connection does.
function conn(
	filterPolicy: FilterPolicy | null,
	writePolicy: WritePolicy | null = null,
): PostHogConnection {
	return {
		slug: "work",
		ref: "posthog:work",
		projectId: 110015,
		host: "eu",
		filterPolicy,
		writePolicy,
		platformScoping: null,
	};
}

const HOGQL_GUARDED = {
	kind: "HogQLQuery",
	query: "select count() from events where timestamp >= now() - interval 7 day and {filters}",
	filters: { filterTestAccounts: true },
};

describe("filter policy is three-state", () => {
	it("refuses a read when nobody has declared a policy", () => {
		// The load-bearing case. An undeclared connection is NOT a clean one, and the
		// whole of #742 is what happens when an unlabelled number gets quoted.
		expect(() => assertPolicyDeclared(conn(null))).toThrow(/no filter_policy declared/);
	});

	it("distinguishes undeclared from not_applicable", () => {
		// Same absence of filtering, opposite meanings: one is a decision, the other is
		// the absence of one. A boolean cannot hold that difference, which is why this
		// is three-state.
		expect(() => assertPolicyDeclared(conn("not_applicable"))).not.toThrow();
		expect(() => assertPolicyDeclared(conn(null))).toThrow();
	});

	it("tells you what to set rather than only what is wrong", () => {
		const err = (() => {
			try {
				assertPolicyDeclared(conn(null));
			} catch (e) {
				return e as Error;
			}
			throw new Error("expected a throw");
		})();

		expect(err.message).toMatch(/'required'/);
		expect(err.message).toMatch(/'not_applicable'/);
		expect(err.message).toContain("posthog:work");
	});
});

describe("assertFilterApplied — HogQL", () => {
	it("rejects a raw query with no placeholder", () => {
		// Measured against project 110015: this exact shape returns 10891 where the
		// filtered figure is 8930. It does not error, it does not warn, it just reads
		// 18% high.
		expect(() =>
			assertFilterApplied(conn("required"), {
				kind: "HogQLQuery",
				query: "select count() from events",
			}),
		).toThrow(/\{filters\} placeholder/);
	});

	it("rejects a query with the placeholder but no filterTestAccounts flag", () => {
		// Half-applied is the nastiest case: the SQL LOOKS filtered on review.
		expect(() =>
			assertFilterApplied(conn("required"), {
				kind: "HogQLQuery",
				query: "select count() from events where {filters}",
			}),
		).toThrow(/filterTestAccounts: true/);
	});

	it("names both omissions at once rather than one per attempt", () => {
		const err = (() => {
			try {
				assertFilterApplied(conn("required"), { kind: "HogQLQuery", query: "select 1" });
			} catch (e) {
				return e as Error;
			}
			throw new Error("expected a throw");
		})();

		expect(err.message).toMatch(/placeholder/);
		expect(err.message).toMatch(/filterTestAccounts/);
	});

	it("accepts a fully guarded query", () => {
		expect(() => assertFilterApplied(conn("required"), HOGQL_GUARDED)).not.toThrow();
	});

	it("refuses rather than silently adding the placeholder", () => {
		// Rewriting a caller's SQL so it returns a different number is this bug wearing
		// a different hat. The query object must come back untouched.
		const query = { kind: "HogQLQuery", query: "select count() from events" };
		const before = JSON.stringify(query);
		expect(() => assertFilterApplied(conn("required"), query)).toThrow();
		expect(JSON.stringify(query)).toBe(before);
	});
});

describe("assertFilterApplied — structured queries and other policies", () => {
	it("requires the flag on a structured insight query", () => {
		expect(() =>
			assertFilterApplied(conn("required"), { kind: "TrendsQuery", series: [] }),
		).toThrow(/TrendsQuery does not set filterTestAccounts/);
	});

	it("accepts a structured query carrying the flag", () => {
		expect(() =>
			assertFilterApplied(conn("required"), {
				kind: "TrendsQuery",
				series: [],
				filterTestAccounts: true,
			}),
		).not.toThrow();
	});

	it("lets an unfiltered query through when the project genuinely has no filter", () => {
		// A portfolio site has no internal traffic to exclude. Forcing a placeholder
		// there would be cargo-culting Work's contract onto a project it is false of.
		expect(() =>
			assertFilterApplied(conn("not_applicable"), {
				kind: "HogQLQuery",
				query: "select count() from events",
			}),
		).not.toThrow();
	});

	it("checks the policy before the query shape", () => {
		// An undeclared connection fails on the policy even with a perfect query, so a
		// well-formed query can never paper over a missing decision.
		expect(() => assertFilterApplied(conn(null), HOGQL_GUARDED)).toThrow(
			/no filter_policy declared/,
		);
	});
});

describe("stampFor", () => {
	it("carries connection, project, region and pull time", () => {
		const s = stampFor(conn("required"), new Date("2026-08-24T20:00:00.000Z"));

		expect(s).toEqual({
			connection: "posthog:work",
			project_id: 110015,
			region: "eu",
			filter_policy: "required",
			pulled_at: "2026-08-24T20:00:00.000Z",
		});
	});

	it("renders an undeclared policy as the word, never as an omitted field", () => {
		// An absent key reads as "fine"; the literal string "undeclared" does not.
		expect(stampFor(conn(null)).filter_policy).toBe("undeclared");
	});

	it("stamps a pull time, because filterTestAccounts is retroactive", () => {
		// The roster is applied at query time across all history, so the same question
		// asked twice legitimately returns different numbers (metrics.yml records
		// installs reading 63 then 57 the same day). A number without its pull time
		// cannot be reconciled with one taken later.
		expect(stampFor(conn("required")).pulled_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});
});

describe("connection config schema", () => {
	it("treats an absent filter_policy as undeclared rather than defaulting it", () => {
		const parsed = postHogConnectionConfigSchema.parse({ host: "eu", project_id: 110015 });

		expect(parsed.filter_policy).toBeUndefined();
	});

	it("requires a host, so a region is never guessed", () => {
		// A guessed region 401s, which reads as a bad key and sends you to re-mint a
		// perfectly good one.
		expect(() => postHogConnectionConfigSchema.parse({ project_id: 110015 })).toThrow();
	});

	it("requires a positive integer project id", () => {
		expect(() =>
			postHogConnectionConfigSchema.parse({ host: "eu", project_id: "110015" }),
		).toThrow();
	});

	it("keeps platform scoping, which PostHog itself does not know about", () => {
		// Project 110015 carries the app and every web surface, so $lib is the only
		// correct discriminator and device-type filters are wrong.
		const parsed = postHogConnectionConfigSchema.parse({
			host: "eu",
			project_id: 110015,
			filter_policy: "required",
			platform_scoping: { app: "$lib = 'posthog-react-native'", web: "$lib = 'web'" },
		});

		expect(parsed.platform_scoping?.app).toContain("posthog-react-native");
	});
});

describe("write policy is three-state, like the filter policy", () => {
	it("refuses when nobody has declared one", () => {
		expect(() => assertWriteAllowed(conn("required"))).toThrow(/no write_policy declared/);
	});

	it("refuses when it says forbidden", () => {
		expect(() => assertWriteAllowed(conn("required", "forbidden"))).toThrow(
			/write_policy 'forbidden'/,
		);
	});

	it("permits only an explicit allowed", () => {
		expect(() => assertWriteAllowed(conn("required", "allowed"))).not.toThrow();
	});
});

describe("a write cannot leave the connection it is stamped with", () => {
	const c = conn("required", "allowed");

	it("accepts a path in the connection's own project", () => {
		expect(() => assertPathInProject(c, "/api/projects/110015/cohorts/225061/")).not.toThrow();
	});

	it("refuses a path naming a different project", () => {
		expect(() => assertPathInProject(c, "/api/projects/190313/cohorts/1/")).toThrow(
			/addresses project 190313/,
		);
	});

	it("accepts an organisation-level path, which names no project", () => {
		expect(() => assertPathInProject(c, "/api/organizations/@current/projects/")).not.toThrow();
	});

	it("refuses anything outside /api/", () => {
		expect(() => assertPathInProject(c, "/internal/thing")).toThrow(/must start with/);
	});
});

// These four assertions are the reason this block exists. The first version of the
// cohort pattern carried an invisible control character and matched NOTHING, so the
// acknowledgement it gates never fired and a history-restating write would have gone
// straight through looking entirely normal. A regex that silently matches nothing is
// exactly the failure this file is for.
describe("history-restating paths are recognised", () => {
	it("treats a cohort edit as retroactive", () => {
		expect(isRetroactiveWrite("/api/projects/110015/cohorts/225061/")).toBe(true);
	});

	it("treats the project itself as retroactive, since it holds the test-account filter", () => {
		expect(isRetroactiveWrite("/api/projects/110015/")).toBe(true);
	});

	it("does not treat an ordinary resource as retroactive", () => {
		expect(isRetroactiveWrite("/api/projects/110015/insights/")).toBe(false);
		expect(isRetroactiveWrite("/api/projects/110015/dashboards/4/")).toBe(false);
	});
});

describe("POSTHOG_TEST_ACCOUNT_CONTRACT (#742 written definition)", () => {
	it("records excluded event properties", async () => {
		const { POSTHOG_TEST_ACCOUNT_CONTRACT } = await import("./contract.js");
		const propNames = POSTHOG_TEST_ACCOUNT_CONTRACT.eventProperties.map((p) => p.property);
		expect(propNames).toContain("is_test");
		expect(propNames).toContain("$is_emulator");
		expect(propNames).toContain("build_profile");
		expect(propNames).toContain("$host");
	});

	it("records excluded person cohorts", async () => {
		const { POSTHOG_TEST_ACCOUNT_CONTRACT } = await import("./contract.js");
		const cohortIds = POSTHOG_TEST_ACCOUNT_CONTRACT.cohorts.map((c) => c.id);
		expect(cohortIds).toContain(168929); // Manual internal & F&F
		expect(cohortIds).toContain(168904); // Behavioral is_test
		expect(cohortIds).toContain(222860); // Non-organic install traffic
		expect(cohortIds).toContain(225061); // Dynamic non-organic traffic
	});

	it("records team domains, personal emails and probe accounts", async () => {
		const { POSTHOG_TEST_ACCOUNT_CONTRACT } = await import("./contract.js");
		expect(POSTHOG_TEST_ACCOUNT_CONTRACT.internalEmailDomains).toContain("@work.example.com");
		expect(POSTHOG_TEST_ACCOUNT_CONTRACT.internalEmailDomains).toContain("@test.com");
		expect(POSTHOG_TEST_ACCOUNT_CONTRACT.teamPersonalEmails).toContain("owner@example.com");
		expect(POSTHOG_TEST_ACCOUNT_CONTRACT.probeEmails).toContain("probe@work.example.com");
	});
});

// #970's debugging exception is intentionally NOT a bypass this guard recognises — it
// is posthog_query_debug, a wholly separate tool (see posthogTools.test.ts). This guard
// has no `purpose` parameter and no early-return path for a "required" policy.
describe("assertFilterApplied — no debugging bypass", () => {
	it("still refuses an unguarded query against a 'required' connection", () => {
		expect(() =>
			assertFilterApplied(conn("required"), { kind: "HogQLQuery", query: "select count() from events" }),
		).toThrow(/filter_policy 'required'/);
	});
});

describe("stampFor", () => {
	it("stamps a plain read with the connection's declared policy, nothing more", () => {
		const s = stampFor(conn("required"), new Date("2026-08-24T20:00:00.000Z"));
		expect(s.filter_policy).toBe("required");
		expect((s as Record<string, unknown>).purpose).toBeUndefined();
	});
});

describe("withHogqlPropertyHint (#1944)", () => {
	it("documents properties.<name>, properties.$lib, properties.$os, and person.properties.<name>", () => {
		expect(HOGQL_PROPERTY_ACCESS_HINT).toContain("properties.<name>");
		expect(HOGQL_PROPERTY_ACCESS_HINT).toContain("properties.$lib");
		expect(HOGQL_PROPERTY_ACCESS_HINT).toContain("properties.$os");
		expect(HOGQL_PROPERTY_ACCESS_HINT).toContain("person.properties.<name>");
	});

	it("appends the property-access hint to HogQL unresolved-field errors and preserves non-matching errors", () => {
		const hogqlErr = new Error("PostHog 400 (hogql_query): Unable to resolve field: $lib");
		const hinted = withHogqlPropertyHint(hogqlErr);
		expect(hinted.message).toContain("Unable to resolve field: $lib");
		expect(hinted.message).toContain(HOGQL_PROPERTY_ACCESS_HINT);

		const otherErr = new Error("PostHog 502 Bad Gateway");
		expect(withHogqlPropertyHint(otherErr)).toBe(otherErr);
	});
});
