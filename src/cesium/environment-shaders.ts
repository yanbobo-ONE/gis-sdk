/**
 * 环境效果使用的 GLSL 片段。
 *
 * 全部内联，不引用外部纹理或数据资产。方言按 Cesium 1.14x 的 WebGL2 后处理阶段：
 * 片元输出 `out_FragColor`，纹理采样用 `texture()`，屏幕坐标从 `v_textureCoordinates` 取。
 * 只使用 Cesium 的自动 uniform（`czm_globeDepthTexture`、`czm_viewport`、
 * `czm_windowToEyeCoordinates`、`czm_inverseView`、`czm_viewerPositionWC`、
 * `czm_ellipsoidRadii`），不依赖任何私有字段。
 *
 * @internal
 */

/**
 * 屏幕空间哈希与噪声。
 *
 * 不使用 `sin` 哈希以避免不同 GPU 的精度差异导致同一帧在不同设备上出现不同噪点。
 */
export const ENV_HASH_GLSL = `
float envHash12(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

float envValueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = envHash12(i);
  float b = envHash12(i + vec2(1.0, 0.0));
  float c = envHash12(i + vec2(0.0, 1.0));
  float d = envHash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
`;

/**
 * 深度反投影工具。
 *
 * 天空像素以深度 0 判定，与 Cesium 内部后处理阶段的口径一致。
 */
export const ENV_DEPTH_GLSL = `
/* 读取当前像素的几何深度；返回 0 表示该像素没有几何（天空）。 */
float envSampleDepth(vec2 fragCoord) {
  return czm_unpackDepth(texture(czm_globeDepthTexture, fragCoord / czm_viewport.zw));
}

/* 把窗口坐标反投影到视空间坐标。 */
vec3 envEyePosition(vec2 fragCoord, float depthOrLogDepth) {
  vec4 eye = czm_windowToEyeCoordinates(fragCoord, depthOrLogDepth);
  return eye.xyz / max(abs(eye.w), 1e-6) * sign(eye.w);
}

/* 视空间坐标转世界坐标。 */
vec3 envWorldPosition(vec3 eye) {
  vec4 world = czm_inverseView * vec4(eye, 1.0);
  return world.xyz / max(abs(world.w), 1e-6) * sign(world.w);
}

/* 由窗口坐标构造世界空间视线方向；长度由调用方归一化。 */
vec3 envWorldDirection(vec3 eye) {
  vec4 world = czm_inverseView * vec4(eye, 0.0);
  return world.xyz;
}
`;

/**
 * 椭球高近似。
 *
 * 忽略扁率，误差在雾、霾的视觉范围内可接受，换来的是片元阶段的两个向量运算。
 */
export const ENV_ELLIPSOID_GLSL = `
/* 由地心坐标估算椭球高（米）。 */
float envHeightAboveEllipsoid(vec3 worldPosition) {
  return length(worldPosition) - czm_ellipsoidRadii.x;
}
`;

/**
 * 深度雾后处理片段。
 *
 * 按场景深度反投影得到相机距离，叠加椭球高衰减；天空像素走单独分支，按视线方向与相机高度
 * 给出大气透视，因此不会在天际线上出现硬边或黑边。
 *
 * uniform：`uDensity` 密度、`uStart` / `uEnd` 起雾与完全不透明距离、`uColor` 雾色、
 * `uHeightFalloff` 高度衰减尺度、`uCameraHeight` 相机椭球高、`uStrength` 开关与二维降级、
 * `uTopHeight` 雾柱顶高度、`uBrightness` 画面亮度倍率。
 *
 * @internal
 */
export const depthFogFragmentShader = `
uniform sampler2D colorTexture;
uniform float uDensity;
uniform float uStart;
uniform float uEnd;
uniform vec3 uColor;
uniform float uHeightFalloff;
uniform float uCameraHeight;
uniform float uStrength;
uniform float uTopHeight;
uniform float uBrightness;

in vec2 v_textureCoordinates;

${ENV_DEPTH_GLSL}
${ENV_ELLIPSOID_GLSL}

void main() {
  vec4 color = texture(colorTexture, v_textureCoordinates);
  // 亮度按整幅画面作用，雾色随后同步乘同一系数。
  color.rgb *= uBrightness;
  if (uDensity <= 0.001 || uStrength <= 0.001) {
    out_FragColor = color;
    return;
  }
  vec2 fragCoord = gl_FragCoord.xy;
  float depthOrLogDepth = envSampleDepth(fragCoord);
  float amount = 0.0;
  vec3 fogColor = uColor;
  if (depthOrLogDepth <= 0.0) {
    // 天空：视线越接近水平穿过雾层越厚，相机越高天空越干净。
    vec3 eyeDirection = envWorldDirection(envEyePosition(fragCoord, 1.0));
    vec3 worldDirection = normalize(eyeDirection);
    float horizon = 1.0 - clamp(abs(worldDirection.y) * 3.2, 0.0, 1.0);
    float cameraFalloff = exp(-max(uCameraHeight, 0.0) / max(uHeightFalloff * 2.5, 1.0));
    float topGate = clamp(1.0 - max(uCameraHeight, 0.0) / max(uTopHeight, 1.0), 0.0, 1.0);
    amount = uDensity * uStrength * horizon * cameraFalloff * topGate * 0.75;
    // 天空雾色向地平线暖色偏移，避免整片天空发灰。
    fogColor = mix(uColor, uColor * 1.18 + vec3(0.04, 0.03, 0.01), horizon * 0.6);
  } else {
    vec3 eye = envEyePosition(fragCoord, depthOrLogDepth);
    float distanceToCamera = length(eye);
    float distanceFactor = clamp((distanceToCamera - uStart) / max(uEnd - uStart, 1.0), 0.0, 1.0);
    distanceFactor = distanceFactor * distanceFactor * (3.0 - 2.0 * distanceFactor);
    vec3 world = envWorldPosition(eye);
    vec3 midWorld = mix(world, czm_viewerPositionWC, 0.5);
    float midHeight = max(envHeightAboveEllipsoid(midWorld), 0.0);
    float heightFactor =
      exp(-midHeight / max(uHeightFalloff, 1.0)) *
      clamp(1.0 - midHeight / max(uTopHeight, 1.0), 0.0, 1.0);
    float cameraFalloff = clamp(
      0.25 + 0.75 * exp(-max(uCameraHeight, 0.0) / max(uHeightFalloff * 6.0, 1.0)),
      0.0,
      1.0
    );
    amount = uDensity * uStrength * distanceFactor * mix(0.2, 1.0, heightFactor) * cameraFalloff;
  }
  amount = clamp(amount, 0.0, 0.92);
  if (!(amount > 0.0)) {
    out_FragColor = color;
    return;
  }
  color.rgb = mix(color.rgb, fogColor * uBrightness, amount);
  out_FragColor = color;
}
`;

/**
 * 雨雪共用的程序化后处理片段。
 *
 * 语义是**屏幕气氛**（近景降水），不是真实空间中的降水体积：粒子在屏幕空间下落，相机移动时
 * 雨丝倾斜方向随相机基向量变化。风向通过相机基向量投影到屏幕空间，因此无需世界坐标网格。
 *
 * uniform：`uTime` 环境时间、`uDensity` 密度、`uSpeed` 速度倍率、`uSnow` 雨雪权重、
 * `uOpacity` 总不透明度、`uLayers` 层数（质量档）、`uWindWeight` / `uWindEnu` 风、
 * `uAspect` 视口宽高比、`uStreakLength` 雨丝长度、`uFlakeSize` 雪花大小、`uBrightness` 亮度。
 *
 * @internal
 */
export const precipitationFragmentShader = `
uniform sampler2D colorTexture;
uniform float uTime;
uniform float uDensity;
uniform float uSpeed;
uniform float uSnow;
uniform float uOpacity;
uniform float uLayers;
uniform float uWindWeight;
uniform vec3 uWindEnu;
uniform float uAspect;
uniform float uStreakLength;
uniform float uFlakeSize;
uniform float uBrightness;

in vec2 v_textureCoordinates;

${ENV_HASH_GLSL}

/* 屏幕空间下落方向：垂直向下叠加风向在屏幕上的投影。 */
vec2 envFallDirection() {
  vec3 cameraUp = normalize(czm_viewerPositionWC);
  vec3 worldEast = normalize(cross(vec3(0.0, 0.0, 1.0), cameraUp));
  vec3 worldNorth = cross(cameraUp, worldEast);
  vec3 windWorld = worldEast * uWindEnu.x + worldNorth * uWindEnu.y;
  vec2 windScreen = vec2(dot(windWorld, czm_view[0].xyz), dot(windWorld, czm_view[1].xyz));
  vec2 direction = vec2(windScreen.x * uWindWeight, -1.0 + windScreen.y * uWindWeight * 0.6);
  return normalize(direction + vec2(0.0, -1e-4));
}

/* 单层雨丝；返回 0 到 1 的覆盖度。 */
float envRainLayer(vec2 uv, float scale, float seed, vec2 fall) {
  // uStreakLength 越大雨丝越短：0.1 对应长丝，1 对应短丝。
  float streakSpan = mix(0.30, 0.06, clamp(uStreakLength, 0.0, 1.0));
  vec2 p = uv;
  p.y -= uTime * uSpeed * 2.6;
  p.x += fall.x * uTime * uSpeed * 2.2;
  p *= vec2(scale * uAspect, scale);
  vec2 cell = floor(p);
  vec2 local = fract(p);
  float rnd = envHash12(cell + seed);
  float present = step(rnd, uDensity * 0.55);
  vec2 center = vec2(0.25 + fract(rnd * 3.1) * 0.5, 0.3 + fract(rnd * 5.7) * 0.4);
  vec2 delta = local - center;
  vec2 streakDirection = normalize(mix(vec2(0.0, -1.0), fall, 0.85));
  float along = dot(delta, streakDirection);
  float across = dot(delta, vec2(-streakDirection.y, streakDirection.x));
  float line = (1.0 - smoothstep(0.015, 0.05, abs(across)))
             * (1.0 - smoothstep(streakSpan * 0.25, streakSpan, abs(along)));
  return line * present;
}

/* 单层雪花；返回 0 到 1 的覆盖度。 */
float envSnowLayer(vec2 uv, float scale, float seed, vec2 fall) {
  vec2 p = uv;
  p.y -= uTime * uSpeed * 0.55;
  p.x += sin(uTime * 0.6 + seed * 6.28) * 0.06 + fall.x * uTime * uSpeed * 0.5;
  p *= vec2(scale * uAspect, scale);
  vec2 cell = floor(p);
  vec2 local = fract(p);
  float rnd = envHash12(cell + seed);
  float present = step(rnd, uDensity * 0.5);
  vec2 center = vec2(0.25 + fract(rnd * 3.7) * 0.5, 0.25 + fract(rnd * 5.3) * 0.5);
  // 雪花大小以 0.02 为基准缩放并夹到合理区间，避免退化成点或糊成一片。
  float flakeScale = clamp(clamp(uFlakeSize, 0.005, 0.04) / 0.02, 0.4, 2.2);
  float radius = (0.045 + 0.055 * fract(rnd * 9.1)) * flakeScale;
  float mask = 1.0 - smoothstep(radius * 0.35, radius, length(local - center));
  return mask * present;
}

void main() {
  vec4 color = texture(colorTexture, v_textureCoordinates);
  if (uOpacity <= 0.002 || uDensity <= 0.001) {
    out_FragColor = color;
    return;
  }
  vec2 uv = v_textureCoordinates;
  vec2 fall = envFallDirection();
  float rain = envRainLayer(uv, 26.0, 0.0, fall) * 0.5;
  float snow = envSnowLayer(uv, 22.0, 0.0, fall) * 0.5;
  if (uLayers > 1.5) {
    rain += envRainLayer(uv, 44.0, 11.0, fall) * 0.32;
    snow += envSnowLayer(uv, 38.0, 11.0, fall) * 0.32;
  }
  if (uLayers > 2.5) {
    rain += envRainLayer(uv, 72.0, 23.0, fall) * 0.2;
    snow += envSnowLayer(uv, 62.0, 23.0, fall) * 0.2;
  }
  float amount = mix(rain, snow, uSnow);
  amount = clamp(amount * uOpacity, 0.0, 1.0);
  vec3 rainTint = vec3(0.62, 0.74, 0.92);
  vec3 snowTint = vec3(1.0, 1.0, 1.0);
  vec3 tint = mix(rainTint, snowTint, uSnow);
  color.rgb = mix(color.rgb, color.rgb + tint, clamp(amount * 0.85 * uBrightness, 0.0, 1.0));
  color.a = max(color.a, amount * 0.9);
  out_FragColor = color;
}
`;
