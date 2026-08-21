import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    core: 'src/entries/core.ts',
    cesium: 'src/entries/cesium.ts',
    layers: 'src/entries/layers.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  target: 'es2022',
  tsconfig: 'tsconfig.build.json',
  outDir: 'dist',
  external: ['cesium'],
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.js' };
  },
});
