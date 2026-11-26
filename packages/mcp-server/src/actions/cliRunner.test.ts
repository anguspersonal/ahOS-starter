import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	ActionRegistry,
	defineAction,
	type ActionAuditRecord,
} from "@ahkms/core/actions";
import { runActionCli } from "./cliRunner.js";

function makeTestRegistry() {
	const registry = new ActionRegistry();

	const echoAction = defineAction({
		id: "test_echo",
		description: "Echoes a greeting message.",
		schema: z.object({
			name: z.string().min(1),
		}),
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		run: async (input, ctx) => ({
			greeting: `Hello, ${input.name}!`,
			caller: ctx.caller,
			userId: ctx.userId,
		}),
	});

	const deniedAction = defineAction({
		id: "test_denied",
		description: "Simulates an approval denial.",
		schema: z.object({}),
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: false,
		},
		run: async (): Promise<{ ok: boolean }> => {
			const err = new Error("Approval denied for test_denied");
			err.name = "ApprovalDeniedError";
			throw err;
		},
	});

	registry.register(echoAction);
	registry.register(deniedAction);
	return registry;
}

describe("runActionCli", () => {
	it("executes a valid action with caller: 'cli', records the audit event, prints ok JSON, and returns 0", async () => {
		const registry = makeTestRegistry();
		const records: ActionAuditRecord[] = [];
		const lines: string[] = [];

		const code = await runActionCli(
			["test_echo", JSON.stringify({ name: "Angus" })],
			{
				registry,
				getUserId: () => "user-123",
				requestId: "req-ok-1",
				auditSink: (r) => {
					records.push(r);
				},
				stdout: (line) => lines.push(line),
			},
		);

		expect(code).toBe(0);
		expect(lines).toHaveLength(1);
		const parsed = JSON.parse(lines[0]);
		expect(parsed).toEqual({
			outcome: "ok",
			actionId: "test_echo",
			requestId: "req-ok-1",
			data: {
				greeting: "Hello, Angus!",
				caller: "cli",
				userId: "user-123",
			},
		});

		expect(records).toHaveLength(1);
		expect(records[0].caller).toBe("cli");
		expect(records[0].outcome).toBe("success");
		expect(records[0].userId).toBe("user-123");
	});

	it("returns exit code 1 and outcome 'invalid' on schema validation failure while recording caller: 'cli'", async () => {
		const registry = makeTestRegistry();
		const records: ActionAuditRecord[] = [];
		const lines: string[] = [];

		const code = await runActionCli(
			["test_echo", JSON.stringify({ name: "" })],
			{
				registry,
				getUserId: () => "user-123",
				requestId: "req-invalid-1",
				auditSink: (r) => {
					records.push(r);
				},
				stdout: (line) => lines.push(line),
			},
		);

		expect(code).toBe(1);
		const parsed = JSON.parse(lines[0]);
		expect(parsed.outcome).toBe("invalid");
		expect(parsed.actionId).toBe("test_echo");
		expect(records).toHaveLength(1);
		expect(records[0].caller).toBe("cli");
		expect(records[0].outcome).toBe("validation_error");
	});

	it("returns exit code 1 and outcome 'denied' when ApprovalDeniedError is thrown", async () => {
		const registry = makeTestRegistry();
		const records: ActionAuditRecord[] = [];
		const lines: string[] = [];

		const code = await runActionCli(["test_denied", "{}"], {
			registry,
			getUserId: () => "user-123",
			requestId: "req-denied-1",
			auditSink: (r) => {
				records.push(r);
			},
			stdout: (line) => lines.push(line),
		});

		expect(code).toBe(1);
		const parsed = JSON.parse(lines[0]);
		expect(parsed.outcome).toBe("denied");
		expect(parsed.error).toContain("Approval denied");
		expect(records).toHaveLength(1);
		expect(records[0].caller).toBe("cli");
	});

	it("returns exit code 1 and outcome 'invalid' for an unknown action ID", async () => {
		const registry = makeTestRegistry();
		const lines: string[] = [];

		const code = await runActionCli(["no_such_action", "{}"], {
			registry,
			getUserId: () => "user-123",
			stdout: (line) => lines.push(line),
		});

		expect(code).toBe(1);
		const parsed = JSON.parse(lines[0]);
		expect(parsed.outcome).toBe("invalid");
		expect(parsed.error).toContain("Unknown action: no_such_action");
	});

	it("returns exit code 1 and outcome 'invalid' for malformed JSON input", async () => {
		const registry = makeTestRegistry();
		const lines: string[] = [];

		const code = await runActionCli(["test_echo", "{not-json"], {
			registry,
			getUserId: () => "user-123",
			stdout: (line) => lines.push(line),
		});

		expect(code).toBe(1);
		const parsed = JSON.parse(lines[0]);
		expect(parsed.outcome).toBe("invalid");
		expect(parsed.error).toContain("Invalid JSON input");
	});
});
