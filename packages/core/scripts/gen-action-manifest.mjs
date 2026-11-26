import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildRegistry,
	buildActionManifest,
	serialiseManifest,
} from "../dist/actions/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const targetPath = path.resolve(__dirname, "../action-manifest.json");

const registry = buildRegistry({});
const manifest = buildActionManifest(registry);
const content = serialiseManifest(manifest);

fs.writeFileSync(targetPath, content, "utf8");
console.log(`Wrote action manifest with ${Object.keys(manifest.actions).length} actions to ${targetPath}`);
