import { describe, expect, it, vi } from "vitest";
import { createGeminiDecisionJudgeAdapter, DEFAULT_DECISION_JUDGE_MODEL, distributionFromLogprobs } from "./decisionJudge.js";
import {
	classifyDecisionConfidenceBand,
	expectedScoreFromDistribution,
	probabilityOfYes,
} from "../../ports/decisionJudge.js";

function geminiReply(candidates: Array<{ token: string; logProbability: number }>) {
	return new Response(
		JSON.stringify({
			candidates: [
				{
					content: { parts: [{ text: candidates[0]?.token ?? "" }] },
					logprobsResult: { topCandidates: [{ candidates }], chosenCandidates: candidates.slice(0, 1) },
				},
			],
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

describe("distributionFromLogprobs", () => {
	it("sums token variants of one option and normalises over the options", () => {
		const d = distributionFromLogprobs(
			[
				{ token: "no", logProbability: Math.log(0.7) },
				{ token: "No", logProbability: Math.log(0.2) },
				{ token: "yes", logProbability: Math.log(0.1) },
			],
			["yes", "no"],
		)!;
		expect(d.no).toBeCloseTo(0.9, 5);
		expect(d.yes).toBeCloseTo(0.1, 5);
	});

	it("gives an unnamed option only the mass the top candidates leave unexplained", () => {
		const d = distributionFromLogprobs([{ token: "yes", logProbability: Math.log(0.99) }], ["yes", "no"])!;
		expect(d.yes).toBeGreaterThan(0.98);
		expect(d.no).toBeCloseTo(0.01, 3);
	});

	it("flattens with a higher temperature", () => {
		const c = [
			{ token: "yes", logProbability: Math.log(0.8) },
			{ token: "no", logProbability: Math.log(0.2) },
		];
		expect(distributionFromLogprobs(c, ["yes", "no"], 2)!.yes).toBeLessThan(0.8);
	});

	it("returns null when no candidate names an option", () => {
		expect(distributionFromLogprobs([{ token: "maybe", logProbability: -0.1 }], ["yes", "no"])).toBeNull();
	});
});

describe("createGeminiDecisionJudgeAdapter", () => {
	it("uses minimal-thinking structured output on gemini-3.5-flash-lite and logprobs on logprob-capable models", async () => {
		const fetchFn = vi.fn().mockResolvedValue(
			geminiReply([
				{ token: "yes", logProbability: Math.log(0.95) },
				{ token: "no", logProbability: Math.log(0.05) },
			]),
		);
		const judge = createGeminiDecisionJudgeAdapter({ apiKey: "k-secret", model: "gemini-2.5-flash-lite", fetchFn });
		const r = await judge.evaluate({ kind: "noul", id: "q1", prompt: "Worth it?", system: "Screen." });

		expect(r).toMatchObject({ id: "q1", kind: "noul", choice: "yes", model: "gemini-2.5-flash-lite" });
		expect(r!.confidence).toBeCloseTo(0.95, 5);
		expect(probabilityOfYes(r!)).toBeCloseTo(0.95, 5);
		const [url, init] = fetchFn.mock.calls[0];
		expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent");
		expect(init.headers["x-goog-api-key"]).toBe("k-secret");
		const body = JSON.parse(init.body);
		expect(body.generationConfig).toMatchObject({
			maxOutputTokens: 1,
			responseMimeType: "text/x.enum",
			responseSchema: { type: "STRING", enum: ["yes", "no"] },
			responseLogprobs: true,
			thinkingConfig: { thinkingBudget: 0 },
		});
		expect(body.systemInstruction.parts[0].text).toBe("Screen.");

		const fetch35 = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					candidates: [{ content: { parts: [{ text: JSON.stringify({ choice: "no", confidence: 0.96 }) }] } }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);
		const r35 = await createGeminiDecisionJudgeAdapter({ apiKey: "k-secret", fetchFn: fetch35 }).evaluate({
			kind: "noul",
			id: "q2",
			prompt: "Promo?",
		});
		expect(r35).toMatchObject({ id: "q2", choice: "no", model: DEFAULT_DECISION_JUDGE_MODEL });
		expect(r35!.distribution.no).toBeCloseTo(0.96, 4);
	});

	it("evaluates choice questions over an explicit enum option list", async () => {
		const fetchFn = vi.fn().mockResolvedValue(
			geminiReply([
				{ token: "to_respond", logProbability: Math.log(0.91) },
				{ token: "fyi", logProbability: Math.log(0.09) },
			]),
		);
		const judge = createGeminiDecisionJudgeAdapter({ apiKey: () => "k-secret", model: "gemini-2.5-flash-lite", fetchFn });
		const r = await judge.evaluate({
			kind: "choice",
			id: "intent",
			options: ["to_respond", "fyi", "marketing"],
			prompt: "Classify email intent",
		});

		expect(r).toMatchObject({ id: "intent", kind: "choice", choice: "to_respond" });
		expect(r!.confidence).toBeGreaterThan(0.9);
		const body = JSON.parse(fetchFn.mock.calls[0][1].body);
		expect(body.generationConfig.responseSchema.enum).toEqual(["to_respond", "fyi", "marketing"]);
	});

	it("evaluates score questions across 1..7 priority levels and computes score and expected_score", async () => {
		const fetchFn = vi.fn().mockResolvedValue(
			geminiReply([
				{ token: "6", logProbability: Math.log(0.8) },
				{ token: "5", logProbability: Math.log(0.2) },
			]),
		);
		const judge = createGeminiDecisionJudgeAdapter({ apiKey: "k-secret", model: "gemini-2.5-flash-lite", fetchFn });
		const r = await judge.evaluate({
			kind: "score",
			id: "base_priority",
			min: 1,
			max: 7,
			prompt: "Score priority 1..7",
		});

		expect(r).toMatchObject({
			id: "base_priority",
			kind: "score",
			choice: "6",
			score: 6,
		});
		expect(r!.confidence).toBeCloseTo(0.8, 3);
		expect(r!.expected_score).toBeCloseTo(5.8, 2);
		expect(expectedScoreFromDistribution({ "6": 0.8, "5": 0.2 })).toBeCloseTo(5.8, 5);
		const body = JSON.parse(fetchFn.mock.calls[0][1].body);
		expect(body.generationConfig.responseSchema.enum).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
	});

	it("returns null without a key, and on an API error without leaking the key", async () => {
		expect(await createGeminiDecisionJudgeAdapter({ apiKey: undefined }).evaluate({ kind: "noul", id: "x", prompt: "p" })).toBeNull();
		const onError = vi.fn();
		const fetchFn = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ error: { message: "bad key k-secret" } }), { status: 400 }),
		);
		const r = await createGeminiDecisionJudgeAdapter({ apiKey: "k-secret", fetchFn, onError }).evaluate({
			kind: "noul",
			id: "x",
			prompt: "p",
		});
		expect(r).toBeNull();
		expect(String(onError.mock.calls[0][0].message)).not.toContain("k-secret");
	});

	it("bands confidence the #2121 way", () => {
		expect(classifyDecisionConfidenceBand(0.92)).toBe("auto_applied");
		expect(classifyDecisionConfidenceBand(0.9)).toBe("auto_applied");
		expect(classifyDecisionConfidenceBand(0.89)).toBe("pending");
		expect(classifyDecisionConfidenceBand(0.6)).toBe("pending");
		expect(classifyDecisionConfidenceBand(0.55)).toBe("pending");
		expect(classifyDecisionConfidenceBand(0.54)).toBe("discard");
		expect(classifyDecisionConfidenceBand(0.4)).toBe("discard");
	});
});
