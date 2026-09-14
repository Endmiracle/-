/**
 * request.js - 统一网络层
 *
 * 提供两个能力：
 *   requestJSON(options)  普通请求，自动拆 RAGFlow 的 { code, data } 信封
 *   openStream(options)   分块（流式）请求，内部接好 UTF-8 增量解码 + SSE 解析
 *
 * 关于分块：wx.request 需开启 enableChunked（基础库 2.20.2+），
 * 分片通过 requestTask.onChunkReceived 回调拿到，拿到的是 ArrayBuffer。
 */

const { createUtf8Decoder, createSSEParser } = require('./stream');
const cloud = require('./cloud');
const config = require('./config');

/* ============================================================
 * 通道判定
 * ============================================================ */

/**
 * 服务层习惯只透传 url + header（const { url, header } = config.resolve(...)），
 * 云托管模式还缺 env / service。这里按「url 是否绝对地址」自动补全：
 *   - 绝对地址（http…）→ HTTP 通道（自建服务 / 直连）
 *   - 相对路径（/api/v1/…）→ 说明上一步 resolve 走的是云托管，补上云参数
 * 这样服务层一个调用点都不用改。
 */
function withCloudChannel(options) {
  if (options.mode === 'cloud') {
    return options;
  }
  const url = String(options.url || '');
  if (!url || /^https?:\/\//i.test(url)) {
    return options;
  }
  const last = config.current();
  if (last && last.mode === 'cloud') {
    return Object.assign({}, options, {
      mode: 'cloud',
      env: last.env,
      service: last.service,
      path: url,
    });
  }
  return options;
}

/* ============================================================
 * 错误归一化
 * ============================================================ */

/**
 * 把 wx.request 的失败信息翻译成用户能看懂、能照做的提示。
 * 小程序联调阶段 90% 的失败都落在这几条上。
 */
function mapFail(err) {
  const msg = (err && err.errMsg) || '';
  if (/timeout/i.test(msg)) {
    return {
      code: -2,
      message: '请求超时。本地模型推理较慢，可在设置页调大超时时间',
    };
  }
  if (/not in domain list|domain list/i.test(msg)) {
    return {
      code: -3,
      message:
        '域名未通过校验：开发者工具中请勾选「详情 → 本地设置 → 不校验合法域名」；真机请使用「真机调试」模式',
    };
  }
  if (/abort/i.test(msg)) {
    return { code: -4, message: '已取消' };
  }
  if (/ERR_CONNECTION|refused|ECONNREFUSED/i.test(msg)) {
    return { code: -5, message: '连接被拒绝，请检查地址、端口以及服务是否已启动' };
  }
  if (/ssl|certificate/i.test(msg)) {
    return { code: -6, message: '证书校验失败，HTTPS 证书需为受信任的正式证书' };
  }
  return { code: -1, message: msg || '网络异常，请稍后重试' };
}

function normalizeError(raw) {
  const err = raw || {};
  return {
    code: typeof err.code === 'number' ? err.code : -1,
    message: err.message || '请求失败',
    detail: err.detail || null,
  };
}

/** 拆信封：RAGFlow 与代理服务统一返回 { code: 0, data } / { code, message } */
function unwrap(body, statusCode) {
  if (body && typeof body === 'object' && body.code !== undefined) {
    if (body.code === 0) {
      return { ok: true, data: body.data };
    }
    return {
      ok: false,
      error: normalizeError({ code: body.code, message: body.message || '服务返回错误', detail: body }),
    };
  }
  if (statusCode >= 200 && statusCode < 300) {
    return { ok: true, data: body };
  }
  return {
    ok: false,
    error: normalizeError({ code: statusCode, message: `HTTP ${statusCode}`, detail: body }),
  };
}

/* ============================================================
 * 普通请求
 * ============================================================ */

function requestJSON(rawOptions = {}) {
  const options = withCloudChannel(rawOptions);

  // 云托管：走 callContainer，其余逻辑（拆信封、错误归一化）与 HTTP 完全一致
  if (options.mode === 'cloud') {
    return cloud
      .call({
        env: options.env,
        service: options.service,
        path: options.path,
        method: options.method,
        data: options.data,
        header: options.header,
        timeout: options.timeout,
      })
      .then((res) => {
        const result = unwrap(res.data, res.statusCode);
        if (result.ok) {
          return result.data;
        }
        throw result.error;
      })
      .catch((err) => {
        throw normalizeError(err);
      });
  }

  return new Promise((resolve, reject) => {
    wx.request({
      url: options.url,
      method: options.method || 'GET',
      data: options.data || {},
      header: options.header || { 'Content-Type': 'application/json' },
      timeout: options.timeout || 30000,
      success: (res) => {
        const result = unwrap(res.data, res.statusCode);
        if (result.ok) {
          resolve(result.data);
        } else {
          reject(result.error);
        }
      },
      fail: (err) => reject(normalizeError(mapFail(err))),
    });
  });
}

/* ============================================================
 * 分块流式请求
 * ============================================================ */

/**
 * @param {object} options
 * @param {string} options.url
 * @param {object} [options.data]
 * @param {object} [options.header]
 * @param {number} [options.timeout]
 * @param {(obj: object) => void} options.onEvent  每条 SSE JSON 事件
 * @param {(text: string) => void} [options.onText] 非 JSON 的 data 行
 * @param {() => void} options.onEnd               结束（成功）
 * @param {(err: object) => void} options.onError  失败
 * @returns {{abort: Function}}
 */
function openStream(rawOptions = {}) {
  const options = withCloudChannel(rawOptions);

  // 云托管拿不到 RequestTask，无法分片接收。上层应先用 config.useStream() 判断，
  // 这里再兜一层，避免误调时静默无反应。
  if (options.mode === 'cloud') {
    if (options.onError) {
      options.onError(
        normalizeError({
          code: -7,
          message: '云托管模式不支持流式输出，请改用非流式问答（设置页可切换为自建服务以启用流式）',
        })
      );
    }
    return { abort() {} };
  }

  const decoder = createUtf8Decoder();
  let raw = '';
  let sawEvent = false;
  let finished = false;
  let aborted = false;
  let statusCode = 0;

  const onEvent = options.onEvent || function () {};
  const onText = options.onText || function () {};
  const onEnd = options.onEnd || function () {};
  const onError = options.onError || function () {};

  const parser = createSSEParser({
    onEvent: (obj) => {
      sawEvent = true;
      onEvent(obj);
    },
    onText: (text) => {
      sawEvent = true;
      onText(text);
    },
  });

  function tryParse(text) {
    try {
      return JSON.parse(text);
    } catch (err) {
      return null;
    }
  }

  function finalize() {
    if (finished || aborted) {
      return;
    }
    finished = true;
    parser.end();

    if (sawEvent) {
      onEnd();
      return;
    }

    const trimmed = raw.trim();
    if (!trimmed) {
      if (statusCode >= 400) {
        onError(normalizeError({ code: statusCode, message: `HTTP ${statusCode}` }));
      } else {
        onError(normalizeError({ code: -7, message: '服务没有返回任何内容' }));
      }
      return;
    }

    const body = tryParse(trimmed);
    if (body && typeof body === 'object' && (body.code !== undefined || body.message)) {
      onError(
        normalizeError({
          code: body.code === undefined ? statusCode : body.code,
          message: body.message || `HTTP ${statusCode}`,
          detail: body,
        })
      );
      return;
    }

    if (statusCode >= 400) {
      onError(normalizeError({ code: statusCode, message: `HTTP ${statusCode}` }));
      return;
    }

    // 服务端按纯文本整段返回（非 SSE），降级当作文本处理
    onText(trimmed);
    onEnd();
  }

  const task = wx.request({
    url: options.url,
    method: options.method || 'POST',
    data: options.data || {},
    header: options.header || { 'Content-Type': 'application/json' },
    timeout: options.timeout || 90000,
    enableChunked: true,
    responseType: 'arraybuffer',
    success: (res) => {
      statusCode = res.statusCode || 0;
      finalize();
    },
    fail: (err) => {
      if (aborted) {
        return;
      }
      finished = true;
      onError(normalizeError(mapFail(err)));
    },
  });

  if (!task || typeof task.onChunkReceived !== 'function') {
    finished = true;
    onError(
      normalizeError({
        code: -8,
        message: '当前微信基础库不支持分块接收。请在开发者工具「详情 → 本地设置」把调试基础库调至 2.20.2 以上',
      })
    );
    return {
      abort() {},
    };
  }

  task.onChunkReceived((res) => {
    const text = decoder.decode(res.data);
    if (!text) {
      return;
    }
    if (!sawEvent && raw.length < 4000) {
      // 只保留开头一段用于「非 SSE 错误体」的诊断
      raw += text.slice(0, 4000 - raw.length);
    }
    parser.feed(text);
  });

  return {
    abort() {
      if (finished) {
        return;
      }
      aborted = true;
      finished = true;
      try {
        task.abort();
      } catch (err) {
        /* ignore */
      }
    },
  };
}

module.exports = {
  requestJSON,
  openStream,
  normalizeError,
  mapFail,
};
