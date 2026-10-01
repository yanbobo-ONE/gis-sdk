import type { ScreenSpaceEventHandler, ScreenSpaceEventType } from 'cesium';

import type { Unsubscribe } from '../core/event-hub.js';

/** 屏幕输入回调收到的原生 movement 对象；各动作的字段不同，链上不做解读，由订阅者自己收窄。 */
export type InputActionListener = (movement: unknown) => void;

interface ActionChain {
  readonly listeners: Set<InputActionListener>;
  readonly fanOut: InputActionListener;
}

/**
 * 同一个输入处理器上按动作类型串联的回调链。
 *
 * Cesium 的 `setInputAction` 是**覆盖**语义：一个动作类型只能有一个回调，后注册的会把先注册的顶掉。
 * 拾取与绘制都要用 `LEFT_CLICK` 与 `MOUSE_MOVE`，各自直接注册时先注册的一方在真实地图上完全收不到
 * 事件——单测里只造一个控制器，看起来一切正常，问题只在装到同一个 Viewer 上才出现。
 *
 * 这里让第一个订阅者安装真正的 Cesium 动作，其余订阅者挂到同一条链上；最后一个订阅者退出时移除动作。
 * 链只按处理器对象索引（弱引用），处理器随地图一起释放，不需要额外清理。
 */
const chains = new WeakMap<object, Map<ScreenSpaceEventType, ActionChain>>();

/**
 * 订阅一个屏幕输入动作；返回取消订阅函数。
 *
 * 全部订阅者都会收到事件：某个订阅者抛错不会拦住其余订阅者，错误在派发结束后重新抛出，
 * 因此既不会被吞掉，也不会让后注册的订阅者漏事件。
 */
export function addInputAction(
  handler: ScreenSpaceEventHandler,
  type: ScreenSpaceEventType,
  listener: InputActionListener,
): Unsubscribe {
  let byType = chains.get(handler);
  if (!byType) {
    byType = new Map<ScreenSpaceEventType, ActionChain>();
    chains.set(handler, byType);
  }
  const existing = byType.get(type);
  let chain = existing;
  if (!chain) {
    const listeners = new Set<InputActionListener>();
    const fanOut: InputActionListener = (movement) => {
      const errors: unknown[] = [];
      for (const current of [...listeners]) {
        try {
          current(movement);
        } catch (error: unknown) {
          errors.push(error);
        }
      }
      if (errors.length === 1) {
        const error = errors[0];
        throw error instanceof Error
          ? error
          : new Error('Input action listener failed.', { cause: error });
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, 'Multiple input action listeners failed.');
      }
    };
    chain = { listeners, fanOut };
    byType.set(type, chain);
    handler.setInputAction(fanOut, type);
  }

  chain.listeners.add(listener);
  let subscribed = true;
  return () => {
    if (!subscribed) {
      return;
    }
    subscribed = false;
    chain.listeners.delete(listener);
    if (chain.listeners.size > 0) {
      return;
    }
    byType.delete(type);
    // 只移除自己装上的动作：中途可能已被业务用自己的回调覆盖，那不属于本链。
    if ((handler.getInputAction(type) as unknown) === chain.fanOut) {
      handler.removeInputAction(type);
    }
  };
}
