import { rm } from 'node:fs/promises';

const generatedDirectories = [
  new URL('../dist/', import.meta.url),
  new URL('../coverage/', import.meta.url),
];

await Promise.all(
  generatedDirectories.map((directory) => rm(directory, { force: true, recursive: true })),
);
