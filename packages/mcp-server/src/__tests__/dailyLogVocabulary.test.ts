/**
 * Invariants for the Daily Log twin vocabulary (#562, ADR-050 §7).
 *
 * Every assertion here guards a failure that is silent at write time and only visible
 * days later, in a read nobody is watching. None of them is enforced by the schema:
 * `artifacts.content_subtype` and `artifact_external_links.kind` are both plain nullable
 * TEXT with no CHECK, deliberately (ADR-050 §6 — the vocabulary evolves without a
 * migration), so the vocabulary's own consistency is a test's job.
 */
import { describe, expect, it } from "vitest";
import {
	EVIDENCE_AGGREGATED as SHARED_EVIDENCE_AGGREGATED,
	EVIDENCE_AGGREGATED_UNATTENDED as SHARED_EVIDENCE_AGGREGATED_UNATTENDED,
	EVIDENCE_CLOSING_KINDS as SHARED_EVIDENCE_CLOSING_KINDS,
	SYNTHESIS_MARKER_KINDS,
} from "@ahkms/shared";
import {
	EVIDENCE_AGGREGATED as CORE_EVIDENCE_AGGREGATED,
	EVIDENCE_AGGREGATED_UNATTENDED as CORE_EVIDENCE_AGGREGATED_UNATTENDED,
	EVIDENCE_CLOSING_KINDS as CORE_EVIDENCE_CLOSING_KINDS,
	connectionDomain,
} from "@ahkms/core";
import {
	BACKDATABLE_CONTENT_SUBTYPES,
	BILL_CONTENT_SUBTYPE,
	BUSINESS_CARD_CONTENT_SUBTYPE,
	DAILY_LOG_CONTENT_SUBTYPE,
	DAILY_LOG_LINK_KIND,
	EVENT_REQUEST_CONTENT_SUBTYPE,
	EVIDENCE_AGGREGATED,
	EVIDENCE_AGGREGATED_UNATTENDED,
	EVIDENCE_CLOSING_KINDS,
	REFLECTION_CONTENT_SUBTYPE,
	REFLECTION_LINK_KIND,
	SCAFFOLD_CONTENT_SUBTYPE,
	SESSION_SUMMARY_CONTENT_SUBTYPE,
	STATE_DOC_LINK_KIND,
	SURFACES,
	SYSTEM_PRODUCED_CONTENT_SUBTYPES,
	TASK_REQUEST_CONTENT_SUBTYPE,
	VOUCHER_CONTENT_SUBTYPE,
} from "../vocab.js";

describe("the Daily Log twin's link kind is a pointer, never a synthesis marker", () => {
	// Adding 'daily_log' to SYNTHESIS_MARKER_KINDS would do two wrong things at once: the
	// twin would read as a CONSUMED atom (it is the ritual's output, not an atom the ritual
	// folded in), and dos_synthesis_coverage — which buckets markers by the artifact's
	// captured_at, and the twin's captured_at is the day it narrates — would add a phantom
	// count to the very day it is reporting on.
	it("keeps DAILY_LOG_LINK_KIND out of SYNTHESIS_MARKER_KINDS", () => {
		expect(SYNTHESIS_MARKER_KINDS as readonly string[]).not.toContain(DAILY_LOG_LINK_KIND);
	});

	it("keeps the synthesis vocabulary at exactly the two ADR-050 §6 kinds", () => {
		expect([...SYNTHESIS_MARKER_KINDS]).toEqual(["synthesized", "synthesized_unattended"]);
	});
});

describe("the Daily Log content_subtype is its own value", () => {
	it("does not collide with the other system-generated subtypes", () => {
		expect(DAILY_LOG_CONTENT_SUBTYPE).not.toBe(TASK_REQUEST_CONTENT_SUBTYPE);
		expect(DAILY_LOG_CONTENT_SUBTYPE).not.toBe(EVENT_REQUEST_CONTENT_SUBTYPE);
	});

	// The worker already writes content_subtype='derived' on artifacts it derives from
	// others, and that value is NOT excluded from search. Reusing it would make one string
	// mean two things and silently hide rows nobody meant to hide.
	it("is not the worker's pre-existing 'derived' subtype", () => {
		expect(DAILY_LOG_CONTENT_SUBTYPE).not.toBe("derived");
	});
});

describe("the scaffold content_subtype is its own value (#994)", () => {
	it("does not collide with any other system-generated subtype", () => {
		expect(SCAFFOLD_CONTENT_SUBTYPE).toBe("scaffold");
		expect(SCAFFOLD_CONTENT_SUBTYPE).not.toBe(DAILY_LOG_CONTENT_SUBTYPE);
		expect(SCAFFOLD_CONTENT_SUBTYPE).not.toBe(TASK_REQUEST_CONTENT_SUBTYPE);
		expect(SCAFFOLD_CONTENT_SUBTYPE).not.toBe(EVENT_REQUEST_CONTENT_SUBTYPE);
	});

	it("is not on the captured_at allowlist", () => {
		expect(BACKDATABLE_CONTENT_SUBTYPES.has(SCAFFOLD_CONTENT_SUBTYPE)).toBe(false);
	});
});

describe("the reflection content_subtype and link kind (#2316)", () => {
	it("defines REFLECTION_CONTENT_SUBTYPE and REFLECTION_LINK_KIND as 'reflection' and distinct from other subtypes/markers", () => {
		expect(REFLECTION_CONTENT_SUBTYPE).toBe("reflection");
		expect(REFLECTION_LINK_KIND).toBe("reflection");
		expect(REFLECTION_CONTENT_SUBTYPE).not.toBe(DAILY_LOG_CONTENT_SUBTYPE);
		expect(REFLECTION_CONTENT_SUBTYPE).not.toBe(SCAFFOLD_CONTENT_SUBTYPE);
		expect(REFLECTION_CONTENT_SUBTYPE).not.toBe(TASK_REQUEST_CONTENT_SUBTYPE);
		expect(REFLECTION_CONTENT_SUBTYPE).not.toBe(EVENT_REQUEST_CONTENT_SUBTYPE);
		expect(SYNTHESIS_MARKER_KINDS as readonly string[]).not.toContain(REFLECTION_LINK_KIND);
	});

	it("marks reflection as system-produced and backdatable, while scaffold remains non-backdatable", () => {
		expect(SYSTEM_PRODUCED_CONTENT_SUBTYPES.has(REFLECTION_CONTENT_SUBTYPE)).toBe(true);
		expect(BACKDATABLE_CONTENT_SUBTYPES.has(REFLECTION_CONTENT_SUBTYPE)).toBe(true);
		expect(BACKDATABLE_CONTENT_SUBTYPES.has(SCAFFOLD_CONTENT_SUBTYPE)).toBe(false);
	});
});

describe("the captured_at allowlist stays minimal", () => {
	// An unbounded captured_at lets any caller misfile atoms into arbitrary day buckets —
	// #414's date poisoning with a wider blast radius. Widening this set is a decision, and
	// this test is where that decision has to be made deliberately rather than in passing.
	it("admits exactly the Daily Log and reflection twins, and nothing else", () => {
		expect([...BACKDATABLE_CONTENT_SUBTYPES]).toEqual([
			DAILY_LOG_CONTENT_SUBTYPE,
			REFLECTION_CONTENT_SUBTYPE,
		]);
	});
});

describe("ritual output carries a surface (ADR-051 §9, #570)", () => {
	// ADR-051 §9 specifies "the ritual's own output is never the ritual's input" as a
	// `surface -> role` gate resolving ritual outputs to the ADR-046 §3 `excluded` tier.
	// That gate is not built (resolveSynthesisRole is inert — no search path consults it),
	// and exclusion today is carried by content_subtype. Stamping the surface anyway is
	// what lets the gate be built later without a backfill over twins written meanwhile,
	// so the value has to exist in the list the map is keyed on.
	it("lists dos_hl as a capture surface", () => {
		expect(SURFACES as readonly string[]).toContain("dos_hl");
	});

	// ADR-054 §7: the unified ritual is `dos`, and its twins carry that surface. `dos_hl`
	// stays for the twins already stamped with it.
	it("lists dos, the unified ritual's surface, beside it", () => {
		expect(SURFACES as readonly string[]).toContain("dos");
	});
});

describe("the second consumption hop has its own kind (ADR-051 §10, Erratum 1)", () => {
	it("is a pointer kind, outside the synthesis-marker vocabulary and distinct from the page pointer", () => {
		expect(STATE_DOC_LINK_KIND).toBe("consumed_by_state");
		expect(SYNTHESIS_MARKER_KINDS as readonly string[]).not.toContain(STATE_DOC_LINK_KIND);
		expect(STATE_DOC_LINK_KIND).not.toBe(DAILY_LOG_LINK_KIND);
	});
});

describe("the session summary is an input, never excluded and never backdated (#565)", () => {
	it("is its own value, distinct from every system-generated subtype", () => {
		expect(SESSION_SUMMARY_CONTENT_SUBTYPE).toBe("session_summary");
		expect(SESSION_SUMMARY_CONTENT_SUBTYPE).not.toBe(DAILY_LOG_CONTENT_SUBTYPE);
		expect(SESSION_SUMMARY_CONTENT_SUBTYPE).not.toBe(TASK_REQUEST_CONTENT_SUBTYPE);
		expect(SESSION_SUMMARY_CONTENT_SUBTYPE).not.toBe(EVENT_REQUEST_CONTENT_SUBTYPE);
	});

	it("is not on the captured_at allowlist", () => {
		expect(BACKDATABLE_CONTENT_SUBTYPES.has(SESSION_SUMMARY_CONTENT_SUBTYPE)).toBe(false);
	});
});

describe("the captured-artifact subtypes match the literals hardcoded in SKILL.md/CAPTURE_SOPS.md (#589, #590, #597)", () => {
	// VOUCHER_CONTENT_SUBTYPE/BILL_CONTENT_SUBTYPE/BUSINESS_CARD_CONTENT_SUBTYPE aren't
	// imported by any capture-time code (capture stays dumb — an agent session declares the
	// subtype directly), so nothing else catches these strings drifting from the prose in
	// .claude/skills/process_artifact/SKILL.md Step 7c and docs/guides/CAPTURE_SOPS.md if
	// either side is renamed later. Pinning the literals here is the guard.
	it("keeps the constants pinned to the exact strings the skill/docs prose hardcodes", () => {
		expect(VOUCHER_CONTENT_SUBTYPE).toBe("voucher");
		expect(BILL_CONTENT_SUBTYPE).toBe("bill");
		expect(BUSINESS_CARD_CONTENT_SUBTYPE).toBe("business_card");
	});

	it("does not collide with each other or the other system-generated subtypes", () => {
		const subtypes = [
			VOUCHER_CONTENT_SUBTYPE,
			BILL_CONTENT_SUBTYPE,
			BUSINESS_CARD_CONTENT_SUBTYPE,
			TASK_REQUEST_CONTENT_SUBTYPE,
			EVENT_REQUEST_CONTENT_SUBTYPE,
			DAILY_LOG_CONTENT_SUBTYPE,
			SESSION_SUMMARY_CONTENT_SUBTYPE,
		];
		expect(new Set(subtypes).size).toBe(subtypes.length);
	});
});

describe("evidence day-closing link vocabulary (#2225, ADR-108 §5, ADR-109 §1)", () => {
	it("defines EVIDENCE_AGGREGATED, EVIDENCE_AGGREGATED_UNATTENDED, and EVIDENCE_CLOSING_KINDS identically across shared, core, and mcp-server", () => {
		expect(EVIDENCE_AGGREGATED).toBe("evidence_aggregated");
		expect(EVIDENCE_AGGREGATED_UNATTENDED).toBe("evidence_aggregated_unattended");
		expect([...EVIDENCE_CLOSING_KINDS]).toEqual([
			"evidence_aggregated",
			"evidence_aggregated_unattended",
		]);

		expect(SHARED_EVIDENCE_AGGREGATED).toBe(EVIDENCE_AGGREGATED);
		expect(SHARED_EVIDENCE_AGGREGATED_UNATTENDED).toBe(EVIDENCE_AGGREGATED_UNATTENDED);
		expect([...SHARED_EVIDENCE_CLOSING_KINDS]).toEqual([...EVIDENCE_CLOSING_KINDS]);

		expect(CORE_EVIDENCE_AGGREGATED).toBe(EVIDENCE_AGGREGATED);
		expect(CORE_EVIDENCE_AGGREGATED_UNATTENDED).toBe(EVIDENCE_AGGREGATED_UNATTENDED);
		expect([...CORE_EVIDENCE_CLOSING_KINDS]).toEqual([...EVIDENCE_CLOSING_KINDS]);
	});

	it("keeps evidence day-closing kinds strictly outside SYNTHESIS_MARKER_KINDS", () => {
		expect([...SYNTHESIS_MARKER_KINDS]).toEqual(["synthesized", "synthesized_unattended"]);
		expect(SYNTHESIS_MARKER_KINDS as readonly string[]).not.toContain(EVIDENCE_AGGREGATED);
		expect(SYNTHESIS_MARKER_KINDS as readonly string[]).not.toContain(
			EVIDENCE_AGGREGATED_UNATTENDED,
		);
	});
});

describe("connectionDomain pure resolver (#2225, ADR-108 §6)", () => {
	it("resolves Work surfaces, GitHub repos, and account/provider facts to 'work'", () => {
		for (const surface of [
			"slack",
			"slack_dm",
			"discovered_gdrive_work",
			"discovered_gmail_attachment_work",
			"discovered_notion_meetings_work",
			"discovered_notion_pages_work",
		]) {
			expect(connectionDomain({ surface })).toBe("work");
		}

		expect(
			connectionDomain({ surface: "github", tags: ["repo:example-org/ahOS"] }),
		).toBe("work");
		expect(connectionDomain({ surface: "github", repo: "example-org/core" })).toBe("work");
		expect(
			connectionDomain({ surface: "act_receipt", tags: ["account:work"] }),
		).toBe("work");
		expect(
			connectionDomain({ surface: "gmail_ingest", account: "work" }),
		).toBe("work");
		expect(
			connectionDomain({ surface: "gmail_ingest", account: "owner@work.example.com" }),
		).toBe("work");
		expect(connectionDomain({ provider: "notion_work" })).toBe("work");
	});

	it("resolves Angus surfaces, GitHub repos, and account/provider facts to 'angus'", () => {
		for (const surface of [
			"discovered_gdrive",
			"discovered_gmail_attachment",
			"discovered_notion_meetings_personal",
			"discovered_notion_pages_personal",
		]) {
			expect(connectionDomain({ surface })).toBe("angus");
		}

		expect(
			connectionDomain({ surface: "github", tags: ["repo:anguspersonal/ahOS"] }),
		).toBe("angus");
		expect(connectionDomain({ surface: "github", repo: "anguspersonal/ahOS" })).toBe("angus");
		expect(
			connectionDomain({ surface: "act_receipt", tags: ["account:personal"] }),
		).toBe("angus");
		expect(
			connectionDomain({ surface: "gmail_ingest", account: "personal" }),
		).toBe("angus");
		expect(connectionDomain({ provider: "google_personal" })).toBe("angus");
		expect(connectionDomain({ provider: "notion_personal" })).toBe("angus");
	});

	it("delegates surface='derived' to parent connection facts and returns null when unresolved", () => {
		expect(
			connectionDomain({
				surface: "derived",
				parent: { surface: "slack" },
			}),
		).toBe("work");
		expect(
			connectionDomain({
				surface: "derived",
				parent: { surface: "act_receipt", tags: ["account:personal"] },
			}),
		).toBe("angus");
		expect(connectionDomain({ surface: "derived" })).toBeNull();
		expect(
			connectionDomain({
				surface: "derived",
				parent: { surface: "claude_code" },
			}),
		).toBeNull();

		for (const surface of ["claude_code", "claude_web", "chat", "cowork"]) {
			expect(connectionDomain({ surface })).toBeNull();
		}
		expect(connectionDomain({})).toBeNull();
	});
});
