import eslint from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const nodeGlobals = {
  console: "readonly",
  process: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  global: "readonly",
  Promise: "readonly",
  require: "readonly",
  __dirname: "readonly",
  __filename: "readonly",
  module: "readonly",
  exports: "readonly",
};

const testGlobals = {
  ...nodeGlobals,
  jest: "readonly",
  test: "readonly",
  describe: "readonly",
  expect: "readonly",
  beforeEach: "readonly",
  afterEach: "readonly",
  beforeAll: "readonly",
  afterAll: "readonly",
  vi: "readonly",
};

const sourceRules = {
  // Allow explicit `any` — established pattern in plugin code
  "@typescript-eslint/no-explicit-any": "off",
  "@typescript-eslint/no-unsafe-assignment": "off",
  "@typescript-eslint/no-unsafe-call": "off",
  "@typescript-eslint/no-unsafe-member-access": "off",
  "@typescript-eslint/no-unsafe-return": "off",
  "@typescript-eslint/no-unsafe-argument": "off",
  "@typescript-eslint/no-unnecessary-type-assertion": "off",
  "@typescript-eslint/no-inferrable-types": "off",
  "@typescript-eslint/array-type": "off",
  "@typescript-eslint/consistent-type-definitions": "off",
  "@typescript-eslint/prefer-optional-chain": "off",
  "@typescript-eslint/prefer-nullish-coalescing": "off",
  "@typescript-eslint/no-base-to-string": "off",
  "@typescript-eslint/prefer-regexp-exec": "off",
  // The plugin uses async handlers that may not always await — this is intentional
  // for the plugin framework's handler interface
  "@typescript-eslint/require-await": "off",
  "@typescript-eslint/no-misused-promises": "off",
  "@typescript-eslint/no-unused-vars": ["warn", {
    argsIgnorePattern: "^_",
    varsIgnorePattern: "^_",
    caughtErrorsIgnorePattern: "^_",
  }],
  "no-empty": "warn",
  "no-useless-escape": "off",
};

export default [
  eslint.configs.recommended,

  // Source files — type-aware linting
  {
    files: ["src/**/*.ts"],
    ignores: ["src/__tests__/**"],
    plugins: { "@typescript-eslint": tseslint },
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: __dirname,
      },
      globals: nodeGlobals,
    },
    rules: {
      ...tseslint.configs["recommended-type-checked"].rules,
      ...sourceRules,
    },
  },

  // Test files — syntax-only linting (no project mode)
  {
    files: ["src/__tests__/**/*.ts"],
    plugins: { "@typescript-eslint": tseslint },
    languageOptions: {
      parser: tsparser,
      globals: testGlobals,
    },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "no-empty": "warn",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
];