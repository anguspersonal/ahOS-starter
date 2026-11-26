import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { serverRegistry, serverAdapters } from "./serverRegistry.js";
import { notionAdapter } from "../tools/searchNotion.js";

const require = createRequire(import.meta.url);
const manifest = require("@ahkms/core/action-manifest.json");

describe("serverRegistry", () => {
	it("1. serverRegistry() returns the same instance on a second call, and its ids equal the keys of action-manifest.json", () => {
		const reg1 = serverRegistry();
		const reg2 = serverRegistry();
		expect(reg1).toBe(reg2);

		const registryIds = reg1.list().map((a) => a.id).sort();
		const manifestIds = Object.keys(manifest.actions).sort();
		expect(registryIds).toEqual(manifestIds);
	});

	it("2. serverAdapters() wires notion, github, graph, review, synthesize, and leaves derive unwired", () => {
		const adapters = serverAdapters();
		expect(adapters.notion).toBe(notionAdapter);
		expect(adapters.github).toBeDefined();
		expect((adapters.github as any).port).toBeDefined();
		expect((adapters.github as any).supabase).toBeDefined();
		expect((adapters.github as any).getUserId).toBeDefined();
		expect(adapters.graph).toBeDefined();
		expect(adapters.review).toBeDefined();
		expect(typeof adapters.review?.decisionReview).toBe("function");
		expect(typeof adapters.review?.reviewList).toBe("function");
		expect(typeof adapters.review?.reviewResolve).toBe("function");
		expect(adapters.artifacts).toBeDefined();
		expect(typeof adapters.artifacts?.capture).toBe("function");
		expect(adapters.artifactRepository).toBeDefined();
		expect(typeof adapters.artifactRepository?.listLinkedArtifactsForEntities).toBe("function");
		expect(adapters.taskRepository).toBeDefined();
		expect(typeof adapters.taskRepository?.query).toBe("function");
		expect(adapters.derive).toBeUndefined();
		expect(adapters.synthesize).toBeDefined();
	});
});
