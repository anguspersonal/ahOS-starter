/**
 * @ahkms/core/ports - decisionJudge.ts
 *
 * A discriminative judge (#2121): one narrow question, answered by picking one of a
 * fixed set of single-token options, with the probability of each option read from
 * the model's calibrated distribution (`noul` / `choice` on TypeSafe AI Jev or first-token
 * logprobs on Gemini) rather than from a number the model writes about itself.
 *
 * Isomorphic: zero Node imports.
 */

export interface DecisionJudgeNoulQuestion {
	kind: "noul";
	id: string;
	prompt: string;
	system?: string;
	/** Optional structured state payload for System 1 discriminative endpoints (e.g. Jev `/v1/systemone`). */
	state?: string;
	/** Optional question instructions separated from `state` for System 1 discriminative endpoints. */
	instructions?: string;
}

export interface DecisionJudgeChoiceQuestion {
	kind: "choice";
	id: string;
	prompt: string;
	options: readonly string[];
	system?: string;
	state?: string;
	instructions?: string;
}

export interface DecisionJudgeScoreQuestion {
	kind: "score";
	id: string;
	prompt: string;
	/** Inclusive lower bound when `options` is omitted (defaults to 1). */
	min?: number;
	/** Inclusive upper bound when `options` is omitted (defaults to 7). */
	max?: number;
	/** Explicit numeric or string score levels (defaults to `min..max`). */
	options?: readonly (string | number)[];
	system?: string;
	state?: string;
	instructions?: string;
}

/** A yes/no question ("noul"), a pick from a short list of options ("choice"), or an ordinal score ("score"). */
export type DecisionJudgeQuestion =
	| DecisionJudgeNoulQuestion
	| DecisionJudgeChoiceQuestion
	| DecisionJudgeScoreQuestion;

export interface DecisionJudgeResult {
	id: string;
	kind: DecisionJudgeQuestion["kind"];
	/** The most probable option ("yes" / "no" for a noul question, or winning score token for "score"). */
	choice: string;
	/** Probability of `choice`, 0..1, from the calibrated distribution. */
	confidence: number;
	/** Probability of every option, summing to 1. */
	distribution: Record<string, number>;
	/** Numeric score of the winning option when `kind === "score"`. */
	score?: number;
	/** Probability-weighted expected score (\sum v_i * p_i) when `kind === "score"`. */
	expected_score?: number;
	model: string;
	latency_ms: number;
	/** Input tokens billed for this call, when reported by the provider. */
	prompt_tokens?: number;
	/** Estimated USD cost for this call, when token usage is reported. */
	cost_usd?: number;
}

export interface DecisionJudgeScoreResult extends DecisionJudgeResult {
	kind: "score";
	score: number;
	expected_score: number;
}

export interface DecisionJudgePort {
	/** Null when the judge could not answer (network, quota, no logprobs): callers fall back. */
	evaluate(question: DecisionJudgeQuestion): Promise<DecisionJudgeResult | null>;
	/**
	 * Evaluate multiple questions over a shared state in one forward pass when supported
	 * (e.g. TypeSafe AI Jev `/v1/systemone`), or in parallel otherwise.
	 */
	evaluateBatch?(questions: readonly DecisionJudgeQuestion[]): Promise<Record<string, DecisionJudgeResult> | null>;
}

/**
 * Evaluate a batch of questions using `judge.evaluateBatch` when available (single
 * forward pass on Jev), falling back to parallel `judge.evaluate` calls.
 */
export async function evaluateDecisionBatch(
	judge: DecisionJudgePort,
	questions: readonly DecisionJudgeQuestion[],
): Promise<Record<string, DecisionJudgeResult> | null> {
	if (questions.length === 0) return {};
	if (judge.evaluateBatch) {
		return judge.evaluateBatch(questions);
	}
	const results = await Promise.all(questions.map((q) => judge.evaluate(q)));
	const out: Record<string, DecisionJudgeResult> = {};
	for (let i = 0; i < questions.length; i++) {
		const r = results[i];
		if (!r) return null;
		out[questions[i].id] = r;
	}
	return out;
}

export type DecisionConfidenceBand = "auto_applied" | "pending" | "discard";

export const DECISION_AUTO_APPLY_CONFIDENCE = 0.9;
export const DECISION_PENDING_CONFIDENCE = 0.55;
export const DERIVE_PREFILTER_MIN_PROBABILITY = 0.3;
export const EMAIL_JUDGE_SWEEP_MIN_CONFIDENCE = 0.8;

/** #2121 bands: apply at 0.9 or more, hold for review from 0.55, drop below. */
export function classifyDecisionConfidenceBand(confidence: number): DecisionConfidenceBand {
	if (confidence >= DECISION_AUTO_APPLY_CONFIDENCE) return "auto_applied";
	if (confidence >= DECISION_PENDING_CONFIDENCE) return "pending";
	return "discard";
}

/** Probability of "yes" from a noul result (the distribution, whichever option won). */
export function probabilityOfYes(result: Pick<DecisionJudgeResult, "distribution">): number {
	return result.distribution.yes ?? 0;
}

/**
 * Chain multiple decision judges in priority order (e.g. TypeSafe AI Jev primary ->
 * Gemini fallback when Jev quota/credits are exhausted or key is absent).
 */
export function createFallbackDecisionJudge(
	judges: readonly (DecisionJudgePort | null | undefined)[],
): DecisionJudgePort {
	const active = judges.filter((j): j is DecisionJudgePort => Boolean(j));
	return {
		async evaluate(question: DecisionJudgeQuestion): Promise<DecisionJudgeResult | null> {
			for (const judge of active) {
				const result = await judge.evaluate(question);
				if (result !== null) return result;
			}
			return null;
		},
		async evaluateBatch(questions: readonly DecisionJudgeQuestion[]): Promise<Record<string, DecisionJudgeResult> | null> {
			for (const judge of active) {
				const result = await evaluateDecisionBatch(judge, questions);
				if (result !== null) return result;
			}
			return null;
		},
	};
}

/** Probability-weighted expected value across numeric score options (\sum v_i * p_i). */
export function expectedScoreFromDistribution(distribution: Record<string, number>): number {
	let weighted = 0;
	let totalMass = 0;
	for (const [key, prob] of Object.entries(distribution)) {
		const num = Number(key);
		if (Number.isFinite(num) && typeof prob === "number" && Number.isFinite(prob) && prob > 0) {
			weighted += num * prob;
			totalMass += prob;
		}
	}
	if (totalMass <= 0) return 0;
	return weighted / totalMass;
}

