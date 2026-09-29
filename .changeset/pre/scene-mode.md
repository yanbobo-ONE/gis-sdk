---
'@yanbobo/gis-sdk': minor
---

增加运行时场景模式切换 `map.scene`：`setMode('2d' | '3d', duration?)` 在形变完成时结算，同模式立即结算，连续切换时被取代的一次以 `SCENE_MORPH_SUPERSEDED` 拒绝，销毁时拒绝在途形变。
