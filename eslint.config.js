import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

const sdkMessage = "Only src/dispatcher/adapter/ may import @pohunek/sdk.";

export default defineConfig(
  { ignores: ["node_modules/**", "quarantine/**", "logs/**"] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/explicit-module-boundary-types": "error",
    },
  },
  {
    ignores: ["src/dispatcher/adapter/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ regex: "^@pohunek/(sdk|protocol)(/.*)?$", message: sdkMessage }] }],
      "no-restricted-syntax": ["error", { selector: "ImportExpression[source.value=/^@pohunek\\/(sdk|protocol)(\\/|$)/]", message: sdkMessage }],
    },
  },
  { files: ["**/*.js"], extends: [tseslint.configs.disableTypeChecked] },
);
