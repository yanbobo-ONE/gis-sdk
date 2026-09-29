# 画布快照

`map.capture()` 抓取当前画面：地图导出、缩略图、白板与视图切换过渡都需要"当帧"的位图。

```ts
const capture = await map.capture();
if (capture) {
  const url = capture.canvas.toDataURL('image/png');
  // capture.width / capture.height 是设备像素分辨率（含 devicePixelRatio 缩放）
}

// 容器刚改变尺寸、首帧可能还没画出像素时，可以放宽等待
const retried = await map.capture({ attempts: 3, timeoutMs: 800 });
```

## 为什么不用 preserveDrawingBuffer

WebGL 的绘图缓冲区在渲染帧结束后不再保证有效，因此常见的做法是开启 `preserveDrawingBuffer: true` 再随时 `toDataURL()`——代价是持续的显存与绘制开销。

SDK 采用另一种做法：`capture()` 先请求一次渲染，然后在 `postRender` 的**同一帧内**把场景画布拷贝到离屏 canvas，因此不需要开启该选项。拷贝结果会做一次降采样判空（16×16 采样，任一通道亮度高于阈值即视为有效），避免把尚未渲染或已失效的缓冲区当成有效截图。

## 行为与边界

| 配置        | 默认值 | 说明                                         |
| ----------- | ------ | -------------------------------------------- |
| `timeoutMs` | 400    | 等待渲染的毫秒上限；超时返回 `undefined`     |
| `attempts`  | 2      | 渲染尝试次数；判空失败会重新请求渲染再抓一次 |

- 返回 `undefined` 表示**这一帧没抓到**（超时、画面为空、画布尺寸为零），不是错误；调用方按需重试即可。
- 抓取期间只订阅一次 `postRender`，无论成功、超时还是失败都会解绑，不会累积监听。
- 拷贝的是**场景画布**：Cesium 的 `Widgets`（时间轴、信息框等 HTML 覆盖层）不在其中；需要连同 DOM 覆盖层一起导出时，请用业务自己的 `html2canvas` 一类方案。
- 快照不会修改相机或场景状态；如果需要"抓图后再改变视角"，两条调用互不影响。
