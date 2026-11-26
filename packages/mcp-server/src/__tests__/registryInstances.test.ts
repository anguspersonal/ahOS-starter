import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../..");

function walkSourceFiles(dir: string): string[] {
	const files: string[] = [];
	if (!fs.existsSync(dir)) return files;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== "node_modules" && entry.name !== "dist") {
				files.push(...walkSourceFiles(full));
			}
		} else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) {
			files.push(full);
		}
	}
	return files;
}

function isTestFile(filePath: string): boolean {
	const normal = filePath.replace(/\\/g, "/");
	return (
		normal.includes("/__tests__/") ||
		normal.includes(".test.") ||
		normal.includes(".spec.")
	);
}

describe("registry instances and composition root invariants", () => {
	it("3. inside each main() in src/index.ts and src/http.ts, serverRegistry() is called before createServer( and actionsRouter(", () => {
		const indexSrc = fs.readFileSync(path.resolve(__dirname, "../index.ts"), "utf-8");
		const httpSrc = fs.readFileSync(path.resolve(__dirname, "../http.ts"), "utf-8");

		const indexMainMatch = indexSrc.match(/async\s+function\s+main\s*\(\)\s*\{([\s\S]*?)\n\}/);
		expect(indexMainMatch).not.toBeNull();
		const indexMainBody = indexMainMatch![1];
		const indexServerRegIdx = indexMainBody.indexOf("serverRegistry()");
		const indexCreateServerIdx = indexMainBody.indexOf("createServer(");

		expect(indexServerRegIdx).toBeGreaterThan(-1);
		expect(indexCreateServerIdx).toBeGreaterThan(-1);
		expect(indexServerRegIdx).toBeLessThan(indexCreateServerIdx);

		const httpMainMatch = httpSrc.match(/async\s+function\s+main\s*\(\)\s*\{([\s\S]*?)\n\}/);
		expect(httpMainMatch).not.toBeNull();
		const httpMainBody = httpMainMatch![1];
		const httpServerRegIdx = httpMainBody.indexOf("serverRegistry()");
		const httpActionsRouterIdx = httpMainBody.indexOf("actionsRouter(");
		const httpCreateServerIdx = httpMainBody.indexOf("createServer(");

		expect(httpServerRegIdx).toBeGreaterThan(-1);
		expect(httpActionsRouterIdx).toBeGreaterThan(-1);
		expect(httpCreateServerIdx).toBeGreaterThan(-1);
		expect(httpServerRegIdx).toBeLessThan(httpActionsRouterIdx);
		expect(httpServerRegIdx).toBeLessThan(httpCreateServerIdx);
	});

	it("4. static over packages/*/src (non-test): buildRegistry( is called only at allowed sites, and new ActionRegistry instantiations appear only at allowed sites", () => {
		const packages = ["core", "mcp-server", "web", "worker", "shared", "mobile"];
		const allSrcFiles: string[] = [];
		for (const pkg of packages) {
			const srcDir = path.join(repoRoot, "packages", pkg, "src");
			allSrcFiles.push(...walkSourceFiles(srcDir));
		}

		const nonTestFiles = allSrcFiles.filter((f) => !isTestFile(f));

		const ALLOWED_BUILD_REGISTRY_CALLS = new Set([
			"packages/mcp-server/src/actions/serverRegistry.ts",
			"packages/core/src/engine/main.ts", // reserved for #1553
		]);

		const ALLOWED_REGISTRY_INSTANTIATIONS = new Set([
			"packages/core/src/actions/buildRegistry.ts",
			"packages/web/src/lib/actionRegistry.ts",
		]);

		const actualBuildRegistryCalls: string[] = [];
		const actualRegistryInstantiations: string[] = [];

		for (const file of nonTestFiles) {
			const rel = path.relative(repoRoot, file).replace(/\\/g, "/");
			const content = fs.readFileSync(file, "utf-8");
			const lines = content.split("\n");

			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				if (
					/\bbuildRegistry\s*\(/.test(line) &&
					!/function\s+buildRegistry/.test(line) &&
					!/import\s+/.test(line)
				) {
					actualBuildRegistryCalls.push(rel);
				}
				if (/\bnew\s+(?:ActionRegistry|CoreActionRegistry|ClientActionRegistry)\s*\(/.test(line)) {
					actualRegistryInstantiations.push(rel);
				}
			}
		}

		for (const site of actualBuildRegistryCalls) {
			expect(ALLOWED_BUILD_REGISTRY_CALLS.has(site), `Unexpected buildRegistry call in ${site}`).toBe(true);
		}

		for (const site of actualRegistryInstantiations) {
			expect(
				ALLOWED_REGISTRY_INSTANTIATIONS.has(site),
				`Unexpected registry instantiation in ${site}`,
			).toBe(true);
		}
	});

	it("5. registerWithMcpServer and toMcpTools( appear in no file under packages/*/src", () => {
		const packages = ["core", "mcp-server", "web", "worker", "shared", "mobile"];
		const allSrcFiles: string[] = [];
		for (const pkg of packages) {
			const srcDir = path.join(repoRoot, "packages", pkg, "src");
			allSrcFiles.push(...walkSourceFiles(srcDir));
		}

		const thisFile = path.relative(repoRoot, fileURLToPath(import.meta.url)).replace(/\\/g, "/");
		const forbiddenName = "registerWith" + "McpServer";
		const forbiddenRegex = new RegExp("toMcp" + "Tools\\s*\\(");
		const violations: string[] = [];

		for (const file of allSrcFiles) {
			const rel = path.relative(repoRoot, file).replace(/\\/g, "/");
			if (rel === thisFile) continue;
			const content = fs.readFileSync(file, "utf-8");
			if (content.includes(forbiddenName) || forbiddenRegex.test(content)) {
				violations.push(rel);
			}
		}

		expect(violations).toEqual([]);
	});
});
