/**
 * index.js - 服务启动入口
 *
 * 零第三方依赖，只用 Node 内置模块。启动：
 *   node server/index.js            （或在项目根目录 npm run proxy）
 *
 * 想直接用 HTTPS 让小程序真机访问：配置 SSL_KEY_PATH / SSL_CERT_PATH 后重启，
 * 服务会自动切换为 https，此时配合自签证书需要在真机上信任，正式环境建议用域名 + 正式证书。
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');

const config = require('./config');
const store = require('./store');
const api = require('./api');
const seed = require('./seed');
const bm25 = require('./rag/bm25');
const httpUtil = require('./http');

const { CORS, preflight, sendJson, failHttp } = httpUtil;

/* ============================================================
 * 鉴权
 * ============================================================ */

/**
 * 鉴权，两条路走一条：
 *   1. 云托管 openid 白名单 —— 网关已注入 X-WX-OPENID，身份由微信验过，命中名单即放行
 *   2. 访问令牌 ACCESS_TOKEN —— 自建服务器/局域网调试时用
 * 配了白名单就优先走白名单（内部使用最省事，不用在小程序里存任何密钥）。
 */
function checkAuth(req) {
  const openid = String(req.headers['x-wx-openid'] || '').trim();
  const allowList = config.cloudRun.allowOpenids;

  if (allowList.length) {
    return !!openid && allowList.indexOf(openid) >= 0;
  }

  if (!config.accessToken) {
    return true;
  }
  const headerToken = req.headers['x-access-token'];
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const token = headerToken || bearer;
  return !!token && token === config.accessToken;
}

/** 鉴权失败时给出对得上的提示，避免对着错误信息瞎猜 */
function authFailMessage(req) {
  if (config.cloudRun.allowOpenids.length) {
    return '当前微信账号不在允许访问的名单里，请让管理员把你的 openid 加入 ALLOW_OPENIDS';
  }
  return '访问令牌无效，请在小程序设置页填写与服务端 ACCESS_TOKEN 一致的值';
}

/* ============================================================
 * 简易控制台页（浏览器打开根路径即可自查）
 * ============================================================ */

function statusPage() {
  const datasets = store.all('datasets');
  const documents = store.all('documents');
  const chats = store.all('chats');
  const sessions = store.all('sessions');
  const rows = [
    ['知识库', `${datasets.length} 个`, '可在小程序「知识库」中管理，或 POST /api/v1/datasets'],
    ['文档', `${documents.length} 篇`, 'POST /api/v1/datasets/{id}/documents'],
    ['切片', `${datasets.reduce((sum, d) => sum + store.getChunks(d.id).length, 0)} 条`, 'GET /api/v1/datasets/{id}/chunks'],
    ['助手', `${chats.length} 个`, 'POST /api/v1/chats'],
    ['会话', `${sessions.length} 个`, 'GET /api/v1/chats/{id}/sessions'],
  ];

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>羽衣 RAG 引擎</title>
<style>
  body{margin:0;padding:40px 24px;background:#0b0e1a;color:#eef1fa;
    font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;}
  .wrap{max-width:760px;margin:0 auto}
  h1{font-size:22px;margin:0 0 6px}
  .sub{color:#6f7899;font-size:13px;margin-bottom:28px}
  table{width:100%;border-collapse:collapse;background:#151a2d;border-radius:10px;overflow:hidden}
  td{padding:14px 16px;border-bottom:1px solid #262e4a;font-size:14px}
  tr:last-child td{border-bottom:none}
  td:first-child{color:#a8b0cc;width:90px}
  td:nth-child(2){color:#22d3ee;font-weight:600;width:90px}
  td:last-child{color:#6f7899;font-size:12px}
  .tag{display:inline-block;padding:3px 10px;border-radius:12px;font-size:12px;margin-right:8px;
    background:rgba(124,92,255,.16);border:1px solid rgba(124,92,255,.34);color:#a78bfa}
  .ok{background:rgba(52,211,153,.14);border-color:rgba(52,211,153,.34);color:#34d399}
  .warn{background:rgba(251,191,36,.14);border-color:rgba(251,191,36,.34);color:#fbbf24}
</style></head><body><div class="wrap">
  <h1>羽衣电竞问答助手 · RAG 引擎</h1>
  <div class="sub">零依赖自建知识库与聊天助手服务 · ${store.now()}</div>
  <div style="margin-bottom:22px">
    <span class="tag ${config.llm.enabled ? 'ok' : 'warn'}">大模型：${
    config.llm.enabled ? config.llm.model : '未配置（问答退化为检索结果直出）'
  }</span>
    <span class="tag ${config.embedding.enabled ? 'ok' : 'warn'}">向量检索：${
    config.embedding.enabled ? config.embedding.model : '未启用（BM25 关键词）'
  }</span>
    <span class="tag ${config.accessToken ? 'ok' : 'warn'}">访问令牌：${
    config.accessToken ? '已启用' : '未设置'
  }</span>
  </div>
  <table>${rows
    .map((row) => `<tr><td>${row[0]}</td><td>${row[1]}</td><td>${row[2]}</td></tr>`)
    .join('')}</table>
  <div class="sub" style="margin-top:22px">健康检查：<code>GET /health</code></div>
</div></body></html>`;
}

/* ============================================================
 * 请求分发
 * ============================================================ */

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    preflight(res);
    return;
  }

  if (url.pathname === '/' && req.method === 'GET') {
    const html = statusPage();
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html),
      ...CORS,
    });
    res.end(html);
    return;
  }

  if (url.pathname === '/health' && req.method === 'GET') {
    const handled = await api.route(req, res, url);
    if (!handled) {
      sendJson(res, 200, { code: 0, data: { status: 'ok' } });
    }
    return;
  }

  if (!checkAuth(req)) {
    failHttp(res, 401, authFailMessage(req));
    return;
  }

  const handled = await api.route(req, res, url);
  if (!handled) {
    sendJson(res, 404, { code: 404, message: `接口不存在：${req.method} ${url.pathname}` });
  }
}

/* ============================================================
 * 启动
 * ============================================================ */

function localAddresses() {
  const list = [];
  const interfaces = os.networkInterfaces();
  Object.keys(interfaces).forEach((name) => {
    (interfaces[name] || []).forEach((item) => {
      if (item.family === 'IPv4' && !item.internal) {
        list.push(item.address);
      }
    });
  });
  return list;
}

function banner() {
  const lines = [];
  lines.push('');
  lines.push('  羽衣电竞问答助手 · RAG 引擎（零依赖自建）');
  lines.push('  ────────────────────────────────────────────');
  config.describe().forEach((line) => lines.push(`  ${line}`));
  lines.push('');
  lines.push('  可用地址（小程序设置页填这个）：');
  lines.push(`    本机模拟器   http://127.0.0.1:${config.port}`);
  localAddresses().forEach((ip) => {
    lines.push(`    局域网真机   http://${ip}:${config.port}`);
  });
  lines.push('');
  lines.push('  自检页：浏览器打开上面任一地址即可');
  lines.push('');
  return lines.join('\n');
}

async function start() {
  store.init();

  // 云托管容器文件系统不持久，冷启动/扩容后数据会回到镜像初始状态。
  // 知识库为空时自动把 server/knowledge 下的制度文档灌回去，保证服务一启动就能问答。
  if (config.cloudRun.autoSeed && !store.all('datasets').length) {
    console.log('[start] 知识库为空，自动导入 server/knowledge …');
    try {
      const result = await seed.run({ quiet: false });
      console.log(
        `[start] 导入完成：${result.stats.parsedDocCount}/${result.stats.docCount} 文档，` +
          `${result.stats.chunkCount} 切片`
      );
    } catch (err) {
      console.error('[start] 自动导入失败（服务继续启动，可稍后手动导入）：', err.message);
    }
  }

  // 预热各知识库的检索索引，首个请求不再等待
  store.all('datasets').forEach((dataset) => {
    try {
      bm25.getIndex(dataset.id);
    } catch (err) {
      console.warn(`[start] 知识库 ${dataset.name} 索引预热失败：`, err.message);
    }
  });

  const useHttps = !!(config.ssl.keyPath && config.ssl.certPath);
  let server;

  if (useHttps) {
    try {
      server = https.createServer(
        {
          key: fs.readFileSync(config.ssl.keyPath),
          cert: fs.readFileSync(config.ssl.certPath),
        },
        (req, res) => {
          handle(req, res).catch((err) => {
            console.error('[server] 未捕获异常', err);
            if (!res.headersSent) {
              sendJson(res, 500, { code: 500, message: '服务异常' });
            }
          });
        }
      );
    } catch (err) {
      console.error('[server] HTTPS 证书加载失败，已回退到 HTTP：', err.message);
      server = null;
    }
  }

  if (!server) {
    server = http.createServer((req, res) => {
      handle(req, res).catch((err) => {
        console.error('[server] 未捕获异常', err);
        if (!res.headersSent) {
          sendJson(res, 500, { code: 500, message: '服务异常' });
        }
      });
    });
  }

  server.timeout = 0;
  server.keepAliveTimeout = 65000;

  server.listen(config.port, config.host, () => {
    console.log(banner());
  });

  const shutdown = () => {
    console.log('\n[server] 正在关闭…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  start().catch((err) => {
    console.error('[server] 启动失败：', err);
    process.exit(1);
  });
}

module.exports = { start, handle };
