import { describe, it, expect } from "vitest";
import { loadConfigFromFile } from "vite";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

describe("client environment exposure", () => {
  it("vite.config.ts does not expose GEMINI or SUPABASE env prefixes or define GEMINI keys", async () => {
    const configPath = path.resolve(currentDir, "../../vite.config.ts");
    const loaded = await loadConfigFromFile({ command: "build", mode: "production" }, configPath);
    expect(loaded).toBeDefined();
    const config = loaded!.config;

    // envPrefix must be undefined, "VITE_", or ["VITE_"]
    const envPrefix = config.envPrefix;
    if (envPrefix !== undefined) {
      if (Array.isArray(envPrefix)) {
        expect(envPrefix).toEqual(["VITE_"]);
      } else {
        expect(envPrefix).toBe("VITE_");
      }
    }

    // define must have no key containing GEMINI
    const define = config.define || {};
    const geminiKeys = Object.keys(define).filter((k) => k.includes("GEMINI"));
    expect(geminiKeys).toEqual([]);
  });

  it("no source file in packages/web/src outside __tests__ uses computed import.meta.env access", () => {
    const srcDir = path.resolve(currentDir, "..");
    const computedEnvPattern = /import\.meta\.env\s*(\?\.)?\[/;

    function scanDir(dir: string): { file: string; match: string }[] {
      const violations: { file: string; match: string }[] = [];
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "__tests__" || entry.name === "node_modules") {
            continue;
          }
          violations.push(...scanDir(fullPath));
        } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
          const content = fs.readFileSync(fullPath, "utf-8");
          const match = content.match(computedEnvPattern);
          if (match) {
            violations.push({ file: fullPath, match: match[0] });
          }
        }
      }
      return violations;
    }

    const violations = scanDir(srcDir);
    expect(violations).toEqual([]);
  });

  it("packages/web/package.json declares @types/node in devDependencies for test environment typing", () => {
    const pkgJsonPath = path.resolve(currentDir, "../../package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
    expect(pkg.devDependencies?.["@types/node"]).toBeDefined();
  });
});
