/**
 * Gemini discriminative judge (#2121):
 * - On models that support `responseLogprobs: true`, constrains output to a single-token
 *   enum (`text/x.enum`) and derives each option's probability from the first-token
 *   logprobs, temperature-scaled: p_i = softmax(logprob_i / T).
 * - On Gemini 3.x models (`gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`) where the
 *   Developer API disables `responseLogprobs` (`gemini-2.5-flash-lite` is 404 for new keys),
 *   uses `thinkingLevel: "MINIMAL"` (~700ms) with a constrained JSON schema
 *   `{ choice, confidence }` so fast-path screening stays sub-second.
 *
 * Fetch-based, no SDK, no `process.env`: the caller injects the key.
 */

import {
	expectedScoreFromDistribution,
	type DecisionJudgePort,
	type DecisionJudgeQuestion,
	type DecisionJudgeResult,
} from "../../ports/decisionJudge.js";

export const DEFAULT_DECISION_JUDGE_MODEL = "gemini-3.5-flash-lite";
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const TOP_LOGPROBS = 8;
/** Floor for an option the top candidates never mention. */
const MIN_PROBABILITY = 1e-6;

export interface GeminiDecisionJudgeConfig {
	apiKey: string | undefined | (() => string | undefined);
	model?: string;
	/** Softmax temperature applied to the logprobs (1 = the model's own distribution). */
	temperature?: number;
	baseUrl?: string;
	fetchFn?: typeof fetch;
	timeoutMs?: number;
	onError?: (err: unknown) => void;
}

interface LogprobCandidate {
	token?: string;
	logProbability?: number;
}

interface GeminiLogprobResponse {
	candidates?: Array<{
		content?: { parts?: Array<{ text?: string }> };
		logprobsResult?: {
			topCandidates?: Array<{ candidates?: LogprobCandidate[] }>;
			chosenCandidates?: LogprobCandidate[];
		};
	}>;
	error?: { message?: string };
}

function optionsOf(question: DecisionJudgeQuestion): string[] {
	if (question.kind === "noul") return ["yes", "no"];
	if (question.kind === "choice") return [...question.options];
	if (question.options && question.options.length > 0) {
		return question.options.map((o) => String(o));
	}
	const min = typeof question.min === "number" && Number.isFinite(question.min) ? Math.floor(question.min) : 1;
	const max = typeof question.max === "number" && Number.isFinite(question.max) ? Math.floor(question.max) : 7;
	const lo = Math.min(min, max);
	const hi = Math.max(min, max);
	const opts: string[] = [];
	for (let v = lo; v <= hi; v++) {
		opts.push(String(v));
	}
	return opts;
}

function matchOption(token: string, options: readonly string[]): string | null {
	const t = token.trim().toLowerCase();
	if (!t) return null;
	const exact = options.find((o) => o.toLowerCase() === t);
	if (exact !== undefined) return exact;
	const hits = options.filter((o) => {
		const lower = o.toLowerCase();
		return lower === t || lower.startsWith(t) || t.startsWith(lower);
	});
	return hits.length === 1 ? hits[0] : null;
}

/**
 * Turn first-token logprobs into a distribution over the options. Tokens that map
 * to the same option are summed; an option no candidate names gets the mass the top
 * candidates leave unexplained (floored), so a confident "no" is not inflated by a
 * missing "yes". Exported for tests.
 */
export function distributionFromLogprobs(
	candidates: readonly LogprobCandidate[],
	options: readonly string[],
	temperature = 1,
): Record<string, number> | null {
	const mass = new Map<string, number>();
	let seen = 0;
	for (const c of candidates) {
		if (typeof c.token !== "string" || typeof c.logProbability !== "number") continue;
		const p = Math.exp(c.logProbability);
		seen += p;
		const option = matchOption(c.token, options);
		if (option) mass.set(option, (mass.get(option) ?? 0) + p);
	}
	if (mass.size === 0) return null;
	const unseen = options.filter((o) => !mass.has(o));
	const residual = Math.max(MIN_PROBABILITY, (1 - Math.min(1, seen)) / Math.max(1, unseen.length));
	const t = temperature > 0 ? temperature : 1;
	const logits = options.map((o) => Math.log(Math.max(MIN_PROBABILITY, mass.get(o) ?? residual)) / t);
	const max = Math.max(...logits);
	const exps = logits.map((l) => Math.exp(l - max));
	const total = exps.reduce((a, b) => a + b, 0);
	const out: Record<string, number> = {};
	options.forEach((o, i) => {
		out[o] = exps[i] / total;
	});
	return out;
}

function distributionFromStructuredChoice(
	text: string | undefined,
	options: readonly string[],
	temperature = 1,
): Record<string, number> | null {
	if (!text) return null;
	try {
		const parsed = JSON.parse(text) as { choice?: string; confidence?: number };
		const chosen = parsed.choice ? matchOption(parsed.choice, options) : null;
		if (!chosen) return null;
		const rawConf = typeof parsed.confidence === "number" ? Math.min(1 - MIN_PROBABILITY, Math.max(MIN_PROBABILITY, parsed.confidence)) : 0.95;
		const rest = (1 - rawConf) / Math.max(1, options.length - 1);
		const candidates: LogprobCandidate[] = options.map((o) => ({
			token: o,
			logProbability: Math.log(o === chosen ? rawConf : Math.max(MIN_PROBABILITY, rest)),
		}));
		return distributionFromLogprobs(candidates, options, temperature);
	} catch {
		return null;
	}
}

export function createGeminiDecisionJudgeAdapter(config: GeminiDecisionJudgeConfig): DecisionJudgePort {
	const model = config.model ?? DEFAULT_DECISION_JUDGE_MODEL;
	const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
	const fetchFn = config.fetchFn ?? fetch;
	const timeoutMs = config.timeoutMs ?? 10_000;
	const isGemini3 = model.startsWith("gemini-3");

	return {
		async evaluate(question: DecisionJudgeQuestion): Promise<DecisionJudgeResult | null> {
			const apiKey = typeof config.apiKey === "function" ? config.apiKey() : config.apiKey;
			if (!apiKey) return null;
			const options = optionsOf(question);
			const started = Date.now();
			try {
				const generationConfig = isGemini3
					? {
							temperature: 0,
							maxOutputTokens: 48,
							responseMimeType: "application/json",
							responseSchema: {
								type: "OBJECT",
								properties: {
									choice: { type: "STRING", enum: options },
									confidence: { type: "NUMBER" },
								},
								required: ["choice", "confidence"],
							},
							thinkingConfig: { thinkingLevel: "MINIMAL" },
						}
					: {
							temperature: 0,
							maxOutputTokens: model.startsWith("gemini-4") ? 16 : 1,
							responseMimeType: "text/x.enum",
							responseSchema: { type: "STRING", enum: options },
							responseLogprobs: true,
							logprobs: TOP_LOGPROBS,
							thinkingConfig: model.startsWith("gemini-4") ? { thinkingLevel: "LOW" } : { thinkingBudget: 0 },
						};

				const res = await fetchFn(`${baseUrl}/models/${model}:generateContent`, {
					method: "POST",
					headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
					signal: AbortSignal.timeout(timeoutMs),
					body: JSON.stringify({
						...(question.system ? { systemInstruction: { parts: [{ text: question.system }] } } : {}),
						contents: [{ role: "user", parts: [{ text: question.prompt }] }],
						generationConfig,
					}),
				});
				const body = (await res.json()) as GeminiLogprobResponse;
				if (!res.ok) throw new Error(`gemini ${res.status}: ${body.error?.message ?? "request failed"}`);
				const lp = body.candidates?.[0]?.logprobsResult;
				const top = lp?.topCandidates?.[0]?.candidates ?? lp?.chosenCandidates?.slice(0, 1) ?? [];
				const distribution =
					distributionFromLogprobs(top, options, config.temperature ?? 1) ??
					distributionFromStructuredChoice(body.candidates?.[0]?.content?.parts?.[0]?.text, options, config.temperature ?? 1);
				if (!distribution) throw new Error("gemini returned no usable probability distribution");
				const choice = options.reduce((best, o) => (distribution[o] > distribution[best] ? o : best), options[0]);
				const scoreFields =
					question.kind === "score"
						? {
								score: Number(choice),
								expected_score: expectedScoreFromDistribution(distribution),
							}
						: {};
				return {
					id: question.id,
					kind: question.kind,
					choice,
					confidence: distribution[choice],
					distribution,
					...scoreFields,
					model,
					latency_ms: Date.now() - started,
				};
			} catch (err) {
				config.onError?.(err instanceof Error ? new Error(err.message.split(apiKey).join("[REDACTED]")) : err);
				return null;
			}
		},
	};
}

