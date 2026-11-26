import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineAction } from "./defineAction.js";
import { executeAction } from "./adapters/direct.js";
import { canonicalJson, inputSha256 } from "./inputHash.js";
import type { ActionAuditRecord, ActionAuditSink } from "./types.js";

describe("inputHash", () => {
	it("hashes canonical JSON with sorted keys, preserved array order, and no whitespace (Case 1)", async () => {
		const hash = await inputSha256({ b: [2, { c: 3 }], a: 1 });
		expect(canonicalJson({ b: [2, { c: 3 }], a: 1 })).toBe('{"a":1,"b":[2,{"c":3}]}');
		expect(hash).toBe("8ad038695d4b91af5fe8c0edd83a8039830a131a1eaa45ad7bd4fc1ebe719d05");

		const emptyHash = await inputSha256({});
		expect(canonicalJson({})).toBe("{}");
		expect(emptyHash).toBe("44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
	});

	it("drops keys whose value is undefined", async () => {
		expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
		const hashWithUndefined = await inputSha256({ a: undefined, b: 1 });
		const hashWithout = await inputSha256({ b: 1 });
		expect(hashWithUndefined).toBe(hashWithout);
	});

	it("serialises a Date as its ISO string so two different dates hash differently", async () => {
		const d1 = new Date("2026-01-01T00:00:00.000Z");
		const d2 = new Date("2026-01-02T00:00:00.000Z");
		expect(canonicalJson({ at: d1 })).toBe('{"at":"2026-01-01T00:00:00.000Z"}');
		const hash1 = await inputSha256({ at: d1 });
		const hash2 = await inputSha256({ at: d2 });
		expect(hash1).not.toBe(hash2);
	});

	it("reordering keys keeps the hash; changing a value changes it", async () => {
		const hash1 = await inputSha256({ x: 1, y: 2, z: 3 });
		const hash2 = await inputSha256({ z: 3, x: 1, y: 2 });
		const hash3 = await inputSha256({ x: 1, y: 99, z: 3 });

		expect(hash1).toBe(hash2);
		expect(hash1).not.toBe(hash3);
	});

	it("throws on BigInt or cyclic structures", async () => {
		expect(() => canonicalJson({ val: 42n })).toThrow(TypeError);
		await expect(inputSha256({ val: 42n })).rejects.toThrow(TypeError);

		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() => canonicalJson(cyclic)).toThrow(TypeError);
		await expect(inputSha256(cyclic)).rejects.toThrow(TypeError);
	});

	describe("through executeAction with injected sink (Case 2)", () => {
		it("records parsed input hash (with defaults filled) and seam 'action'", async () => {
			const records: ActionAuditRecord[] = [];
			const auditSink: ActionAuditSink = (r) => {
				records.push(r);
			};

			const action = defineAction({
				id: "action_with_default",
				description: "Action with default schema value",
				schema: z.object({
					name: z.string(),
					retries: z.number().default(3),
				}),
				run: async (input) => input,
			});

			await executeAction(action, { name: "test" }, { auditSink });

			expect(records).toHaveLength(1);
			expect(records[0].seam).toBe("action");
			expect(records[0].outcome).toBe("success");
			const expectedHash = await inputSha256({ name: "test", retries: 3 });
			expect(records[0].inputSha256).toBe(expectedHash);
		});

		it("records error outcome with the same hash when run throws", async () => {
			const records: ActionAuditRecord[] = [];
			const auditSink: ActionAuditSink = (r) => {
				records.push(r);
			};

			const action = defineAction({
				id: "action_throwing",
				description: "Action that throws during run",
				schema: z.object({
					val: z.string(),
				}),
				run: async () => {
					throw new Error("failure inside run");
				},
			});

			await expect(
				executeAction(action, { val: "boom" }, { auditSink }),
			).rejects.toThrow("failure inside run");

			expect(records).toHaveLength(1);
			expect(records[0].seam).toBe("action");
			expect(records[0].outcome).toBe("error");
			const expectedHash = await inputSha256({ val: "boom" });
			expect(records[0].inputSha256).toBe(expectedHash);
		});

		it("leaves hash unchanged even if run mutates its input", async () => {
			const records: ActionAuditRecord[] = [];
			const auditSink: ActionAuditSink = (r) => {
				records.push(r);
			};

			const action = defineAction({
				id: "action_mutating",
				description: "Action mutating its input during run",
				schema: z.object({
					items: z.array(z.string()),
				}),
				run: async (input) => {
					input.items.push("mutated");
					return input;
				},
			});

			await executeAction(action, { items: ["a"] }, { auditSink });

			expect(records).toHaveLength(1);
			const expectedHash = await inputSha256({ items: ["a"] });
			expect(records[0].inputSha256).toBe(expectedHash);
		});

		it("records validation_error with inputSha256: null", async () => {
			const records: ActionAuditRecord[] = [];
			const auditSink: ActionAuditSink = (r) => {
				records.push(r);
			};

			const action = defineAction({
				id: "action_strict",
				description: "Strict action",
				schema: z.object({
					count: z.number(),
				}),
				run: async (input) => input,
			});

			await expect(
				executeAction(action, { count: "not-a-number" as any }, { auditSink }),
			).rejects.toThrow();

			expect(records).toHaveLength(1);
			expect(records[0].seam).toBe("action");
			expect(records[0].outcome).toBe("validation_error");
			expect(records[0].inputSha256).toBeNull();
		});

		it("records error with inputSha256: null if canonicalJson fails to serialize input", async () => {
			const records: ActionAuditRecord[] = [];
			const auditSink: ActionAuditSink = (r) => {
				records.push(r);
			};

			const cyclic: Record<string, unknown> = {};
			cyclic.self = cyclic;

			const action = defineAction({
				id: "action_cyclic",
				description: "Action receiving cyclic input with skipValidation",
				schema: z.any(),
				run: async (input) => input,
			});

			await expect(
				executeAction(action, cyclic, { skipValidation: true, auditSink }),
			).rejects.toThrow(TypeError);

			expect(records).toHaveLength(1);
			expect(records[0].seam).toBe("action");
			expect(records[0].outcome).toBe("error");
			expect(records[0].inputSha256).toBeNull();
		});
	});
});
