/**
 * http.js - HTTP 基础设施（零依赖）
 *
 * 职责：
 *   - 读请求体（带大小保护）
 *   - 手写 multipart/form-data 解析（wx.uploadFile 用的就是这种格式）
 *   - 统一 JSON / SSE 响应（SSE 用于把大模型输出边收边推给小程序）
 *   - 出站请求封装（大模型、向量接口），流式读取用 StringDecoder 防止中文被切断
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { StringDecoder } = require('string_decoder');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Access-Token',
  'Access-Control-Max-Age': '86400',
};

/* ============================================================
 * 请求体
 * ============================================================ */

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const max = limit || 20 * 1024 * 1024;
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > max) {
        reject(new Error(`请求体超过上限 ${(max / 1024 / 1024).toFixed(0)}MB`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* ============================================================
 * multipart/form-data 解析
 * ============================================================ */

/**
 * @param {Buffer} buffer
 * @param {string} contentType
 * @returns {{fields: object, files: Array<{field:string, filename:string, contentType:string, data:Buffer}>}}
 */
function parseMultipart(buffer, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''));
  if (!boundaryMatch) {
    return { fields: {}, files: [] };
  }
  const boundary = `--${(boundaryMatch[1] || boundaryMatch[2]).trim()}`;

  // latin1 与字节一一对应，用它做切分不会破坏二进制内容
  const raw = buffer.toString('latin1');
  const segments = raw.split(boundary);

  const fields = {};
  const files = [];

  for (let i = 1; i < segments.length; i += 1) {
    let segment = segments[i];
    if (segment.startsWith('--')) {
      break; // 结束标记
    }
    if (segment.startsWith('\r\n')) {
      segment = segment.slice(2);
    }
    const headerEnd = segment.indexOf('\r\n\r\n');
    if (headerEnd < 0) {
      continue;
    }
    const headerText = segment.slice(0, headerEnd);
    let body = segment.slice(headerEnd + 4);
    if (body.endsWith('\r\n')) {
      body = body.slice(0, -2);
    }

    const disposition = /name="([^"]*)"/.exec(headerText);
    if (!disposition) {
      continue;
    }
    const field = disposition[1];
    const filenameMatch = /filename="([^"]*)"/.exec(headerText);
    const typeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headerText);

    if (filenameMatch) {
      const rawName = filenameMatch[1];
      // 文件名可能是 UTF-8 原始字节，先按 latin1 还原再按 utf8 解码
      let filename = '';
      try {
        filename = Buffer.from(rawName, 'latin1').toString('utf8');
      } catch (err) {
        filename = rawName;
      }
      files.push({
        field,
        filename: filename || rawName || 'unnamed',
        contentType: typeMatch ? typeMatch[1].trim() : '',
        data: Buffer.from(body, 'latin1'),
      });
    } else {
      const value = Buffer.from(body, 'latin1').toString('utf8');
      fields[field] = value;
    }
  }

  return { fields, files };
}

/* ============================================================
 * 响应
 * ============================================================ */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...CORS,
  });
  res.end(body);
}

/** 成功（对齐 RAGFlow 的 { code: 0, data } 信封） */
function ok(res, data) {
  sendJson(res, 200, { code: 0, data: data === undefined ? null : data });
}

/** 业务失败：HTTP 200 + code，与 RAGFlow 行为一致，前端只需看 body.code */
function fail(res, code, message) {
  sendJson(res, 200, { code: code || 500, message: message || '服务异常' });
}

/** 需要按 HTTP 语义返回时使用（鉴权失败等） */
function failHttp(res, status, message) {
  sendJson(res, status, { code: status, message });
}

function preflight(res) {
  res.writeHead(204, CORS);
  res.end();
}

/* ---------- SSE ---------- */

function startSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...CORS,
  });
  if (res.socket && res.socket.setNoDelay) {
    res.socket.setNoDelay(true);
  }

  let closed = false;
  return {
    /** 发送一条事件（结构对齐 RAGFlow：{ answer, reference }） */
    send(payload) {
      if (closed) {
        return false;
      }
      try {
        res.write(`data:${JSON.stringify(payload)}\n\n`);
        return true;
      } catch (err) {
        closed = true;
        return false;
      }
    },
    /** 心跳：防止中间代理因空闲断开 */
    ping() {
      if (!closed) {
        try {
          res.write(': ping\n\n');
        } catch (err) {
          closed = true;
        }
      }
    },
    done() {
      if (closed) {
        return;
      }
      closed = true;
      try {
        res.write('data:[DONE]\n\n');
        res.end();
      } catch (err) {
        /* ignore */
      }
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      try {
        res.end();
      } catch (err) {
        /* ignore */
      }
    },
    isClosed() {
      return closed;
    },
  };
}

/* ============================================================
 * 出站请求
 * ============================================================ */

function pickClient(url) {
  return url.protocol === 'https:' ? https : http;
}

/**
 * 一次性读取响应（适合 /embeddings 这类短响应）
 * @returns {Promise<{status:number, text:string}>}
 */
function requestText(options = {}) {
  const url = new URL(options.url);
  const client = pickClient(url);
  const body = options.body ? Buffer.from(options.body) : null;

  return new Promise((resolve, reject) => {
    const req = client.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: options.method || 'POST',
        headers: Object.assign({}, options.headers, {
          'Content-Length': body ? body.length : 0,
        }),
        timeout: options.timeout || 60000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            text: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error('上游请求超时'));
    });
    req.on('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

/**
 * 流式读取响应（适合大模型的 SSE）
 * @param {object} options
 * @param {(text: string) => void} options.onChunk 已按 UTF-8 正确切分的文本片段
 * @param {(meta: {status: number}) => void} [options.onStart]
 * @param {() => void} options.onEnd
 * @param {(err: Error) => void} options.onError
 */
function requestStream(options = {}) {
  const url = new URL(options.url);
  const client = pickClient(url);
  const body = options.body ? Buffer.from(options.body) : null;
  const decoder = new StringDecoder('utf8');
  let settled = false;

  const finish = (err) => {
    if (settled) {
      return;
    }
    settled = true;
    if (err) {
      options.onError && options.onError(err);
    } else {
      options.onEnd && options.onEnd();
    }
  };

  const req = client.request(
    {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: options.method || 'POST',
      headers: Object.assign({ Accept: 'text/event-stream' }, options.headers, {
        'Content-Length': body ? body.length : 0,
      }),
      timeout: options.timeout || 180000,
    },
    (res) => {
      options.onStart && options.onStart({ status: res.statusCode, headers: res.headers });
      res.on('data', (chunk) => {
        const text = decoder.write(chunk);
        if (text) {
          options.onChunk && options.onChunk(text);
        }
      });
      res.on('end', () => {
        const tail = decoder.end();
        if (tail) {
          options.onChunk && options.onChunk(tail);
        }
        finish(null);
      });
      res.on('error', (err) => finish(err));
    }
  );

  req.on('timeout', () => req.destroy(new Error('上游请求超时')));
  req.on('error', (err) => finish(err));
  if (body) {
    req.write(body);
  }
  req.end();

  return {
    abort() {
      try {
        req.destroy();
      } catch (err) {
        /* ignore */
      }
      finish(new Error('已取消'));
    },
  };
}

module.exports = {
  CORS,
  readBody,
  parseMultipart,
  sendJson,
  ok,
  fail,
  failHttp,
  preflight,
  startSse,
  requestText,
  requestStream,
};
