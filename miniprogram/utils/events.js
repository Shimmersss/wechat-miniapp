/** 极简事件总线：跨页面通知（登录态变化、库存刷新等） */
const listeners = {};

function on(name, fn) {
  (listeners[name] = listeners[name] || []).push(fn);
  return () => off(name, fn);
}

function off(name, fn) {
  listeners[name] = (listeners[name] || []).filter((f) => f !== fn);
}

function emit(name, payload) {
  (listeners[name] || []).slice().forEach((fn) => {
    try {
      fn(payload);
    } catch (e) {
      console.error(`[events] ${name} handler error`, e);
    }
  });
}

module.exports = { on, off, emit };
