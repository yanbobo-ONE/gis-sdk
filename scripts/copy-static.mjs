import { chmod, copyFile, mkdir } from 'node:fs/promises';

const distributionDirectory = new URL('../dist/', import.meta.url);

await mkdir(distributionDirectory, { recursive: true });
await copyFile(
  new URL('../src/styles.css', import.meta.url),
  new URL('styles.css', distributionDirectory),
);
const assetCopyCommand = new URL('copy-cesium-assets.mjs', distributionDirectory);
await copyFile(new URL('./copy-cesium-assets.mjs', import.meta.url), assetCopyCommand);
await chmod(assetCopyCommand, 0o755);
