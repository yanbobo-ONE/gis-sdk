#!/usr/bin/env node

import { cp, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const assetDirectories = ['Workers', 'ThirdParty', 'Assets', 'Widgets'];
const [targetArgument] = process.argv.slice(2);

if (!targetArgument || targetArgument === '--help' || targetArgument === '-h') {
  console.log('Usage: gis-sdk-copy-assets <target-directory>');
  console.log('Example: gis-sdk-copy-assets public/cesium');
  process.exit(targetArgument ? 0 : 1);
}

const require = createRequire(import.meta.url);
const cesiumPackageDirectory = dirname(require.resolve('cesium/package.json'));
const cesiumBuildDirectory = resolve(cesiumPackageDirectory, 'Build', 'Cesium');
const targetDirectory = resolve(process.cwd(), targetArgument);

await mkdir(targetDirectory, { recursive: true });
await Promise.all(
  assetDirectories.map((directory) =>
    cp(resolve(cesiumBuildDirectory, directory), resolve(targetDirectory, directory), {
      force: true,
      recursive: true,
    }),
  ),
);

console.log(`Copied Cesium assets to ${targetDirectory}`);
