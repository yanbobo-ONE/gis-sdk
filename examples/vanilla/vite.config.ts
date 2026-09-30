import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';
import type { Connect, Plugin, PreviewServer, ViteDevServer } from 'vite';

const wmsTile = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQqCvIAwADTQF9ZKko9AAAAABJRU5ErkJggg==',
  'base64',
);

function localWms(): Plugin {
  let requestCount = 0;
  let lastRequest = '';
  let lastAuthHeader = '';

  const install = (server: ViteDevServer | PreviewServer) => {
    server.middlewares.use((request: Connect.IncomingMessage, response, next) => {
      const requestUrl = new URL(request.url ?? '/', 'http://local.example');
      if (requestUrl.pathname === '/__test/wms-state') {
        response.setHeader('Content-Type', 'application/json');
        response.setHeader('Cache-Control', 'no-store');
        response.end(JSON.stringify({ requestCount, lastRequest, lastAuthHeader }));
        return;
      }
      if (requestUrl.pathname !== '/wms') {
        next();
        return;
      }

      requestCount += 1;
      lastRequest = requestUrl.search;
      // 记录自定义鉴权头，用于验证 layers 的 headers 真的发到了服务端。
      lastAuthHeader = String(request.headers['x-example-auth'] ?? '');
      response.statusCode = 200;
      response.setHeader('Content-Type', 'image/png');
      response.setHeader('Cache-Control', 'no-store');
      response.end(wmsTile);
    });
  };

  return {
    name: 'local-wms-fixture',
    configureServer: install,
    configurePreviewServer: install,
  };
}

/**
 * 本地地形元数据 fixture：只提供 `layer.json`，够 `CesiumTerrainProvider.fromUrl` 解析出 Provider，
 * 用于验证"创建期声明的地址真的被请求"。瓦片数据不在 fixture 范围内，验收流程读完之后会切回椭球地形。
 */
function localTerrain(): Plugin {
  let layerJsonRequests = 0;
  let lastPath = '';
  // 元数据人为延迟：让 `map.terrain.pending` 的"在途"窗口在验收台上可观测（真实服务同样有延迟）。
  const layerJsonDelayMs = 600;

  const layerJson = Buffer.from(
    JSON.stringify({
      tilejson: '2.1.0',
      name: 'gis-sdk-acceptance-fixture',
      description: 'Metadata-only terrain fixture for acceptance probes.',
      version: '1.0.0',
      format: 'quantized-mesh-1.0',
      attribution: '',
      schema: 'tms',
      tiles: ['{z}/{x}/{y}.terrain?v={version}'],
      projection: 'EPSG:4326',
      bounds: [-180, -90, 180, 90],
      available: [[{ startX: 0, startY: 0, endX: 0, endY: 0 }]],
    }),
  );

  const install = (server: ViteDevServer | PreviewServer) => {
    server.middlewares.use((request: Connect.IncomingMessage, response, next) => {
      const requestUrl = new URL(request.url ?? '/', 'http://local.example');
      if (requestUrl.pathname === '/__test/terrain-state') {
        response.setHeader('Content-Type', 'application/json');
        response.setHeader('Cache-Control', 'no-store');
        response.end(JSON.stringify({ layerJsonDelayMs, layerJsonRequests, lastPath }));
        return;
      }
      if (!requestUrl.pathname.startsWith('/__test/terrain/')) {
        next();
        return;
      }

      lastPath = requestUrl.pathname;
      response.setHeader('Cache-Control', 'no-store');
      if (requestUrl.pathname.endsWith('/layer.json')) {
        layerJsonRequests += 1;
        response.setHeader('Content-Type', 'application/json');
        setTimeout(() => {
          response.end(layerJson);
        }, layerJsonDelayMs);
        return;
      }

      // 瓦片数据不提供：验收台在 ready 兑现后立刻切回椭球地形。
      response.statusCode = 404;
      response.end();
    });
  };

  return {
    name: 'local-terrain-fixture',
    configureServer: install,
    configurePreviewServer: install,
  };
}

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [localWms(), localTerrain()],
  resolve: {
    alias: [
      {
        // 只匹配裸包名：SDK 的产物 import 'cesium'，若走 Source 入口，Cesium 1.144 的
        // Source/Cesium.js 会按名字转出 @cesium/engine 的内部着色器符号，而 engine 的小版本
        // 升级（26.3 起）已移除它们，依赖预构建会直接报 MISSING_EXPORT。构建产物自带引擎，
        // 不受这条传递依赖漂移影响。
        find: /^cesium$/,
        replacement: fileURLToPath(
          new URL('./node_modules/cesium/Build/Cesium/index.js', import.meta.url),
        ),
      },
    ],
  },
  server: { strictPort: true },
  preview: { strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true },
});
