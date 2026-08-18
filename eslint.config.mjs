import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const javaScriptFiles = ['**/*.{js,mjs,cjs}'];
const typeCheckedFiles = ['**/*.{ts,mts,cts}'];
const typeCheckedConfigs = [
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
].map((config) => ({ ...config, files: typeCheckedFiles }));

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'docs/api/**',
      'docs/public/api/**',
      'docs/.vitepress/cache/**',
      'docs/.vitepress/dist/**',
      '.vitepress/cache/**',
      '.vitepress/dist/**',
    ],
  },
  {
    ...js.configs.recommended,
    files: javaScriptFiles,
    languageOptions: {
      globals: globals.node,
    },
  },
  ...typeCheckedConfigs,
  {
    files: typeCheckedFiles,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
