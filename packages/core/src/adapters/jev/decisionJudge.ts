/**
 * TypeSafe AI Jev System One judge (#2121): `POST https://api.typesafe.ai/v1/systemone`
 * (`jev-latest`). Evaluates application `state` against typed `noul` and `choice`
 * questions in a single non-autoregressive forward pass and returns RLCD-calibrated
 * probabilities at $0.042 / 1M input tokens ($0 output tokens).
 *
 * Fetch-based, no SDK, no `process.env`: the caller injects the key.
 */

import {
	createFallbackDecisionJudge,
	expectedScoreFromDistribution,
	type DecisionJudgePort,
	type DecisionJudgeQuestion,
	type DecisionJudgeResult,
} from "../../ports/decisionJudge.js";
import { createGeminiDecisionJudgeAdapter } from "../google/decisionJudge.js";

export const DEFAULT_JEV_MODEL = "jev-latest";
export const DEFAULT_JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
/** TypeSafe AI System One pricing: $0.042 per 1M input tokens, $0 output tokens. */
export const JEV_INPUT_COST_PER_MILLION_USD = 0.042;

export interface JevDecisionJudgeConfig {
	apiKey: string | undefined | (() => string | undefined);
	model?: string;
	endpoint?: string;
	fetchFn?: typeof fetch;
	timeoutMs?: number;
	onError?: (err: unknown) => void;
}

interface JevNoulAnswer {
	type?: "noul";
	noul?: number;
}

interface JevChoiceAnswer {
	type?: "choice";
	choice?: string;
	probabilities?: Record<string, number>;
	confidence?: number;
}

interface JevSystemOneResponse {
	id?: string;
	model?: string;
	answers?: Record<string, JevNoulAnswer & JevChoiceAnswer>;
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
	};
	error?: { message?: string } | string;
}

function splitStateAndInstructions(question: DecisionJudgeQuestion): { state: string; instructions: string } {
	if (question.state && question.instructions) {
		return {
			state: question.state,
			instructions: question.system ? `${question.system}\n\n${question.instructions}` : question.instructions,
		};
	}
	const marker = "\n\nEvidence";
	const idx = question.prompt.indexOf(marker);
	if (idx >= 0) {
		const head = question.prompt.slice(0, idx).trim();
		const tail = question.prompt.slice(idx + 2).trim();
		return {
			state: tail,
			instructions: question.system ? `${question.system}\n\n${head}` : head,
		};
	}
	return {
		state: question.prompt,
		instructions: question.system ?? "Evaluate the state and answer the question.",
	};
}

function choiceOptionsOf(question: Exclude<DecisionJudgeQuestion, { kind: "noul" }>): string[] {
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

function parseAnswer(
	question: DecisionJudgeQuestion,
	ans: (JevNoulAnswer & JevChoiceAnswer) | undefined,
	meta: { model: string; latencyMs: number; promptTokens?: number; costUsd?: number },
): DecisionJudgeResult {
	if (!ans) throw new Error(`jev returned no answer for '${question.id}'`);
	if (question.kind === "noul") {
		if (typeof ans.noul !== "number" || !Number.isFinite(ans.noul)) {
			throw new Error(`jev returned no numeric noul probability for '${question.id}'`);
		}
		const pYes = Math.min(1, Math.max(0, ans.noul));
		const pNo = 1 - pYes;
		const choice = pYes >= 0.5 ? "yes" : "no";
		return {
			id: question.id,
			kind: "noul",
			choice,
			confidence: Math.max(pYes, pNo),
			distribution: { yes: pYes, no: pNo },
			model: meta.model,
			latency_ms: meta.latencyMs,
			prompt_tokens: meta.promptTokens,
			cost_usd: meta.costUsd,
		};
	}

	const options = choiceOptionsOf(question);
	const probs = ans.probabilities ?? {};
	const distribution: Record<string, number> = {};
	let total = 0;
	for (const o of options) {
		const p = typeof probs[o] === "number" && Number.isFinite(probs[o]) ? Math.max(0, probs[o]) : 0;
		distribution[o] = p;
		total += p;
	}
	if (total <= 0) throw new Error(`jev returned empty choice probabilities for '${question.id}'`);
	for (const o of options) distribution[o] /= total;
	const choice =
		ans.choice && options.includes(ans.choice)
			? ans.choice
			: options.reduce((best, o) => (distribution[o] > distribution[best] ? o : best), options[0]);
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
		model: meta.model,
		latency_ms: meta.latencyMs,
		prompt_tokens: meta.promptTokens,
		cost_usd: meta.costUsd,
	};
}

export function createJevDecisionJudgeAdapter(config: JevDecisionJudgeConfig): DecisionJudgePort {
	const requestedModel = config.model ?? DEFAULT_JEV_MODEL;
	const endpoint = config.endpoint ?? DEFAULT_JEV_ENDPOINT;
	const fetchFn = config.fetchFn ?? fetch;
	const timeoutMs = config.timeoutMs ?? 10_000;

	async function evaluateBatch(
		questions: readonly DecisionJudgeQuestion[],
	): Promise<Record<string, DecisionJudgeResult> | null> {
		if (questions.length === 0) return {};
		const apiKey = typeof config.apiKey === "function" ? config.apiKey() : config.apiKey;
		if (!apiKey) return null;

		const first = splitStateAndInstructions(questions[0]);
		const state = first.state;
		const questionsPayload: Record<string, { type: "noul"; instructions: string } | { type: "choice"; instructions: string; options: string[] }> = {};
		for (const q of questions) {
			const { instructions } = splitStateAndInstructions(q);
			questionsPayload[q.id] =
				q.kind === "noul"
					? { type: "noul", instructions }
					: { type: "choice", instructions, options: choiceOptionsOf(q) };
		}

		const started = Date.now();
		try {
			const res = await fetchFn(endpoint, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					Authorization: `Bearer ${apiKey}`,
				},
				signal: AbortSignal.timeout(timeoutMs),
				body: JSON.stringify({
					model: requestedModel,
					state,
					questions: questionsPayload,
				}),
			});
			const body = (await res.json()) as JevSystemOneResponse;
			if (!res.ok) {
				const errMsg = typeof body.error === "string" ? body.error : body.error?.message ?? "request failed";
				throw new Error(`jev ${res.status}: ${errMsg}`);
			}

			const latencyMs = Date.now() - started;
			const promptTokens = body.usage?.input_tokens ?? body.usage?.prompt_tokens;
			const costUsd =
				typeof promptTokens === "number" ? (promptTokens / 1_000_000) * JEV_INPUT_COST_PER_MILLION_USD : undefined;
			const resolvedModel = body.model ?? requestedModel;

			const out: Record<string, DecisionJudgeResult> = {};
			for (const q of questions) {
				out[q.id] = parseAnswer(q, body.answers?.[q.id], {
					model: resolvedModel,
					latencyMs,
					promptTokens,
					costUsd,
				});
			}
			return out;
		} catch (err) {
			config.onError?.(err instanceof Error ? new Error(err.message.split(apiKey).join("[REDACTED]")) : err);
			return null;
		}
	}

	return {
		async evaluate(question: DecisionJudgeQuestion): Promise<DecisionJudgeResult | null> {
			const batch = await evaluateBatch([question]);
			return batch ? batch[question.id] ?? null : null;
		},
		evaluateBatch,
	};
}

export interface JevWithGeminiFallbackConfig {
	jevApiKey: string | undefined | (() => string | undefined);
	geminiApiKey: string | undefined | (() => string | undefined);
	jevModel?: string;
	geminiModel?: string;
	temperature?: number;
	fetchFn?: typeof fetch;
	timeoutMs?: number;
	onError?: (err: unknown) => void;
}

/**
 * Primary TypeSafe AI Jev (`jev-latest`) judge with automatic fallback to Gemini
 * (`gemini-3.5-flash-lite`) when Jev credits/quota are depleted, unreachable, or unconfigured.
 */
export function createJevWithGeminiFallbackJudgeAdapter(config: JevWithGeminiFallbackConfig): DecisionJudgePort {
	return createFallbackDecisionJudge([
		createJevDecisionJudgeAdapter({
			apiKey: config.jevApiKey,
			model: config.jevModel,
			fetchFn: config.fetchFn,
			timeoutMs: config.timeoutMs,
			onError: config.onError,
		}),
		createGeminiDecisionJudgeAdapter({
			apiKey: config.geminiApiKey,
			model: config.geminiModel,
			temperature: config.temperature,
			fetchFn: config.fetchFn,
			timeoutMs: config.timeoutMs,
			onError: config.onError,
		}),
	]);
}

