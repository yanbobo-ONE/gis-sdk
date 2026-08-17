import tseslint from 'typescript-eslint';

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
      'docs/.vitepress/cache/**',
      'docs/.vitepress/dist/**',
    ],
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
