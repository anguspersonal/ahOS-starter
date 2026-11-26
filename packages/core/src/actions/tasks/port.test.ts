import { describe, expect, it, vi } from "vitest";
import type { TaskRepository } from "../../ports/tasks.js";
import type { CreateTaskPorts } from "./createTaskBody.js";
import { createCoreTasksPort } from "./port.js";

function makePort(ownerId?: () => string | undefined) {
	const tasks = { query: vi.fn(async () => []) };
	const config = { loadConfig: vi.fn(async () => null) };
	const port = createCoreTasksPort({
		...({ config } as unknown as CreateTaskPorts),
		tasks: tasks as unknown as TaskRepository,
		ownerId,
	});
	return { port, tasks, config };
}

describe("createCoreTasksPort (#1662)", () => {
	it("taskCrud runs core's body over the task repository, as the caller or else the owner", async () => {
		const { port, tasks } = makePort(() => "owner-1");
		await port.taskCrud({ operation: "query" } as never);
		await port.taskCrud({ operation: "query" } as never, { userId: "caller-1" } as never);
		expect(tasks.query.mock.calls.map((call) => (call as unknown[]).at(-1))).toEqual(["owner-1", "caller-1"]);
	});

	it("createTask runs core's body over the given ports", async () => {
		const { port, config } = makePort(() => "owner-1");
		await expect(port.createTask({ title: "Buy milk", domain: "work" } as never)).rejects.toThrow(
			"No Notion Work integration configured.",
		);
		expect(config.loadConfig).toHaveBeenCalledWith("notion_work", expect.anything());
	});

	it("createTask refuses to run with no owner id at all", async () => {
		const { port, config } = makePort();
		await expect(port.createTask({ title: "Buy milk", domain: "work" } as never)).rejects.toThrow(
			"task_create needs the owner's user id, and none was given.",
		);
		expect(config.loadConfig).not.toHaveBeenCalled();
	});
});
