import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('Vanilla example layout', () => {
  it('bounds the Cesium canvas to the viewport grid cell', async () => {
    const stylesheet = await readFile(
      new URL('../examples/vanilla/src/style.css', import.meta.url),
      'utf8',
    );

    expect(stylesheet).toMatch(/\.workspace\s*{[^}]*height:\s*100dvh;/s);
    expect(stylesheet).toMatch(/\.map-stage\s*{[^}]*overflow:\s*hidden;/s);
    expect(stylesheet).toMatch(/#map\s*{[^}]*position:\s*absolute;[^}]*inset:\s*0;/s);
  });
});
