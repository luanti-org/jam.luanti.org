import js from "@eslint/js";
import stylistic from "@stylistic/eslint-plugin";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
    { ignores: ["node_modules/**", "dist/**", "data/**", "coverage/**"] },
    {
        files: ["**/*.ts", "eslint.config.mjs"],
        extends: [
            js.configs.recommended,
            tseslint.configs.recommended,
            stylistic.configs.customize({
                indent: 4,
                quotes: "double",
                semi: true,
                jsx: false,
                braceStyle: "1tbs",
                arrowParens: true,
            }),
        ],
        rules: {
            // TypeScript checks runtime globals and unused declarations in bun run typecheck.
            "no-undef": "off",
            "@stylistic/quotes": ["error", "double", { avoidEscape: true }],
            "curly": ["error", "all"],
            "@stylistic/multiline-ternary": "off",
            "@stylistic/padding-line-between-statements": [
                "error",
                { blankLine: "always", prev: "import", next: "*" },
                { blankLine: "any", prev: "import", next: "import" },
                { blankLine: "always", prev: ["function", "class", "interface", "type"], next: "*" },
                {
                    blankLine: "always",
                    prev: "*",
                    next: ["function", "class", "interface", "type", "return", "if", "for", "while", "switch", "try"],
                },
                { blankLine: "always", prev: "block-like", next: "*" },
            ],
            "@stylistic/lines-around-comment": ["error", {
                beforeBlockComment: true,
                beforeLineComment: true,
                allowBlockStart: true,
                allowClassStart: true,
                allowObjectStart: true,
                allowArrayStart: true,
            }],
        },
    },
    {
        files: ["client/**/*.ts"],
        ignores: ["client/sdk.ts"],
        rules: {
            "no-restricted-imports": ["error", { patterns: [
                "**/server/**", "**/shared/**", "node:*", "bun", "bun:*", "@noble/**", "@scure/**", "zod",
            ] }],
        },
    },
    {
        files: ["client/sdk.ts"],
        rules: {
            "no-restricted-imports": ["error", { patterns: ["./**", "**/client/**", "**/server/**"] }],
            "no-restricted-globals": ["error", "window", "document", "location", "localStorage", "sessionStorage", "navigator"],
        },
    },
);
