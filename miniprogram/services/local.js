/**
 * local.js - 本地会话缓存
 *
 * 为什么需要：RAGFlow 的 session 记录在服务端，但重新进入小程序时
 * 需要立刻恢复上次的对话界面（不能等接口返回），所以本地留一份快照。
 * 服务端 session_id 是权威数据源，本地只做展示加速。
 */

const { STORAGE_KEYS } = require('../utils/constants');

/** 最多保留的消息条数，避免 Storage 膨胀（小程序单 key 上限 1MB） */
const MAX_MESSAGES = 100;

function loadState() {
  let state = {};
  try {
    state = wx.getStorageSync(STORAGE_KEYS.MESSAGES) || {};
  } catch (err) {
    console.warn('[local] 读取会话失败', err);
  }
  return {
    sessionId: state.sessionId || wx.getStorageSync(STORAGE_KEYS.SESSION) || '',
    messages: Array.isArray(state.messages) ? state.messages : [],
  };
}

function saveState(sessionId, messages) {
  const list = Array.isArray(messages) ? messages.slice(-MAX_MESSAGES) : [];
  try {
    wx.setStorageSync(STORAGE_KEYS.MESSAGES, { sessionId: sessionId || '', messages: list });
    wx.setStorageSync(STORAGE_KEYS.SESSION, sessionId || '');
  } catch (err) {
    console.warn('[local] 保存会话失败', err);
  }
  return list;
}

function clear() {
  try {
    wx.removeStorageSync(STORAGE_KEYS.MESSAGES);
    wx.removeStorageSync(STORAGE_KEYS.SESSION);
  } catch (err) {
    /* ignore */
  }
}

module.exports = {
  MAX_MESSAGES,
  loadState,
  saveState,
  clear,
};
