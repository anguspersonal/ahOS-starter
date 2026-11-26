import { describe, expect, it, vi } from "vitest";
import {
	EVIDENCE_AGGREGATED,
	EVIDENCE_AGGREGATED_UNATTENDED,
	STATE_DOC_LINK_KIND,
} from "../../domain/vocab.js";
import {
	ActionPreconditionError,
	createExternalLinkCreateAction,
	type ExistingDailyLogPointer,
	type ExternalLinkCreateGuardPort,
	type ExternalLinkCreatePort,
} from "./externalLinkCreate.js";

const TWIN = "11111111-1111-4111-8111-111111111111";
const ATOM = "22222222-2222-4222-8222-222222222222";

function makePort(
	subtypeById: Record<string, string | null> = {},
	opts: { readError?: string; writeError?: string } = {},
) {
	const recordExternalLink = vi.fn(async () =>
		opts.writeError
			? { ok: false, error: opts.writeError }
			: { ok: true },
	);
	const getArtifactContentSubtype = vi.fn(async (artifactId: string) => {
		if (opts.readError) {
			return { data: null, error: opts.readError };
		}
		if (artifactId in subtypeById) {
			return { data: { content_subtype: subtypeById[artifactId] } };
		}
		return { data: null };
	});
	const port: ExternalLinkCreatePort = {
		recordExternalLink,
		getArtifactContentSubtype,
	};
	return { port, recordExternalLink, getArtifactContentSubtype };
}

describe("createExternalLinkCreateAction (#1539)", () => {
	it("exposes the canonical action id, domain, description, annotations, and default exposure", () => {
		const { port } = makePort();
		const action = createExternalLinkCreateAction(port);

		expect(action.id).toBe("external_link_create");
		expect(action.domain).toBe("artifacts");
		expect(action.description).toContain("docs/guides/tools/external_link_create.md");
		expect(action.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		});
		expect(action.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
	});

	it(`writes '${STATE_DOC_LINK_KIND}' on a Daily Log twin (hop 2) and formats MCP output`, async () => {
		const { port, recordExternalLink, getArtifactContentSubtype } = makePort({
			[TWIN]: "daily_log",
		});
		const action = createExternalLinkCreateAction(port);

		const output = await action.run({
			artifact_id: TWIN,
			provider: "notion_work",
			kind: STATE_DOC_LINK_KIND,
			external_id: "page-1",
			external_url: "https://notion.so/page-1",
			dedup_key: "hop-2",
		});

		expect(getArtifactContentSubtype).toHaveBeenCalledWith(TWIN);
		expect(recordExternalLink).toHaveBeenCalledWith(TWIN, {
			provider: "notion_work",
			kind: STATE_DOC_LINK_KIND,
			external_id: "page-1",
			external_url: "https://notion.so/page-1",
			dedup_key: "hop-2",
		});
		expect(output.text).toBe(
			`Linked artifact ${TWIN} → notion_work/${STATE_DOC_LINK_KIND}/page-1.`,
		);
		expect(action.formatMcp?.(output)).toBe(output.text);
	});

	it(`refuses '${STATE_DOC_LINK_KIND}' on an atom`, async () => {
		const { port, recordExternalLink } = makePort({ [ATOM]: null });
		const action = createExternalLinkCreateAction(port);

		await expect(
			action.run({
				artifact_id: ATOM,
				provider: "notion_work",
				kind: STATE_DOC_LINK_KIND,
				external_id: "page-1",
			}),
		).rejects.toThrow(/belongs on a Daily Log twin/);
		expect(recordExternalLink).not.toHaveBeenCalled();
	});

	it.each(["synthesized", "synthesized_unattended"])(
		"refuses a '%s' marker on a twin",
		async (kind) => {
			const { port, recordExternalLink } = makePort({ [TWIN]: "daily_log" });
			const action = createExternalLinkCreateAction(port);

			await expect(
				action.run({
					artifact_id: TWIN,
					provider: "notion_work",
					kind,
					external_id: "page-1",
					run_id: "run-123",
				}),
			).rejects.toThrow(/a twin never carries a synthesis marker/);
			expect(recordExternalLink).not.toHaveBeenCalled();
		},
	);

	it("refuses 'synthesized' without a ritual run_id", async () => {
		const { port, recordExternalLink, getArtifactContentSubtype } = makePort({
			[ATOM]: null,
		});
		const action = createExternalLinkCreateAction(port);

		await expect(
			action.run({
				artifact_id: ATOM,
				provider: "notion_work",
				kind: "synthesized",
				external_id: "page-1",
			}),
		).rejects.toThrow(/requires a ritual `run_id`/);
		expect(getArtifactContentSubtype).not.toHaveBeenCalled();
		expect(recordExternalLink).not.toHaveBeenCalled();
	});

	it("writes a 'synthesized' marker on an atom when ritual run_id is supplied", async () => {
		const { port, recordExternalLink } = makePort({ [ATOM]: null });
		const action = createExternalLinkCreateAction(port);

		const output = await action.run({
			artifact_id: ATOM,
			provider: "notion_work",
			kind: "synthesized",
			external_id: "page-1",
			run_id: "run-123",
		});

		expect(recordExternalLink).toHaveBeenCalledTimes(1);
		expect(output.text).toBe(
			`Linked artifact ${ATOM} → notion_work/synthesized/page-1.`,
		);
	});

	it("writes a 'synthesized_unattended' marker without a run_id", async () => {
		const { port, recordExternalLink } = makePort({ [ATOM]: null });
		const action = createExternalLinkCreateAction(port);

		await action.run({
			artifact_id: ATOM,
			provider: "notion_work",
			kind: "synthesized_unattended",
			external_id: "page-1",
		});

		expect(recordExternalLink).toHaveBeenCalledTimes(1);
	});

	it.each(["task", "event"])(
		"does not read the artifact for a '%s' pointer",
		async (kind) => {
			const { port, recordExternalLink, getArtifactContentSubtype } = makePort();
			const action = createExternalLinkCreateAction(port);

			await action.run({
				artifact_id: ATOM,
				provider: "notion_work",
				kind,
				external_id: "page-1",
			});

			expect(getArtifactContentSubtype).not.toHaveBeenCalled();
			expect(recordExternalLink).toHaveBeenCalledTimes(1);
		},
	);

	it("refuses rather than skips when the guard's read fails or finds nothing", async () => {
		const failedRead = makePort({}, { readError: "timeout" });
		const action1 = createExternalLinkCreateAction(failedRead.port);
		await expect(
			action1.run({
				artifact_id: ATOM,
				provider: "notion_work",
				kind: "synthesized",
				external_id: "page-1",
				run_id: "run-123",
			}),
		).rejects.toThrow(/never skipped on a failed read/);
		expect(failedRead.recordExternalLink).not.toHaveBeenCalled();

		const missingArtifact = makePort({});
		const action2 = createExternalLinkCreateAction(missingArtifact.port);
		await expect(
			action2.run({
				artifact_id: ATOM,
				provider: "notion_work",
				kind: STATE_DOC_LINK_KIND,
				external_id: "page-1",
			}),
		).rejects.toThrow(/was not found for this user/);
		expect(missingArtifact.recordExternalLink).not.toHaveBeenCalled();
	});

	it("throws a descriptive error mentioning migration 047 when recordExternalLink fails", async () => {
		const { port } = makePort({}, { writeError: "relation does not exist" });
		const action = createExternalLinkCreateAction(port);

		await expect(
			action.run({
				artifact_id: ATOM,
				provider: "notion_work",
				kind: "task",
				external_id: "page-1",
			}),
		).rejects.toThrow(/Failed to record external link: relation does not exist/);
	});

	describe("evidence day-closing link guards (#2225, ADR-108 §5, ADR-109 §1)", () => {
		it.each([
			[EVIDENCE_AGGREGATED, null],
			[EVIDENCE_AGGREGATED, "event_request"],
			[EVIDENCE_AGGREGATED_UNATTENDED, null],
			[EVIDENCE_AGGREGATED_UNATTENDED, "event_request"],
		])(
			"refuses '%s' on a non-twin artifact (content_subtype=%s) with ActionPreconditionError",
			async (kind, subtype) => {
				const { port, recordExternalLink } = makePort({ [ATOM]: subtype });
				const action = createExternalLinkCreateAction(port);

				const promise = action.run(
					{
						artifact_id: ATOM,
						provider: "notion_work",
						kind,
						external_id: "page-1",
						run_id: "00000000-0000-0000-0000-000000000099",
					},
					{} as any,
				);
				await expect(promise).rejects.toThrow(ActionPreconditionError);
				await expect(promise).rejects.toThrow(/only valid on daily_log twin artifacts/i);
				expect(recordExternalLink).not.toHaveBeenCalled();
			},
		);

		it.each([
			[EVIDENCE_AGGREGATED, "notion_work", "00000000-0000-0000-0000-000000000099"],
			[EVIDENCE_AGGREGATED, "notion_personal", "00000000-0000-0000-0000-000000000099"],
			[EVIDENCE_AGGREGATED_UNATTENDED, "notion_work", undefined],
			[EVIDENCE_AGGREGATED_UNATTENDED, "notion_personal", undefined],
		])(
			"writes '%s' on a Daily Log twin under '%s'",
			async (kind, provider, runId) => {
				const { port, recordExternalLink, getArtifactContentSubtype } = makePort({
					[TWIN]: "daily_log",
				});
				const action = createExternalLinkCreateAction(port);

				const output = await action.run(
					{
						artifact_id: TWIN,
						provider,
						kind,
						external_id: "page-1",
						...(runId ? { run_id: runId } : {}),
					},
					{} as any,
				);

				expect(getArtifactContentSubtype).toHaveBeenCalledWith(TWIN);
				expect(recordExternalLink).toHaveBeenCalledWith(TWIN, {
					provider,
					kind,
					external_id: "page-1",
					external_url: null,
					dedup_key: null,
				});
				expect(output.text).toBe(`Linked artifact ${TWIN} → ${provider}/${kind}/page-1.`);
			},
		);

		it("refuses 'evidence_aggregated' without run_id with ActionPreconditionError", async () => {
			const { port, recordExternalLink, getArtifactContentSubtype } = makePort({
				[TWIN]: "daily_log",
			});
			const action = createExternalLinkCreateAction(port);

			const promise = action.run(
				{
					artifact_id: TWIN,
					provider: "notion_work",
					kind: "evidence_aggregated",
					external_id: "page-1",
				},
				{} as any,
			);
			await expect(promise).rejects.toThrow(ActionPreconditionError);
			await expect(promise).rejects.toThrow(
				/run_id is required when kind='evidence_aggregated'/i,
			);
			expect(getArtifactContentSubtype).not.toHaveBeenCalled();
			expect(recordExternalLink).not.toHaveBeenCalled();
		});

		it.each([
			"evidence_aggregated",
			"evidence_aggregated_unattended",
			"synthesized",
			"synthesized_unattended",
		])(
			"refuses '%s' when provider is not a Notion domain provider",
			async (kind) => {
				const { port, recordExternalLink } = makePort({
					[TWIN]: "daily_log",
					[ATOM]: null,
				});
				const action = createExternalLinkCreateAction(port);

				const promise = action.run(
					{
						artifact_id: kind.startsWith("evidence_") ? TWIN : ATOM,
						provider: "github",
						kind,
						external_id: "page-1",
						run_id: "00000000-0000-0000-0000-000000000099",
					},
					{} as any,
				);
				await expect(promise).rejects.toThrow(ActionPreconditionError);
				await expect(promise).rejects.toThrow(/\(ADR-108 §5\)/);
				expect(recordExternalLink).not.toHaveBeenCalled();
			},
		);
	});

	describe("daily_log pointer guard (#2313)", () => {
		function makeGuard(pointers: ExistingDailyLogPointer[] = [], opts: { readError?: string } = {}) {
			const getDailyLogPointers = vi.fn(async () => {
				if (opts.readError) throw new Error(opts.readError);
				return pointers;
			});
			const guard: ExternalLinkCreateGuardPort = { getDailyLogPointers };
			return { guard, getDailyLogPointers };
		}

		const run = (
			port: ExternalLinkCreatePort,
			guard: ExternalLinkCreateGuardPort | undefined,
			over: { artifact_id?: string; provider?: string; external_id?: string } = {},
		) =>
			createExternalLinkCreateAction(port, guard).run({
				artifact_id: over.artifact_id ?? TWIN,
				provider: over.provider ?? "notion_personal",
				kind: "daily_log",
				external_id: over.external_id ?? "page-1",
			});

		it.each([
			["an atom", null],
			["another subtype", "event_request"],
		])("1: refuses a daily_log pointer on %s (not a twin)", async (_label, subtype) => {
			const { port, recordExternalLink } = makePort({ [ATOM]: subtype });
			const { guard } = makeGuard();

			const promise = run(port, guard, { artifact_id: ATOM });
			await expect(promise).rejects.toThrow(ActionPreconditionError);
			await expect(promise).rejects.toThrow(/belongs on a Daily Log twin.*Nothing was written/s);
			expect(recordExternalLink).not.toHaveBeenCalled();
		});

		it("2: refuses a provider outside the Notion domain providers, before any read", async () => {
			const { port, recordExternalLink, getArtifactContentSubtype } = makePort({
				[TWIN]: "daily_log",
			});
			const { guard, getDailyLogPointers } = makeGuard();

			const promise = run(port, guard, { provider: "github" });
			await expect(promise).rejects.toThrow(ActionPreconditionError);
			await expect(promise).rejects.toThrow(/requires a Notion domain provider.*Nothing was written/s);
			await expect(promise).rejects.toThrow(/\(ADR-050 §7, #2313\)/);
			await expect(promise).rejects.not.toThrow(/ADR-108/);
			expect(getArtifactContentSubtype).not.toHaveBeenCalled();
			expect(getDailyLogPointers).not.toHaveBeenCalled();
			expect(recordExternalLink).not.toHaveBeenCalled();
		});

		it("3: refuses when the twin already points at a different page", async () => {
			const { port, recordExternalLink } = makePort({ [TWIN]: "daily_log" });
			const { guard } = makeGuard([{ provider: "notion_personal", external_id: "page-other" }]);

			const promise = run(port, guard);
			await expect(promise).rejects.toThrow(ActionPreconditionError);
			await expect(promise).rejects.toThrow(/already carries a 'daily_log' pointer.*Nothing was written/s);
			expect(recordExternalLink).not.toHaveBeenCalled();
		});

		it("4: refuses when the twin already has a daily_log pointer under a different provider", async () => {
			const { port, recordExternalLink } = makePort({ [TWIN]: "daily_log" });
			const { guard } = makeGuard([{ provider: "notion_work", external_id: "page-1" }]);

			const promise = run(port, guard);
			await expect(promise).rejects.toThrow(ActionPreconditionError);
			await expect(promise).rejects.toThrow(/already carries a 'daily_log' pointer/);
			expect(recordExternalLink).not.toHaveBeenCalled();
		});

		it.each(["notion_personal", "notion_work"])(
			"5: writes the pointer on a pointerless twin under '%s' (the sanctioned repair)",
			async (provider) => {
				const { port, recordExternalLink, getArtifactContentSubtype } = makePort({
					[TWIN]: "daily_log",
				});
				const { guard, getDailyLogPointers } = makeGuard([]);

				const output = await run(port, guard, { provider });

				expect(getArtifactContentSubtype).toHaveBeenCalledWith(TWIN);
				expect(getDailyLogPointers).toHaveBeenCalledWith(TWIN);
				expect(recordExternalLink).toHaveBeenCalledWith(TWIN, {
					provider,
					kind: "daily_log",
					external_id: "page-1",
					external_url: null,
					dedup_key: null,
				});
				expect(output.text).toBe(`Linked artifact ${TWIN} → ${provider}/daily_log/page-1.`);
			},
		);

		it("6: an exact repeat of the existing pointer is not refused", async () => {
			const { port, recordExternalLink } = makePort({ [TWIN]: "daily_log" });
			const { guard } = makeGuard([{ provider: "notion_personal", external_id: "page-1" }]);

			await run(port, guard);

			expect(recordExternalLink).toHaveBeenCalledTimes(1);
		});

		it("6b: an exact repeat is still refused when a second, conflicting pointer exists", async () => {
			const { port, recordExternalLink } = makePort({ [TWIN]: "daily_log" });
			const { guard } = makeGuard([
				{ provider: "notion_personal", external_id: "page-1" },
				{ provider: "notion_work", external_id: "page-2" },
			]);

			await expect(run(port, guard)).rejects.toThrow(ActionPreconditionError);
			expect(recordExternalLink).not.toHaveBeenCalled();
		});

		it("7: refuses when the artifact read fails or finds nothing", async () => {
			const failed = makePort({}, { readError: "timeout" });
			const g1 = makeGuard();
			await expect(run(failed.port, g1.guard)).rejects.toThrow(/never skipped on a failed read/);
			expect(g1.getDailyLogPointers).not.toHaveBeenCalled();
			expect(failed.recordExternalLink).not.toHaveBeenCalled();

			const missing = makePort({});
			await expect(run(missing.port, makeGuard().guard)).rejects.toThrow(
				/was not found for this user/,
			);
			expect(missing.recordExternalLink).not.toHaveBeenCalled();
		});

		it("7: refuses when the existing-pointer read fails", async () => {
			const { port, recordExternalLink } = makePort({ [TWIN]: "daily_log" });
			const { guard } = makeGuard([], { readError: "connection reset" });

			await expect(run(port, guard)).rejects.toThrow(
				/Could not read the existing 'daily_log' pointers.*connection reset.*Nothing was written/s,
			);
			expect(recordExternalLink).not.toHaveBeenCalled();
		});

		it("7: refuses when no existing-pointer read is wired, never treating it as no pointers", async () => {
			const { port, recordExternalLink } = makePort({ [TWIN]: "daily_log" });

			await expect(run(port, undefined)).rejects.toThrow(
				/no strict existing-pointer read is wired.*Nothing was written/s,
			);
			expect(recordExternalLink).not.toHaveBeenCalled();
		});
	});
});
