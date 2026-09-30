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

  const install = (server: ViteDevServer | PreviewServer) => {
    server.middlewares.use((request: Connect.IncomingMessage, response, next) => {
      const requestUrl = new URL(request.url ?? '/', 'http://local.example');
      if (requestUrl.pathname === '/__test/wms-state') {
        response.setHeader('Content-Type', 'application/json');
        response.setHeader('Cache-Control', 'no-store');
        response.end(JSON.stringify({ requestCount, lastRequest }));
        return;
      }
      if (requestUrl.pathname !== '/wms') {
        next();
        return;
      }

      requestCount += 1;
      lastRequest = requestUrl.search;
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

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [localWms()],
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
