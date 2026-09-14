/**
 * store.js - 极简全局状态（发布订阅）
 *
 * 场景：设置页改了连接配置或切换了助手，问答页需要立刻感知并清空当前会话，
 *      用订阅比在 onShow 里做一堆判断更干净。
 */

const state = {};
const listeners = {};

function get(key) {
  return state[key];
}

function set(key, value) {
  if (state[key] === value) {
    return;
  }
  const prev = state[key];
  state[key] = value;
  (listeners[key] || []).forEach((fn) => {
    try {
      fn(value, prev);
    } catch (err) {
      console.error(`[store] 订阅回调异常：${key}`, err);
    }
  });
}

function subscribe(key, handler) {
  if (typeof handler !== 'function') {
    return () => {};
  }
  if (!listeners[key]) {
    listeners[key] = [];
  }
  listeners[key].push(handler);
  return () => {
    listeners[key] = (listeners[key] || []).filter((fn) => fn !== handler);
  };
}

/** 配置变更（换模式 / 换地址 / 换助手）——问答页据此重置会话 */
function touchConfig() {
  set('configRevision', Date.now());
}

/** 会话被清空或切换 */
function touchSession() {
  set('sessionRevision', Date.now());
}

module.exports = {
  get,
  set,
  subscribe,
  touchConfig,
  touchSession,
};
