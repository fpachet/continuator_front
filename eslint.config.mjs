import globals from "globals";

export default [
  { ignores: ["frontend/vendor/**"] },
  {
    files: ["frontend/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser, ...globals.es2025 },
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": [
        "error",
        { args: "none", caughtErrors: "none", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["frontend/tests/*.js"],
    languageOptions: { globals: globals.node },
  },
];
