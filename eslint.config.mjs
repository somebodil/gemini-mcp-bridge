import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores(["node_modules", "dist", "**/*.mjs", "e2e/mock-gemini.html"]),
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      // chrome.* listeners return promises on purpose (sendResponse is used instead)
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { arguments: false } }],
      "no-restricted-properties": [
        "error",
        { object: "element", property: "innerHTML", message: "Build elements with h(): nothing on Gemini's page comes from HTML strings." },
      ],
    },
  },
  {
    // `describe` and `it` of node:test return promises that the runner takes care of
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
]);
