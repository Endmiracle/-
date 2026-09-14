/**
 * cloud.js - 微信云托管调用通道
 *
 * ── 为什么需要单独这条通道 ────────────────────────────────
 * 云托管服务的默认域名是腾讯云的，既不能配进小程序 request 合法域名
 * （配置还要求域名已备案），官方给的调用方式就是 wx.cloud.callContainer：
 * 走内网、不需要配域名、不需要备案、不需要在客户端存任何密钥。
 *
 * ── 代价（务必知道，这是选云托管唯一的功能损失）────────────
 * callContainer 拿不到 RequestTask，不支持 onChunkReceived，
 * 所以**没有流式输出**：问答要等服务端全部生成完才一次性返回。
 * 由此带来两个约束：
 *   1. 超时上限 15 秒（官方限制，超过按 15 秒算）
 *   2. 前端「停止生成」按钮在云托管模式下不可用（请求发出后无法中断）
 *
 * 引擎侧已经支持 stream:false，所以这里只是换个通道，业务代码不用改。
 */

const CLOUD_TIMEOUT_MAX = 15000;
const CLOUD_TIMEOUT_MIN = 3000;

/** 取一个合法的超时值：官方上限 15 秒 */
function clampTimeout(value) {
  const timeout = Number(value) || 0;
  if (!timeout) {
    return CLOUD_TIMEOUT_MAX;
  }
  return Math.min(CLOUD_TIMEOUT_MAX, Math.max(CLOUD_TIMEOUT_MIN, timeout));
}

/** wx.cloud 是否可用 */
function available() {
  return typeof wx !== 'undefined' && wx && typeof wx.cloud === 'object' && wx.cloud;
}

/**
 * 把云托管/云开发的原始错误翻译成人话
 * 这类错误原本长这样：{ errMsg: "cloud.callContainer:fail -501000 ..." }
 */
function normalizeError(err) {
  if (err && err.code && err.message) {
    return err; // 已经是归一化错误
  }
  const raw = String((err && err.errMsg) || (err && err.message) || err || '未知错误');

  if (raw.indexOf('init') >= 0 || raw.indexOf('not initialized') >= 0) {
    return {
      code: -1,
      message: '云开发未初始化。请填好云环境 ID 后完全退出小程序再进（改环境需要冷启动）。',
    };
  }
  if (raw.indexOf('-501000') >= 0 || raw.indexOf('env') >= 0) {
    return { code: -2, message: '云环境 ID 不对或当前小程序没关联该环境，请到设置页核对。' };
  }
  if (raw.indexOf('service') >= 0 || raw.indexOf('404') >= 0) {
    return { code: -3, message: '云托管服务名不对，请到「云托管 - 服务列表」核对后重填。' };
  }
  if (raw.indexOf('timeout') >= 0 || raw.indexOf('超时') >= 0) {
    return {
      code: -4,
      message: '等待超过 15 秒（云托管上限）。可换个更快的大模型，或在助手配置里减少 Top-K。',
    };
  }
  if (raw.indexOf('network') >= 0 || raw.indexOf('fail') >= 0) {
    return { code: -5, message: '网络异常，请检查手机网络后重试。' };
  }
  return { code: -9, message: `云托管调用失败：${raw}` };
}

/**
 * 调用云托管服务
 * @param {object}  options
 * @param {string}  options.env       云环境 ID
 * @param {string}  options.service   云托管服务名
 * @param {string}  options.path      业务路径，如 /api/v1/chats
 * @param {string}  [options.method]  默认 GET
 * @param {object}  [options.data]    请求体（会自动 JSON 序列化）
 * @param {object}  [options.header]  额外请求头
 * @param {number}  [options.timeout] 毫秒，上限 15000
 * @param {string}  [options.dataType] json | text
 * @returns {Promise<{statusCode:number, data:any, header:object}>}
 */
function call(options) {
  const opts = options || {};

  if (!available()) {
    return Promise.reject({
      code: -6,
      message: '当前基础库不支持云开发，请把调试基础库调到 2.13.1 以上。',
    });
  }
  if (!opts.env) {
    return Promise.reject({ code: -2, message: '未填写云环境 ID，请到设置页填写。' });
  }
  if (!opts.service) {
    return Promise.reject({ code: -3, message: '未填写云托管服务名，请到设置页填写。' });
  }

  return new Promise((resolve, reject) => {
    wx.cloud.callContainer({
      config: { env: opts.env },
      path: String(opts.path || '/').replace(/^\/+/, '/') || '/',
      method: (opts.method || 'GET').toUpperCase(),
      data: opts.data === undefined ? undefined : opts.data,
      header: Object.assign({ 'X-WX-SERVICE': opts.service }, opts.header || {}),
      timeout: clampTimeout(opts.timeout),
      dataType: opts.dataType || 'json',
      success: (res) => {
        resolve({
          statusCode: res.statusCode,
          data: res.data,
          header: res.header || {},
        });
      },
      fail: (err) => {
        reject(normalizeError(err));
      },
    });
  });
}

/** 云托管模式下的健康检查（走 /health，路径不在 /api/v1 下） */
function health(options) {
  return call(
    Object.assign({}, options, { path: '/health', method: 'GET', timeout: 8000 })
  );
}

module.exports = {
  call,
  health,
  available,
  normalizeError,
  clampTimeout,
  CLOUD_TIMEOUT_MAX,
};
