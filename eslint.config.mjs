import tseslint from "typescript-eslint";
export default tseslint.config(
  { ignores: [".next/**", "node_modules/**", "data/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
);
