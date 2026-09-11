import globals from "globals";
import js from "@eslint/js";

export default [
  {
    ignores: [
      "node_modules/**",
      "graphify-out/**",
      "lib/libav*",
      "web-app/**",
      "sandbox/vendor/**",
    ],
  },
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        chrome: "readonly",
        browser: "readonly",
        self: "readonly",
        importScripts: "readonly",
      },
    },
    rules: {
      // Dead Code & Logical bugs
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
      "no-unreachable": "error",
      "no-constant-condition": "error",
      "no-dupe-keys": "error",
      "no-duplicate-case": "error",
      "no-self-assign": "error",
      "no-self-compare": "error",
      "no-fallthrough": "warn",
      "no-useless-catch": "warn",
      "no-empty-pattern": "error",

      // Logical correctness
      "eqeqeq": ["warn", "smart"],
      "no-implicit-coercion": "off",
      "no-loss-of-precision": "error",
      "use-isnan": "error",
      "valid-typeof": "error",
      "no-constructor-return": "error",
      "no-promise-executor-return": "warn",
      "no-unmodified-loop-condition": "error",
      "no-loop-func": "warn",

      // Bugs
      "no-async-promise-executor": "error",
      "no-await-in-loop": "off",
      "no-template-curly-in-string": "warn",
      "array-callback-return": "warn",
      "no-setter-return": "error",

      // Code quality
      "prefer-const": "warn",
      "no-var": "warn",
    },
  },
  // Content scripts run as `script`, not module
  {
    files: ["content/**/*.js", "extractors/**/*.js", "hooks/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        ...globals.browser,
        chrome: "readonly",
        browser: "readonly",
      },
    },
  },
  // Background service worker
  {
    files: ["background.js", "workers/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        ...globals.serviceworker,
        chrome: "readonly",
        browser: "readonly",
        self: "readonly",
      },
    },
  },
];
