import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineAction } from "../defineAction.js";
import { executeAction } from "./direct.js";

describe("executeAction", () => {
	it("executes an action directly and returns typed output", async () => {
		const action = defineAction({
			id: "divide",
			description: "Divide two numbers.",
			schema: z.object({
				dividend: z.number(),
				divisor: z.number().refine((d) => d !== 0, "Cannot divide by zero"),
			}),
			outputSchema: z.object({
				quotient: z.number(),
			}),
			run: async ({ dividend, divisor }, ctx) => {
				expect(ctx.caller).toBe("worker");
				expect(typeof ctx.requestId).toBe("string");
				return { quotient: dividend / divisor };
			},
		});

		const result = await executeAction(action, { dividend: 100, divisor: 4 });
		expect(result).toEqual({ quotient: 25 });
	});

	it("validates input using action schema by default", async () => {
		const action = defineAction({
			id: "greet_user",
			description: "Greet a user with non-empty name.",
			schema: z.object({
				name: z.string().min(3),
			}),
			run: async ({ name }) => {
				return { greeting: `Hello, ${name}` };
			},
		});

		await expect(executeAction(action, { name: "ab" })).rejects.toThrow();
	});

	it("passes context overrides and extracts domain automatically", async () => {
		const action = defineAction({
			id: "domain_task",
			description: "Task with domain.",
			schema: z.object({
				domain: z.enum(["work", "angus"]),
				title: z.string(),
			}),
			run: async ({ title }, ctx) => {
				return {
					caller: ctx.caller,
					domain: ctx.domain,
					userId: ctx.userId,
					title,
				};
			},
		});

		const result = await executeAction(
			action,
			{ domain: "angus", title: "Review tasks" },
			{ context: { caller: "test", userId: "user-42" } },
		);

		expect(result).toEqual({
			caller: "test",
			domain: "angus",
			userId: "user-42",
			title: "Review tasks",
		});
	});
});
