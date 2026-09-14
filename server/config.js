/**
 * config.js - 引擎配置
 *
 * 全部通过环境变量注入，也支持 server/.env 文件（本文件内置极简解析，零依赖）。
 * 优先级：环境变量 > server/.env > 代码默认值
 *
 * 最小可用配置（只跑检索引擎、不接大模型）：
 *   PORT=8787
 *
 * 接入大模型问答（OpenAI 兼容接口，DeepSeek / OpenAI / 硅基流动 / Ollama 均可）：
 *   LLM_BASE_URL=https://api.deepseek.com/v1
 *   LLM_API_KEY=sk-xxx
 *   LLM_MODEL=deepseek-chat
 *
 * 可选：开启向量检索增强（不配置则纯 BM25 关键词检索，同样可用）
 *   EMBEDDING_BASE_URL=https://api.siliconflow.cn/v1
 *   EMBEDDING_API_KEY=sk-xxx
 *   EMBEDDING_MODEL=BAAI/bge-m3
 */

const fs = require('fs');
const path = require('path');

/** ---------- 极简 .env 解析 ---------- */
function loadEnvFile() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) {
    return {};
  }
  const out = {};
  try {
    fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
          return;
        }
        const index = trimmed.indexOf('=');
        if (index < 0) {
          return;
        }
        const key = trimmed.slice(0, index).trim();
        let value = trimmed.slice(index + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        out[key] = value;
      });
  } catch (err) {
    console.warn('[config] .env 解析失败：', err.message);
  }
  return out;
}

const fileEnv = loadEnvFile();

/**
 * 取配置值：环境变量 > server/.env > 代码默认值
 *
 * 注意「空字符串也算显式设置」：环境变量里写了 LLM_API_KEY=（空），
 * 就表示这一项被显式关闭，不应该再回退到 .env 里的值。
 * 否则会出现「想禁用却读到 .env 里的真实 Key，测试偷偷烧掉线上额度」的情况。
 */
function raw(key, fallback) {
  if (process.env[key] !== undefined) {
    return process.env[key];
  }
  if (fileEnv[key] !== undefined && fileEnv[key] !== '') {
    return fileEnv[key];
  }
  return fallback;
}

function num(key, fallback) {
  const value = Number(raw(key, ''));
  return Number.isFinite(value) && value !== 0 ? value : fallback;
}

function bool(key, fallback = false) {
  const value = String(raw(key, '')).toLowerCase();
  if (!value) {
    return fallback;
  }
  return value === '1' || value === 'true' || value === 'yes';
}

const llmBaseUrl = raw('LLM_BASE_URL', 'https://api.deepseek.com/v1');
const llmApiKey = raw('LLM_API_KEY', '');

const embeddingModel = raw('EMBEDDING_MODEL', '');

const config = {
  // 用 num 而不是 Number(raw(...))：环境变量被显式置空时不会算出 0 端口
  port: num('PORT', 8787),
  host: raw('HOST', '0.0.0.0'),

  /** 访问令牌：非空时所有 /api 请求必须带 X-Access-Token 或 Authorization */
  accessToken: raw('ACCESS_TOKEN', ''),

  /**
   * 微信云托管相关
   * 部署到云托管后，容器会收到网关注入的 X-WX-OPENID（调用者身份）。
   * 配了 ALLOW_OPENIDS 就只放行名单内的人 —— 内部使用最省事的访问控制：
   * 不需要 ACCESS_TOKEN，也不需要用户登陆，网关已经帮你把身份验好了。
   */
  cloudRun: {
    /** 是否运行在云托管环境（自动识别，也可显式开） */
    enabled: bool('CLOUD_RUN', false),
    /** 允许访问的 openid 列表，逗号分隔；留空表示不限制 */
    allowOpenids: String(raw('ALLOW_OPENIDS', ''))
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
    /** 容器启动且知识库为空时，自动导入 server/knowledge 下的制度文档 */
    autoSeed: bool('AUTO_SEED', true),
  },

  /** 数据目录（JSON 持久化） */
  dataDir: path.resolve(__dirname, raw('DATA_DIR', 'data')),

  /** 文件上传大小上限（字节） */
  maxUploadSize: num('MAX_UPLOAD_MB', 20) * 1024 * 1024,

  /** 大模型（OpenAI 兼容 /chat/completions） */
  llm: {
    baseUrl: String(llmBaseUrl).replace(/\/+$/, ''),
    apiKey: llmApiKey,
    model: raw('LLM_MODEL', 'deepseek-chat'),
    temperature: num('LLM_TEMPERATURE', 0.3),
    maxTokens: num('LLM_MAX_TOKENS', 1024),
    timeoutMs: num('LLM_TIMEOUT_MS', 180000),
    enabled: !!llmApiKey,
  },

  /** 向量检索（可选增强）。未配置时降级为纯 BM25 */
  embedding: {
    enabled: !!embeddingModel,
    baseUrl: String(raw('EMBEDDING_BASE_URL', llmBaseUrl)).replace(/\/+$/, ''),
    apiKey: raw('EMBEDDING_API_KEY', llmApiKey),
    model: embeddingModel,
    timeoutMs: num('EMBEDDING_TIMEOUT_MS', 60000),
    batchSize: num('EMBEDDING_BATCH_SIZE', 16),
  },

  /** 检索默认参数（可在助手上覆盖） */
  retrieval: {
    topK: num('RETRIEVAL_TOP_K', 5),
    similarityThreshold: num('RETRIEVAL_THRESHOLD', 0.15),
    /** 混合检索中 BM25 的权重，1 = 纯关键词，0 = 纯向量 */
    hybridAlpha: num('RETRIEVAL_ALPHA', 0.5),
  },

  /** 切片默认参数（可在知识库上覆盖） */
  chunk: {
    size: num('CHUNK_SIZE', 500),
    overlap: num('CHUNK_OVERLAP', 80),
    minSize: num('CHUNK_MIN_SIZE', 60),
  },

  /** HTTPS（可选，配置后小程序可直连） */
  ssl: {
    keyPath: raw('SSL_KEY_PATH', ''),
    certPath: raw('SSL_CERT_PATH', ''),
  },

  debug: bool('DEBUG', false),
};

/** 启动时的配置体检，把问题一次性讲清楚 */
function describe() {
  const lines = [];
  lines.push(`服务地址：http://${config.host}:${config.port}`);
  lines.push(`数据目录：${config.dataDir}`);
  lines.push(`访问令牌：${config.accessToken ? '已启用' : '未设置（仅建议本机调试）'}`);
  if (config.cloudRun.enabled) {
    lines.push(
      config.cloudRun.allowOpenids.length
        ? `云托管：openid 白名单 ${config.cloudRun.allowOpenids.length} 人`
        : '云托管：未限制 openid（建议配置 ALLOW_OPENIDS）'
    );
  }
  lines.push(
    config.llm.enabled
      ? `大模型：${config.llm.model} @ ${config.llm.baseUrl}`
      : '大模型：未配置 LLM_API_KEY，问答接口将只返回检索结果（检索/切片功能正常可用）'
  );
  lines.push(
    config.embedding.enabled
      ? `向量检索：${config.embedding.model} @ ${config.embedding.baseUrl}`
      : '向量检索：未启用，使用 BM25 关键词检索'
  );
  if (config.ssl.keyPath && config.ssl.certPath) {
    lines.push('HTTPS：已配置证书');
  }
  return lines;
}

module.exports = {
  ...config,
  describe,
};
