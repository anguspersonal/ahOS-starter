import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import globals from "globals";

// Standard Node/JS globals (console, Buffer, fetch, clearTimeout,
// AbortController, crypto, structuredClone, queueMicrotask, __dirname, ...)
// come from the `globals` package rather than a hand-maintained list, so a
// new standard global doesn't need an edit here (#974). `globals` is already
// pulled in transitively (via @eslint/eslintrc, a dependency of eslint
// itself), the same way this file relies on eslint's own transitive tooling
// dep (@eslint/js) without declaring it in this package's own package.json.
// @typescript-eslint/parser and @typescript-eslint/eslint-plugin are declared
// explicit devDependencies here (see PR #1157 round-1 QA finding: they were
// previously pulled in only transitively via packages/web's
// eslint-config-next, which broke lint once packages/web was removed).
//
// `NodeJS` and `RequestInit` are TypeScript ambient type identifiers (from
// @types/node / lib.dom.d.ts respectively), not JS runtime globals, so the
// `globals` package doesn't cover them; they stay hand-declared.
const nodeGlobals = {
  ...globals.node,
  ...globals.nodeBuiltin,
  NodeJS: "readonly",
  RequestInit: "readonly",
};

export default [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "*.config.js",
      "*.config.mjs",
    ],
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: { jsx: false },
      },
      globals: nodeGlobals,
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["warn", {
        varsIgnorePattern: "^_",
        argsIgnorePattern: "^_",
      }],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": "off",
    },
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: nodeGlobals,
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": ["warn", {
        varsIgnorePattern: "^_",
        argsIgnorePattern: "^_",
      }],
      "no-console": "off",
    },
  },
];
