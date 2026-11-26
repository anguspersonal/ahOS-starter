import { describe, expect, it, vi } from "vitest";
import {
	createJevDecisionJudgeAdapter,
	createJevWithGeminiFallbackJudgeAdapter,
	DEFAULT_JEV_ENDPOINT,
	DEFAULT_JEV_MODEL,
	JEV_INPUT_COST_PER_MILLION_USD,
} from "./decisionJudge.js";

describe("createJevDecisionJudgeAdapter", () => {
	it("posts state and a noul question to TypeSafe AI System One and returns calibrated probabilities + token cost", async () => {
		const fetchFn = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					id: "sysone_1",
					model: "jev-1.14.0",
					answers: {
						worth_analysis: { type: "noul", noul: 0.02 },
					},
					usage: { prompt_tokens: 200, completion_tokens: 0, total_tokens: 200 },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);
		const judge = createJevDecisionJudgeAdapter({ apiKey: "apikey_secret", fetchFn });
		const r = await judge.evaluate({
			kind: "noul",
			id: "worth_analysis",
			prompt: "Question: worth a look?\n\nEvidence:\n- From: Mike",
			system: "Screen mail.",
		});

		expect(r).toMatchObject({
			id: "worth_analysis",
			kind: "noul",
			choice: "no",
			model: "jev-1.14.0",
			prompt_tokens: 200,
		});
		expect(r!.distribution.yes).toBeCloseTo(0.02, 5);
		expect(r!.distribution.no).toBeCloseTo(0.98, 5);
		expect(r!.confidence).toBeCloseTo(0.98, 5);
		expect(r!.cost_usd).toBeCloseTo((200 / 1_000_000) * JEV_INPUT_COST_PER_MILLION_USD, 10);

		const [url, init] = fetchFn.mock.calls[0];
		expect(url).toBe(DEFAULT_JEV_ENDPOINT);
		expect(init.headers.Authorization).toBe("Bearer apikey_secret");
		const body = JSON.parse(init.body);
		expect(body).toEqual({
			model: DEFAULT_JEV_MODEL,
			state: "Evidence:\n- From: Mike",
			questions: {
				worth_analysis: {
					type: "noul",
					instructions: "Screen mail.\n\nQuestion: worth a look?",
				},
			},
		});
	});

	it("returns null without a key and redacts the key on errors", async () => {
		expect(
			await createJevDecisionJudgeAdapter({ apiKey: undefined }).evaluate({ kind: "noul", id: "q", prompt: "p" }),
		).toBeNull();
		const onError = vi.fn();
		const fetchFn = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ error: { message: "invalid token apikey_secret" } }), { status: 401 }),
		);
		const r = await createJevDecisionJudgeAdapter({ apiKey: "apikey_secret", fetchFn, onError }).evaluate({
			kind: "noul",
			id: "q",
			prompt: "p",
		});
		expect(r).toBeNull();
		expect(String(onError.mock.calls[0][0].message)).not.toContain("apikey_secret");
	});

	it("falls back to Gemini when Jev credits are depleted (402) or Jev fails", async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ error: { message: "quota exceeded" } }), {
					status: 402,
					headers: { "content-type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						candidates: [
							{
								content: {
									parts: [{ text: JSON.stringify({ choice: "yes", confidence: 0.92 }) }],
								},
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);

		const judge = createJevWithGeminiFallbackJudgeAdapter({
			jevApiKey: "jev_key",
			geminiApiKey: "gem_key",
			fetchFn,
		});
		const r = await judge.evaluate({
			kind: "noul",
			id: "worth_analysis",
			prompt: "Question: worth a look?",
		});

		expect(fetchFn).toHaveBeenCalledTimes(2);
		expect(fetchFn.mock.calls[0][0]).toBe(DEFAULT_JEV_ENDPOINT);
		expect(String(fetchFn.mock.calls[1][0])).toContain("gemini-3.5-flash-lite:generateContent");
		expect(r).toMatchObject({
			id: "worth_analysis",
			kind: "noul",
			choice: "yes",
			model: "gemini-3.5-flash-lite",
		});
	});
});
