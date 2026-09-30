import { readdir, readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

/**
 * 外部接入点（瓦片地址、地形地址、影像服务、数据地址、实时链路）必须由调用方给出。
 *
 * 这两条守卫锁住"不内置、也不隐藏"的边界：源码里出现可直接联通外部的地址字面量即失败；
 * 总览文档必须继续列出各接入点的公开配置入口，避免新增能力后文档落后。
 */
const EXTERNAL_MARKERS: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /https?:\/\//iu, why: '绝对 URL' },
  { pattern: /\blocalhost\b|\b127\.0\.0\.1\b|\b0\.0\.0\.0\b/u, why: '本机地址' },
  { pattern: /\bion\.cesium\.com\b|\bassetId\b/u, why: 'Cesium ion 资产' },
];

async function listSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(path)));
    } else {
      files.push(path);
    }
  }
  return files;
}

describe('external endpoints stay caller-supplied', () => {
  it('keeps every absolute external address out of the SDK source', async () => {
    const files = await listSourceFiles(new URL('../src', import.meta.url).pathname);
    expect(files.length).toBeGreaterThan(50);

    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const { pattern, why } of EXTERNAL_MARKERS) {
        if (pattern.test(source)) {
          violations.push(`${file}: ${why}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('documents every external touchpoint with its public entry', async () => {
    const guide = await readFile(
      new URL('../docs/guide/external-endpoints.md', import.meta.url),
      'utf8',
    );

    for (const entry of [
      'cesiumBaseUrl',
      'createMap({ basemap })',
      'createMap({ terrain })',
      'map.terrain.set',
      "type: 'wms'",
      "type: 'xyz'",
      'map.layers.add',
      'RealtimeSocketClient',
      'map.raw.viewer',
    ]) {
      expect(guide).toContain(entry);
    }
  });
});
