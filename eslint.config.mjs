// ESLint flat config. Type-checked rules for the TypeScript sources; plain
// recommended rules for the Node scripts and tests.
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

const nodeGlobals = {
  console: "readonly",
  process: "readonly",
  Buffer: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  AbortController: "readonly",
  AbortSignal: "readonly",
  fetch: "readonly",
  Response: "readonly",
  Request: "readonly",
  Headers: "readonly",
  TextEncoder: "readonly",
  TextDecoder: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  setImmediate: "readonly",
  structuredClone: "readonly",
};

export default defineConfig(
  {
    ignores: ["dist/", "node_modules/", "plugin/server/", "src/apps/generated/", ".worktrees/", ".claude/worktrees/"],
  },
  {
    files: ["src/**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // `const { metadata: _metadata, ...data } = props` is how the code drops a key from a copy.
      "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }],
    },
  },
  {
    files: ["**/*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: { globals: nodeGlobals },
  },
);
