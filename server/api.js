/**
 * api.js - 引擎对外接口
 *
 * 路径与语义对齐 RAGFlow 的官方 SDK 接口，好处是小程序端只换 baseURL 与鉴权头
 * 就能在这套自建引擎与真实 RAGFlow 之间切换，前端零改动。
 *
 * 约定：
 *   成功 → HTTP 200 + { code: 0, data }
 *   业务失败 → HTTP 200 + { code: <非0>, message }（与 RAGFlow 行为一致）
 *   鉴权失败 → HTTP 401 + { code: 401, message }
 */

const fs = require('fs');
const path = require('path');

const config = require('./config');
const store = require('./store');
const httpUtil = require('./http');
const llm = require('./llm');
const prompt = require('./prompt');
const ingest = require('./rag/ingest');
const retrieve = require('./rag/retrieve');
const bm25 = require('./rag/bm25');

const { ok, fail, sendJson, readBody, parseMultipart, startSse } = httpUtil;

const FILES_DIR = path.join(config.dataDir, 'files');

function ensureFilesDir() {
  if (!fs.existsSync(FILES_DIR)) {
    fs.mkdirSync(FILES_DIR, { recursive: true });
  }
}

function fileOf(docId) {
  return path.join(FILES_DIR, `${docId}.src`);
}

function clamp(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, num));
}

/* ============================================================
 * 知识库
 * ============================================================ */

function datasetStats(datasetId) {
  const documents = store.find('documents', (doc) => doc.datasetId === datasetId);
  const chunks = store.getChunks(datasetId);
  return {
    docCount: documents.length,
    parsedDocCount: documents.filter((doc) => doc.status === 'parsed').length,
    parsingDocCount: documents.filter((doc) => doc.status === 'parsing').length,
    failedDocCount: documents.filter((doc) => doc.status === 'failed').length,
    chunkCount: chunks.length,
    charCount: chunks.reduce((sum, chunk) => sum + (chunk.content ? chunk.content.length : 0), 0),
  };
}

function decorateDataset(dataset) {
  return Object.assign({}, dataset, datasetStats(dataset.id));
}

function listDatasets() {
  return store
    .all('datasets')
    .map(decorateDataset)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

function createDataset(body) {
  const name = String(body.name || '').trim();
  if (!name) {
    throw { code: 400, message: '请填写知识库名称' };
  }
  const dataset = store.insert('datasets', {
    name: name.slice(0, 40),
    description: String(body.description || '').trim().slice(0, 200),
    chunkSize: clamp(body.chunkSize, 120, 2000, config.chunk.size),
    chunkOverlap: clamp(body.chunkOverlap, 0, 400, config.chunk.overlap),
    embeddingModel: config.embedding.enabled ? config.embedding.model : '',
  });
  return decorateDataset(dataset);
}

function updateDataset(id, body) {
  const dataset = store.get('datasets', id);
  if (!dataset) {
    throw { code: 404, message: '知识库不存在' };
  }
  const patch = {};
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) {
      throw { code: 400, message: '知识库名称不能为空' };
    }
    patch.name = name.slice(0, 40);
  }
  if (body.description !== undefined) {
    patch.description = String(body.description).trim().slice(0, 200);
  }
  if (body.chunkSize !== undefined) {
    patch.chunkSize = clamp(body.chunkSize, 120, 2000, dataset.chunkSize);
  }
  if (body.chunkOverlap !== undefined) {
    patch.chunkOverlap = clamp(body.chunkOverlap, 0, 400, dataset.chunkOverlap);
  }
  return decorateDataset(store.update('datasets', id, patch));
}

function deleteDataset(id) {
  const dataset = store.get('datasets', id);
  if (!dataset) {
    throw { code: 404, message: '知识库不存在' };
  }
  const docs = store.find('documents', (doc) => doc.datasetId === id);
  docs.forEach((doc) => removeSourceFile(doc.id));
  store.removeWhere('documents', (doc) => doc.datasetId === id);
  store.dropChunks(id);
  bm25.invalidate(id);
  // 解绑引用了该知识库的助手
  store.find('chats', (chat) => (chat.datasetIds || []).indexOf(id) >= 0).forEach((chat) => {
    store.update('chats', chat.id, {
      datasetIds: (chat.datasetIds || []).filter((item) => item !== id),
    });
  });
  store.remove('datasets', id);
  return { id, removedDocs: docs.length };
}

/* ============================================================
 * 文档与解析
 * ============================================================ */

function removeSourceFile(docId) {
  try {
    const file = fileOf(docId);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  } catch (err) {
    /* ignore */
  }
}

function decorateDocument(doc) {
  return Object.assign(
    {
      chunkCount: 0,
      progress: 0,
      progressMsg: '',
      error: '',
      warning: '',
    },
    doc
  );
}

function listDocuments(datasetId) {
  return store
    .find('documents', (doc) => doc.datasetId === datasetId)
    .map(decorateDocument)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/**
 * 创建文档：文件或纯文本都落成一份 .src，解析在后台异步进行
 * 这样小程序不会因为大文件解析而超时，用户也能看到「解析中」状态
 */
function createDocument(datasetId, input) {
  const dataset = store.get('datasets', datasetId);
  if (!dataset) {
    throw { code: 404, message: '知识库不存在' };
  }

  const name = String(input.name || '').trim() || '未命名文档';
  const doc = store.insert('documents', {
    datasetId,
    name: name.slice(0, 80),
    sourceType: input.buffer ? 'file' : 'text',
    mime: input.mime || '',
    size: input.buffer ? input.buffer.length : Buffer.byteLength(String(input.text || ''), 'utf8'),
    status: 'parsing',
    progress: 0.02,
    progressMsg: '已入库，等待解析',
    chunkCount: 0,
    error: '',
  });

  ensureFilesDir();
  const payload = input.buffer || Buffer.from(String(input.text || ''), 'utf8');
  fs.writeFileSync(fileOf(doc.id), payload);

  // 后台解析，不阻塞响应
  setImmediate(() => {
    runParse(datasetId, doc.id).catch((err) => {
      console.error('[api] 解析异常', err);
    });
  });

  return decorateDocument(doc);
}

/** 解析单个文档：抽取文本 → 切片 → 向量 → 写库 */
async function runParse(datasetId, docId) {
  const dataset = store.get('datasets', datasetId);
  const doc = store.get('documents', docId);
  if (!dataset || !doc) {
    return;
  }

  const update = (patch) => store.update('documents', docId, patch);

  try {
    update({ status: 'parsing', progress: 0.1, progressMsg: '读取文件', error: '' });

    const file = fileOf(docId);
    if (!fs.existsSync(file)) {
      throw new Error('源文件已丢失，请重新上传');
    }
    const buffer = fs.readFileSync(file);

    update({ progress: 0.3, progressMsg: '抽取文本' });
    const extracted = ingest.extractText({
      filename: doc.name,
      buffer: doc.sourceType === 'file' ? buffer : undefined,
      text: doc.sourceType === 'text' ? buffer.toString('utf8') : undefined,
    });

    if (!extracted.text || extracted.text.length < 10) {
      throw new Error('未能解析出有效文本（内容过短）');
    }

    update({ progress: 0.5, progressMsg: '切分片段' });
    const chunks = ingest.chunkText(extracted.text, {
      size: dataset.chunkSize,
      overlap: dataset.chunkOverlap,
      minSize: config.chunk.minSize,
    });

    if (!chunks.length) {
      throw new Error('切片结果为空，请检查文档内容');
    }

    // 覆盖式重建：先清掉该文档的旧切片
    store.removeChunksOfDoc(datasetId, docId);

    const records = chunks.map((chunk) => ({
      id: store.newId(),
      datasetId,
      docId,
      docName: doc.name,
      index: chunk.index,
      heading: chunk.heading,
      content: chunk.content,
      charCount: chunk.charCount,
      createdAt: store.now(),
    }));

    if (config.embedding.enabled) {
      update({ progress: 0.7, progressMsg: `生成向量（${config.embedding.model}）` });
      await retrieve.attachVectors(records);
    }

    store.appendChunks(datasetId, records);
    bm25.invalidate(datasetId);

    update({
      status: 'parsed',
      progress: 1,
      progressMsg: '解析完成',
      chunkCount: records.length,
      warning: extracted.warning || '',
      parser: extracted.parser,
      charCount: extracted.text.length,
      parsedAt: store.now(),
    });
  } catch (err) {
    update({
      status: 'failed',
      progress: 1,
      progressMsg: '解析失败',
      error: err.message || '解析失败',
    });
  }
}

function reparseDocument(datasetId, docId) {
  const doc = store.get('documents', docId);
  if (!doc || doc.datasetId !== datasetId) {
    throw { code: 404, message: '文档不存在' };
  }
  store.update('documents', docId, {
    status: 'parsing',
    progress: 0.02,
    progressMsg: '等待重新解析',
    error: '',
  });
  setImmediate(() => {
    runParse(datasetId, docId).catch(() => {});
  });
  return decorateDocument(store.get('documents', docId));
}

function deleteDocument(datasetId, docId) {
  const doc = store.get('documents', docId);
  if (!doc || doc.datasetId !== datasetId) {
    throw { code: 404, message: '文档不存在' };
  }
  store.removeChunksOfDoc(datasetId, docId);
  bm25.invalidate(datasetId);
  removeSourceFile(docId);
  store.remove('documents', docId);
  return { id: docId };
}

function listChunks(datasetId, query) {
  const all = store.getChunks(datasetId);
  const offset = clamp(query.offset, 0, Number.MAX_SAFE_INTEGER, 0);
  const limit = clamp(query.limit, 1, 200, 50);
  const keyword = String(query.keyword || '').trim();

  const filtered = keyword
    ? all.filter((chunk) => chunk.content.indexOf(keyword) >= 0 || chunk.docName.indexOf(keyword) >= 0)
    : all;

  return {
    total: filtered.length,
    offset,
    limit,
    chunks: filtered.slice(offset, offset + limit),
  };
}

/* ============================================================
 * 助手
 * ============================================================ */

const DEFAULT_CHAT_NAME = '羽衣电竞问答助手';

function decorateChat(chat) {
  const datasets = (chat.datasetIds || [])
    .map((id) => store.get('datasets', id))
    .filter(Boolean)
    .map((item) => ({ id: item.id, name: item.name }));
  return Object.assign({}, chat, {
    datasets,
    datasetCount: datasets.length,
  });
}

function listChats() {
  return store
    .all('chats')
    .map(decorateChat)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

function createChat(body) {
  const name = String(body.name || '').trim() || DEFAULT_CHAT_NAME;
  const datasetIds = Array.isArray(body.datasetIds) ? body.datasetIds.filter(Boolean) : [];
  const chat = store.insert('chats', {
    name: name.slice(0, 40),
    description: String(body.description || '').trim().slice(0, 200),
    systemPrompt: String(body.systemPrompt || prompt.DEFAULT_SYSTEM_PROMPT),
    prologue: String(
      body.prologue ||
        '你好，我是羽衣电竞问答助手。关于赛事、战队、规则的问题都可以问我。'
    ).slice(0, 500),
    datasetIds,
    topK: clamp(body.topK, 1, 20, config.retrieval.topK),
    similarityThreshold: clamp(body.similarityThreshold, 0, 1, config.retrieval.similarityThreshold),
    hybridAlpha: clamp(body.hybridAlpha, 0, 1, config.retrieval.hybridAlpha),
    temperature: clamp(body.temperature, 0, 2, config.llm.temperature),
    maxTokens: clamp(body.maxTokens, 64, 8192, config.llm.maxTokens),
    model: String(body.model || '').trim(),
  });
  return decorateChat(chat);
}

function updateChat(id, body) {
  const chat = store.get('chats', id);
  if (!chat) {
    throw { code: 404, message: '助手不存在' };
  }
  const patch = {};
  if (body.name !== undefined) {
    patch.name = String(body.name).trim().slice(0, 40) || chat.name;
  }
  if (body.description !== undefined) {
    patch.description = String(body.description).trim().slice(0, 200);
  }
  if (body.systemPrompt !== undefined) {
    patch.systemPrompt = String(body.systemPrompt);
  }
  if (body.prologue !== undefined) {
    patch.prologue = String(body.prologue).slice(0, 500);
  }
  if (body.datasetIds !== undefined) {
    patch.datasetIds = Array.isArray(body.datasetIds) ? body.datasetIds.filter(Boolean) : [];
  }
  if (body.topK !== undefined) {
    patch.topK = clamp(body.topK, 1, 20, chat.topK);
  }
  if (body.similarityThreshold !== undefined) {
    patch.similarityThreshold = clamp(body.similarityThreshold, 0, 1, chat.similarityThreshold);
  }
  if (body.hybridAlpha !== undefined) {
    patch.hybridAlpha = clamp(body.hybridAlpha, 0, 1, chat.hybridAlpha);
  }
  if (body.temperature !== undefined) {
    patch.temperature = clamp(body.temperature, 0, 2, chat.temperature);
  }
  if (body.maxTokens !== undefined) {
    patch.maxTokens = clamp(body.maxTokens, 64, 8192, chat.maxTokens);
  }
  if (body.model !== undefined) {
    patch.model = String(body.model).trim();
  }
  return decorateChat(store.update('chats', id, patch));
}

function deleteChat(id) {
  const chat = store.get('chats', id);
  if (!chat) {
    throw { code: 404, message: '助手不存在' };
  }
  const removed = store.removeWhere('sessions', (session) => session.chatId === id);
  store.remove('chats', id);
  return { id, removedSessions: removed };
}

/* ============================================================
 * 会话
 * ============================================================ */

function decorateSession(session) {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const last = messages.filter((item) => item.role === 'user' || item.role === 'assistant').slice(-1)[0];
  return Object.assign({}, session, {
    messageCount: messages.length,
    messages,
    preview: last ? String(last.content || '').replace(/\s+/g, ' ').slice(0, 60) : '',
  });
}

function listSessions(chatId) {
  // 先校验助手存在：助手被删除后应返回 404，而不是一个空的会话列表，
  // 否则前端无法区分「没有会话」与「助手已经不存在了」
  if (!store.get('chats', chatId)) {
    throw { code: 404, message: '助手不存在或已被删除' };
  }
  return store
    .find('sessions', (session) => session.chatId === chatId)
    .map(decorateSession)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

function createSession(chatId, body) {
  const chat = store.get('chats', chatId);
  if (!chat) {
    throw { code: 404, message: '助手不存在' };
  }
  const messages = [];
  if (chat.prologue) {
    messages.push({
      role: 'assistant',
      content: chat.prologue,
      reference: null,
      createdAt: store.now(),
    });
  }
  const session = store.insert('sessions', {
    chatId,
    name: String(body.name || '').trim() || `${chat.name} 的会话`,
    messages,
  });
  return decorateSession(session);
}

function getSession(chatId, sessionId) {
  const session = store.get('sessions', sessionId);
  if (!session || session.chatId !== chatId) {
    throw { code: 404, message: '会话不存在' };
  }
  return decorateSession(session);
}

function deleteSessions(chatId, ids) {
  const list = Array.isArray(ids) ? ids : [ids];
  const removed = store.removeWhere(
    'sessions',
    (session) => session.chatId === chatId && list.indexOf(session.id) >= 0
  );
  return { removed };
}

/* ============================================================
 * 检索测试
 * ============================================================ */

async function testRetrieval(body) {
  const datasetIds = Array.isArray(body.dataset_ids || body.datasetIds)
    ? body.dataset_ids || body.datasetIds
    : [];
  const question = String(body.question || '').trim();
  if (!question) {
    throw { code: 400, message: '请输入检索问题' };
  }
  const result = await retrieve.search({
    datasetIds,
    question,
    topK: clamp(body.top_k || body.topK, 1, 50, config.retrieval.topK),
    threshold: clamp(body.threshold, 0, 1, config.retrieval.similarityThreshold),
    alpha: clamp(body.alpha, 0, 1, config.retrieval.hybridAlpha),
  });
  return {
    question,
    total: result.chunks.length,
    chunks: result.chunks,
    stats: result.stats,
  };
}

/* ============================================================
 * 问答（SSE）
 * ============================================================ */

/**
 * 生成回答：统一封装「未配置大模型降级 / 大模型流式 / 大模型失败兜底」三种情况
 * @param {(text: string) => void} [options.onDelta] 传入则边生成边回调（流式模式）
 * @returns {{promise: Promise<{answer: string, degraded: boolean, error: string}>, abort: Function}}
 */
function generateAnswer(options) {
  const { question, chunks, chat, messages } = options;

  if (!llm.isEnabled()) {
    return {
      promise: Promise.resolve({
        answer: prompt.fallbackAnswer(question, chunks),
        degraded: true,
        error: '',
      }),
      abort() {},
    };
  }

  let task = null;
  const promise = new Promise((resolve) => {
    let answer = '';
    task = llm.chatStream({
      messages,
      temperature: chat.temperature,
      maxTokens: chat.maxTokens,
      model: chat.model || undefined,
      onDelta: (delta) => {
        answer += delta;
        if (options.onDelta) {
          options.onDelta(answer);
        }
      },
      onEnd: () => resolve({ answer, degraded: false, error: '' }),
      onError: (err) => {
        const message = (err && err.message) || '生成失败';
        if (answer) {
          // 已经出了一部分内容：保留，只标记中断原因
          resolve({ answer, degraded: false, error: message });
          return;
        }
        resolve({
          answer: `${prompt.fallbackAnswer(question, chunks)}\n\n（大模型调用失败：${message}）`,
          degraded: true,
          error: message,
        });
      },
    });
  });

  return {
    promise,
    abort() {
      if (task) {
        task.abort();
      }
    },
  };
}

/** 一轮问答落库 */
function persistTurn(session, chat, question, answer, reference, errorMessage) {
  const messages = (session.messages || []).slice();
  messages.push({ role: 'user', content: question, reference: null, createdAt: store.now() });
  messages.push({
    role: 'assistant',
    content: answer,
    reference: errorMessage ? null : reference,
    error: errorMessage || '',
    createdAt: store.now(),
  });

  const autoName =
    session.name && session.name.indexOf('的会话') < 0 ? session.name : question.slice(0, 20);

  store.update('sessions', session.id, {
    messages,
    name: autoName,
    lastQuestion: question,
  });
}

async function handleCompletions(req, res, chatId, body) {
  const chat = store.get('chats', chatId);
  if (!chat) {
    return fail(res, 404, '助手不存在');
  }

  const question = String(body.question || '').trim();
  if (!question) {
    return fail(res, 400, '问题不能为空');
  }

  // 会话：没有就新建，保证多轮对话有上下文
  let session = body.session_id ? store.get('sessions', body.session_id) : null;
  if (!session || session.chatId !== chatId) {
    const created = createSession(chatId, { name: question.slice(0, 20) });
    session = store.get('sessions', created.id);
  }

  const searchResult = await retrieve.search({
    datasetIds: chat.datasetIds || [],
    question,
    topK: chat.topK,
    threshold: chat.similarityThreshold,
    alpha: chat.hybridAlpha,
  });

  const reference = prompt.buildReference(searchResult.chunks);

  // 多轮上下文：剔除开场白（它不是真实对话，会干扰模型）
  const contextHistory = (session.messages || [])
    .filter((item) => (item.role === 'user' || item.role === 'assistant') && item.content)
    .filter(
      (item) => !(chat.prologue && item.role === 'assistant' && item.content === chat.prologue)
    )
    .slice(-6);

  const built = prompt.buildMessages({
    question,
    chunks: searchResult.chunks,
    systemPrompt: chat.systemPrompt,
    chatName: chat.name,
    prologue: chat.prologue,
    history: contextHistory,
  });

  /* ---------- 非流式：一次聚合后返回 JSON ---------- */
  if (body.stream === false) {
    const result = await generateAnswer({
      question,
      chunks: searchResult.chunks,
      chat,
      messages: built.messages,
    }).promise;
    persistTurn(session, chat, question, result.answer, reference, result.error);
    return ok(res, {
      answer: result.answer,
      reference,
      session_id: session.id,
      degraded: result.degraded,
      error: result.error,
      stats: searchResult.stats,
    });
  }

  /* ---------- 流式：SSE ---------- */
  const sse = startSse(res);
  // 先回一帧元信息，小程序可以立刻拿到 session_id 与引用
  sse.send({ answer: '', reference, session_id: session.id, stats: searchResult.stats });

  const heartbeat = setInterval(() => sse.ping(), 15000);
  let closed = false;
  let generator = null;

  req.on('close', () => {
    closed = true;
    if (generator) {
      generator.abort();
    }
    clearInterval(heartbeat);
  });

  const finish = (answer, errorMessage, degraded) => {
    clearInterval(heartbeat);
    if (closed) {
      return;
    }
    persistTurn(session, chat, question, answer, reference, errorMessage);
    sse.send({
      answer,
      reference,
      session_id: session.id,
      final: true,
      degraded: !!degraded,
      error: errorMessage || '',
    });
    sse.done();
  };

  // 生成过程中通过 onDelta 推帧，前端即可逐字渲染
  generator = generateAnswer({
    question,
    chunks: searchResult.chunks,
    chat,
    messages: built.messages,
    onDelta: (text) => {
      if (!closed) {
        sse.send({ answer: text, reference, session_id: session.id });
      }
    },
  });

  const result = await generator.promise;

  if (result.degraded && !result.error && !closed) {
    // 未配置大模型：answer 是一次性给出的，补推一帧让前端拿到全文
    sse.send({ answer: result.answer, reference, session_id: session.id, degraded: true });
  }

  finish(result.answer, result.error, result.degraded);
}

/* ============================================================
 * 路由
 * ============================================================ */

/**
 * @returns {boolean} 是否已处理该请求
 */
async function route(req, res, url) {
  const method = req.method.toUpperCase();
  const segments = url.pathname.split('/').filter(Boolean);
  const query = url.searchParams;

  /* ---------- 健康检查 ---------- */
  if (segments[0] === 'health') {
    sendJson(res, 200, {
      code: 0,
      data: {
        status: 'ok',
        time: store.now(),
        llm: llm.info(),
        embedding: {
          enabled: config.embedding.enabled,
          model: config.embedding.model || '',
        },
        counts: {
          datasets: store.all('datasets').length,
          documents: store.all('documents').length,
          chats: store.all('chats').length,
          sessions: store.all('sessions').length,
        },
      },
    });
    return true;
  }

  /* ---------- 统一前缀 /api/v1 ---------- */
  if (segments[0] !== 'api' || segments[1] !== 'v1') {
    return false;
  }
  const parts = segments.slice(2);

  let body = {};
  if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
    const raw = await readBody(req, config.maxUploadSize + 1024 * 1024);
    const contentType = req.headers['content-type'] || '';
    if (contentType.indexOf('multipart/form-data') >= 0) {
      const parsed = parseMultipart(raw, contentType);
      body = parsed.fields || {};
      body.__files = parsed.files || [];
    } else if (raw.length) {
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch (err) {
        return fail(res, 400, '请求体不是合法 JSON');
      }
    }
  }

  const [resource, resourceId, sub, subId, action] = parts;

  try {
    /* ---------- 知识库 ---------- */
    if (resource === 'datasets') {
      if (!resourceId) {
        if (method === 'GET') {
          return ok(res, listDatasets()) || true;
        }
        if (method === 'POST') {
          return ok(res, createDataset(body)) || true;
        }
      } else if (!sub) {
        if (method === 'GET') {
          const dataset = store.get('datasets', resourceId);
          if (!dataset) {
            return fail(res, 404, '知识库不存在') || true;
          }
          return ok(res, decorateDataset(dataset)) || true;
        }
        if (method === 'PUT') {
          return ok(res, updateDataset(resourceId, body)) || true;
        }
        if (method === 'DELETE') {
          return ok(res, deleteDataset(resourceId)) || true;
        }
      } else if (sub === 'documents') {
        if (!subId) {
          if (method === 'GET') {
            return ok(res, listDocuments(resourceId)) || true;
          }
          if (method === 'POST') {
            const files = body.__files || [];
            if (files.length) {
              const file = files[0];
              return ok(
                res,
                createDocument(resourceId, {
                  name: body.name || file.filename,
                  buffer: file.data,
                  mime: file.contentType,
                })
              ) || true;
            }
            if (!String(body.text || '').trim()) {
              return fail(res, 400, '请提供文档内容（text）或上传文件') || true;
            }
            return ok(
              res,
              createDocument(resourceId, { name: body.name, text: body.text })
            ) || true;
          }
        } else if (!action) {
          if (method === 'DELETE') {
            return ok(res, deleteDocument(resourceId, subId)) || true;
          }
          if (method === 'GET') {
            const doc = store.get('documents', subId);
            if (!doc || doc.datasetId !== resourceId) {
              return fail(res, 404, '文档不存在') || true;
            }
            return ok(res, decorateDocument(doc)) || true;
          }
        } else if (action === 'chunks' && method === 'GET') {
          const chunks = store.getChunks(resourceId).filter((chunk) => chunk.docId === subId);
          return ok(res, { total: chunks.length, chunks }) || true;
        } else if (action === 'reparse' && method === 'POST') {
          return ok(res, reparseDocument(resourceId, subId)) || true;
        }
      } else if (sub === 'chunks' && method === 'GET') {
        return ok(
          res,
          listChunks(resourceId, {
            offset: query.get('offset'),
            limit: query.get('limit'),
            keyword: query.get('keyword'),
          })
        ) || true;
      }
    }

    /* ---------- 检索测试 ---------- */
    if (resource === 'retrieval' && method === 'POST') {
      return ok(res, await testRetrieval(body)) || true;
    }

    /* ---------- 助手 ---------- */
    if (resource === 'chats') {
      if (!resourceId) {
        if (method === 'GET') {
          return ok(res, listChats()) || true;
        }
        if (method === 'POST') {
          return ok(res, createChat(body)) || true;
        }
      } else if (!sub) {
        if (method === 'GET') {
          const chat = store.get('chats', resourceId);
          if (!chat) {
            return fail(res, 404, '助手不存在') || true;
          }
          return ok(res, decorateChat(chat)) || true;
        }
        if (method === 'PUT') {
          return ok(res, updateChat(resourceId, body)) || true;
        }
        if (method === 'DELETE') {
          return ok(res, deleteChat(resourceId)) || true;
        }
      } else if (sub === 'sessions') {
        if (!subId) {
          if (method === 'GET') {
            return ok(res, listSessions(resourceId)) || true;
          }
          if (method === 'POST') {
            return ok(res, createSession(resourceId, body)) || true;
          }
          if (method === 'DELETE') {
            return ok(res, deleteSessions(resourceId, body.ids)) || true;
          }
        } else if (method === 'GET') {
          return ok(res, getSession(resourceId, subId)) || true;
        }
      } else if (sub === 'completions' && method === 'POST') {
        await handleCompletions(req, res, resourceId, body);
        return true;
      }
    }

    return fail(res, 404, `接口不存在：${method} ${url.pathname}`);
  } catch (err) {
    if (err && err.code) {
      return fail(res, err.code, err.message) || true;
    }
    console.error('[api] 处理异常', err);
    return fail(res, 500, (err && err.message) || '服务异常') || true;
  }
}

module.exports = {
  route,
  runParse,
  createDocument,
  createDataset,
  createChat,
  updateChat,
  datasetStats,
  fail,
  FILES_DIR,
};
