import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const repositoryRoot = new URL('../', import.meta.url);
const temporaryRoot = new URL('../.tmp/', import.meta.url);
const consumerDirectory = new URL('vanilla-consumer/', temporaryRoot);
const packageDirectory = new URL('package/', temporaryRoot);

await rm(consumerDirectory, { force: true, recursive: true });
await rm(packageDirectory, { force: true, recursive: true });
await mkdir(consumerDirectory, { recursive: true });
await mkdir(packageDirectory, { recursive: true });

const packageJson = JSON.parse(await readFile(new URL('package.json', repositoryRoot), 'utf8'));
const { stdout } = await execute(
  'npm',
  ['pack', '--json', '--pack-destination', packageDirectory.pathname],
  { cwd: repositoryRoot },
);
const packResult = JSON.parse(stdout);
const packedFilename = packResult[0]?.filename;
if (typeof packedFilename !== 'string') {
  throw new Error('npm pack did not return a tarball filename.');
}

await cp(new URL('../examples/vanilla/', import.meta.url), consumerDirectory, {
  recursive: true,
});

const tarball = new URL(packedFilename, packageDirectory);
const consumerPackage = {
  name: 'gis-sdk-vanilla-consumer',
  private: true,
  type: 'module',
  scripts: {
    build: 'vite build',
    dev: 'vite',
  },
  dependencies: {
    '@yanbobo/gis-sdk': `file:${tarball.pathname}`,
  },
  devDependencies: {
    vite: packageJson.devDependencies.vite,
  },
};
await writeFile(
  new URL('package.json', consumerDirectory),
  `${JSON.stringify(consumerPackage, null, 2)}\n`,
);

await execute('npm', ['install', '--ignore-scripts', '--package-lock=false'], {
  cwd: consumerDirectory,
});
await execute(
  fileURLToPath(new URL('node_modules/.bin/gis-sdk-copy-assets', consumerDirectory)),
  ['public/cesium'],
  { cwd: consumerDirectory },
);

console.log(`Prepared packed consumer: ${consumerDirectory.pathname}`);
