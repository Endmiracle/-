/**
 * config.js - 运行时配置（读写本地 Storage）
 *
 * 为什么要做成运行时配置而不是写死在代码里：
 *   联调时需要反复换服务地址（127.0.0.1 / 局域网 IP / 穿透域名），
 *   写死意味着每次都要改代码 + 重新编译。放在设置页里改，即时生效。
 */

const { DEFAULT_CONFIG, STORAGE_KEYS, API_PREFIX } = require('./constants');

/** 内存缓存，避免每次请求都读 Storage */
let cache = null;

/**
 * 最近一次 resolve 的结果。
 * 服务层习惯写成 const { url, header } = config.resolve(...)，只往下传 url 与 header；
 * 云托管模式还需要 env / service，请求层通过这里补上，服务层就不必逐个改调用点。
 */
let lastResolved = null;

/** 取最近一次解析结果（请求层补全云托管参数用） */
function current() {
  return lastResolved;
}

/** 读取配置（缺失字段用默认值补齐，便于版本升级后兼容旧配置） */
function load() {
  if (cache) {
    return cache;
  }
  let stored = {};
  try {
    stored = wx.getStorageSync(STORAGE_KEYS.CONFIG) || {};
  } catch (err) {
    console.warn('[config] 读取失败，使用默认值', err);
  }
  cache = Object.assign({}, DEFAULT_CONFIG, stored);
  return cache;
}

/** 写入配置（只接受白名单字段） */
function save(patch) {
  const current = load();
  const next = Object.assign({}, current);
  Object.keys(DEFAULT_CONFIG).forEach((key) => {
    if (patch[key] !== undefined) {
      next[key] = patch[key];
    }
  });
  cache = next;
  try {
    wx.setStorageSync(STORAGE_KEYS.CONFIG, next);
  } catch (err) {
    console.error('[config] 保存失败', err);
    throw { code: 500, message: '配置保存失败，请检查存储空间' };
  }
  const app = getApp();
  if (app && app.globalData) {
    app.globalData.config = next;
  }
  return next;
}

/** 恢复默认配置 */
function reset() {
  cache = Object.assign({}, DEFAULT_CONFIG);
  try {
    wx.setStorageSync(STORAGE_KEYS.CONFIG, cache);
  } catch (err) {
    /* ignore */
  }
  const app = getApp();
  if (app && app.globalData) {
    app.globalData.config = cache;
  }
  return cache;
}

/** 去掉末尾斜杠，避免拼出 // 路径 */
function trimSlash(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

/**
 * 把逻辑路径解析成真实请求地址与请求头 —— 两种模式的差异全部收敛在这里。
 *
 * @param {string} path 形如 'chats' 或 'chats/xxx/completions'（不含 /api/v1 前缀）
 * @returns {{url: string, header: object, mode: string}}
 */
function resolve(path) {
  const cfg = load();
  const suffix = `${API_PREFIX}/${String(path || '').replace(/^\/+/, '')}`;

  // 云托管：不走 HTTP 域名，交给 wx.cloud.callContainer 走内网
  if (cfg.mode === 'cloud') {
    if (!String(cfg.cloudEnv || '').trim()) {
      throw { code: 400, message: '请先在设置页填写云开发环境 ID' };
    }
    if (!String(cfg.cloudService || '').trim()) {
      throw { code: 400, message: '请先在设置页填写云托管服务名' };
    }
    lastResolved = {
      mode: 'cloud',
      /** 云模式下 url 字段即业务路径，保持字段名一致便于上层统一取用 */
      url: suffix,
      path: suffix,
      env: String(cfg.cloudEnv).trim(),
      service: String(cfg.cloudService).trim(),
      header: { 'Content-Type': 'application/json' },
      timeout: cfg.timeout,
    };
    return lastResolved;
  }

  if (cfg.mode === 'direct') {
    if (!trimSlash(cfg.ragflowBase)) {
      throw { code: 400, message: '请先在设置页填写 RAGFlow 地址' };
    }
    if (!cfg.apiKey) {
      throw { code: 400, message: '直连模式需要填写 RAGFlow API Key' };
    }
    lastResolved = {
      url: trimSlash(cfg.ragflowBase) + suffix,
      header: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      mode: 'direct',
    };
    return lastResolved;
  }

  if (!trimSlash(cfg.proxyBase)) {
    throw { code: 400, message: '请先在设置页填写代理服务地址' };
  }
  const header = { 'Content-Type': 'application/json' };
  if (cfg.accessToken) {
    header['X-Access-Token'] = cfg.accessToken;
  }
  lastResolved = {
    url: trimSlash(cfg.proxyBase) + suffix,
    header,
    mode: 'proxy',
  };
  return lastResolved;
}

/** 配置是否已具备发起请求的最低条件 */
function isReady() {
  const cfg = load();
  try {
    resolve('chats');
    return !!cfg.chatId;
  } catch (err) {
    return false;
  }
}

/** 供设置页展示的「当前生效地址」文案 */
function describeEndpoint() {
  const cfg = load();
  if (cfg.mode === 'cloud') {
    return `云托管 · ${cfg.cloudEnv || '未填环境 ID'} / ${cfg.cloudService || '未填服务名'}`;
  }
  const base = cfg.mode === 'direct' ? cfg.ragflowBase : cfg.proxyBase;
  return `${cfg.mode === 'direct' ? '直连' : '代理'} · ${trimSlash(base) || '未填写'}`;
}

/** 云托管模式下强制关闭流式（callContainer 不支持分片接收） */
function useStream() {
  const cfg = load();
  return cfg.mode === 'cloud' ? false : !!cfg.stream;
}

module.exports = {
  load,
  save,
  reset,
  resolve,
  current,
  isReady,
  describeEndpoint,
  useStream,
  trimSlash,
};
