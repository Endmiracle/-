/**
 * chat.js - 聊天助手、会话与问答（含流式）
 *
 * 对接自建引擎，路径与响应结构对齐 RAGFlow 的官方 SDK 接口，
 * 因此把 baseURL 指向真实 RAGFlow 也能工作（设置页可切换）。
 *
 *   GET    /api/v1/chats                        助手列表
 *   POST   /api/v1/chats                        创建助手
 *   PUT    /api/v1/chats/{id}                   更新助手
 *   DELETE /api/v1/chats/{id}                   删除助手
 *   GET    /api/v1/chats/{id}/sessions          会话列表
 *   POST   /api/v1/chats/{id}/sessions          创建会话
 *   DELETE /api/v1/chats/{id}/sessions          删除会话
 *   POST   /api/v1/chats/{id}/completions       问答（SSE）
 */

const config = require('../utils/config');
const { requestJSON, openStream, normalizeError } = require('../utils/request');
const { mergeChunk, normalizeReference } = require('../utils/stream');

/* ============================================================
 * 容错解析（不同后端字段略有差异）
 * ============================================================ */

function toArray(data) {
  if (Array.isArray(data)) {
    return data;
  }
  const keys = ['items', 'chats', 'sessions', 'data'];
  for (const key of keys) {
    if (data && Array.isArray(data[key])) {
      return data[key];
    }
  }
  return [];
}

function normalizeChat(raw) {
  const datasetIds = Array.isArray(raw.datasetIds)
    ? raw.datasetIds
    : Array.isArray(raw.dataset_ids)
    ? raw.dataset_ids
    : [];
  return {
    id: raw.id || raw.chat_id || '',
    name: raw.name || '未命名助手',
    description: raw.description || '',
    prologue: raw.prologue || '',
    systemPrompt: raw.systemPrompt || '',
    datasetIds,
    datasets: Array.isArray(raw.datasets) ? raw.datasets : [],
    datasetCount:
      typeof raw.datasetCount === 'number' ? raw.datasetCount : datasetIds.length,
    topK: typeof raw.topK === 'number' ? raw.topK : 5,
    similarityThreshold:
      typeof raw.similarityThreshold === 'number' ? raw.similarityThreshold : 0.15,
    hybridAlpha: typeof raw.hybridAlpha === 'number' ? raw.hybridAlpha : 0.5,
    temperature: typeof raw.temperature === 'number' ? raw.temperature : 0.3,
    maxTokens: typeof raw.maxTokens === 'number' ? raw.maxTokens : 1024,
    model: raw.model || '',
  };
}

function normalizeSession(raw) {
  const messages = Array.isArray(raw.messages) ? raw.messages : [];
  const last = messages
    .filter((item) => item.role === 'user' || item.role === 'assistant')
    .slice(-1)[0];
  return {
    id: raw.id || raw.session_id || '',
    chatId: raw.chatId || raw.chat_id || '',
    name: raw.name || '未命名会话',
    messages,
    messageCount: typeof raw.messageCount === 'number' ? raw.messageCount : messages.length,
    preview: raw.preview || (last ? String(last.content || '').replace(/\s+/g, ' ').slice(0, 60) : ''),
    updatedAt: raw.updatedAt || raw.update_date || raw.create_date || '',
  };
}

/* ============================================================
 * 助手
 * ============================================================ */

function listChats() {
  const { url, header } = config.resolve('chats?page=1&page_size=50');
  return requestJSON({ url, header, timeout: 20000 }).then((data) =>
    toArray(data).map(normalizeChat).filter((item) => item.id)
  );
}

function getChat(chatId) {
  const { url, header } = config.resolve(`chats/${chatId}`);
  return requestJSON({ url, header, timeout: 20000 }).then(normalizeChat);
}

function createChat(payload) {
  const { url, header } = config.resolve('chats');
  return requestJSON({ url, header, method: 'POST', data: payload, timeout: 20000 }).then(normalizeChat);
}

function updateChat(chatId, patch) {
  const { url, header } = config.resolve(`chats/${chatId}`);
  return requestJSON({ url, header, method: 'PUT', data: patch, timeout: 20000 }).then(normalizeChat);
}

function deleteChat(chatId) {
  const { url, header } = config.resolve(`chats/${chatId}`);
  return requestJSON({ url, header, method: 'DELETE', timeout: 20000 });
}

/* ============================================================
 * 会话
 * ============================================================ */

function listSessions(chatId) {
  const id = chatId || config.load().chatId;
  if (!id) {
    return Promise.reject(normalizeError({ code: 400, message: '尚未选择助手，请先到「助手」页选择' }));
  }
  const { url, header } = config.resolve(`chats/${id}/sessions?page=1&page_size=50`);
  return requestJSON({ url, header, timeout: 20000 }).then((data) =>
    toArray(data).map(normalizeSession).filter((item) => item.id)
  );
}

function createSession(chatId, name) {
  const id = chatId || config.load().chatId;
  if (!id) {
    return Promise.reject(normalizeError({ code: 400, message: '尚未选择助手' }));
  }
  const { url, header } = config.resolve(`chats/${id}/sessions`);
  return requestJSON({
    url,
    header,
    method: 'POST',
    data: name ? { name } : {},
    timeout: 20000,
  }).then((data) => {
    const raw = data && data.session ? data.session : data || {};
    const session = normalizeSession(raw);
    const prologueMsg = session.messages.find((item) => item.role === 'assistant');
    session.prologue = prologueMsg ? String(prologueMsg.content || '') : '';
    return session;
  });
}

function deleteSessions(chatId, sessionIds) {
  const id = chatId || config.load().chatId;
  const ids = Array.isArray(sessionIds) ? sessionIds : [sessionIds];
  if (!id || !ids.length) {
    return Promise.reject(normalizeError({ code: 400, message: '参数不完整' }));
  }
  const { url, header } = config.resolve(`chats/${id}/sessions`);
  return requestJSON({ url, header, method: 'DELETE', data: { ids }, timeout: 20000 });
}

/* ============================================================
 * 问答
 * ============================================================ */

function extractAnswer(obj) {
  if (!obj || typeof obj !== 'object') {
    return '';
  }
  if (typeof obj.answer === 'string') {
    return obj.answer;
  }
  if (obj.data && typeof obj.data.answer === 'string') {
    return obj.data.answer;
  }
  const choice = Array.isArray(obj.choices) ? obj.choices[0] : null;
  if (choice) {
    if (choice.delta && typeof choice.delta.content === 'string') {
      return choice.delta.content;
    }
    if (choice.message && typeof choice.message.content === 'string') {
      return choice.message.content;
    }
  }
  return '';
}

function extractReference(obj) {
  if (!obj || typeof obj !== 'object') {
    return null;
  }
  return obj.reference || (obj.data && obj.data.reference) || null;
}

function extractError(obj) {
  if (!obj || typeof obj !== 'object') {
    return null;
  }
  if (typeof obj.code === 'number' && obj.code !== 0) {
    return normalizeError({ code: obj.code, message: obj.message || '问答失败' });
  }
  return null;
}

/**
 * 提问
 *
 * @param {object} options
 * @param {string} options.question
 * @param {string} [options.chatId]
 * @param {string} [options.sessionId]
 * @param {(text: string) => void} options.onDelta       合并后的完整回答（直接替换气泡内容）
 * @param {(ref: object) => void} [options.onReference]  引用来源
 * @param {(meta: object) => void} [options.onMeta]      首帧元信息（session_id / 检索统计）
 * @param {(text: string) => void} [options.onEnd]       结束，参数为最终回答
 * @param {(err: object) => void} options.onError
 * @returns {{abort: Function}}
 */
function ask(options) {
  const cfg = config.load();
  const chatId = options.chatId || cfg.chatId;
  const onDelta = options.onDelta || function () {};
  const onReference = options.onReference || function () {};
  const onMeta = options.onMeta || function () {};
  const onEnd = options.onEnd || function () {};
  const onError = options.onError || function () {};

  if (!chatId) {
    onError(normalizeError({ code: 400, message: '尚未选择助手，请先到「助手」页选择' }));
    return { abort() {} };
  }

  let endpoint;
  try {
    endpoint = config.resolve(`chats/${chatId}/completions`);
  } catch (err) {
    onError(normalizeError(err));
    return { abort() {} };
  }

  // 云托管模式强制非流式（callContainer 不支持分片接收）
  const useStream = config.useStream();

  const payload = {
    question: String(options.question || '').trim(),
    stream: useStream,
  };
  if (options.sessionId) {
    payload.session_id = options.sessionId;
  }

  /* ---------- 非流式 ---------- */
  if (!useStream) {
    const task = { aborted: false };
    requestJSON({
      url: endpoint.url,
      header: endpoint.header,
      method: 'POST',
      data: payload,
      timeout: cfg.timeout,
    })
      .then((data) => {
        if (task.aborted) {
          return;
        }
        const answer = String((data && (data.answer || data.content)) || '');
        if (data && data.session_id) {
          onMeta({ sessionId: data.session_id, stats: data.stats });
        }
        if (data && data.reference) {
          onReference(normalizeReference(data.reference));
        }
        if (!answer) {
          onError(normalizeError({ code: -9, message: '未获得回答内容' }));
          return;
        }
        onDelta(answer);
        onEnd(answer);
      })
      .catch((err) => {
        if (!task.aborted) {
          onError(normalizeError(err));
        }
      });
    return {
      abort() {
        task.aborted = true;
      },
    };
  }

  /* ---------- 流式 ---------- */
  let answer = '';
  let reference = null;
  let sessionId = options.sessionId || '';
  let streamError = null;
  let sawMeta = false;

  const stream = openStream({
    url: endpoint.url,
    header: endpoint.header,
    method: 'POST',
    data: payload,
    timeout: cfg.timeout,
    onEvent: (obj) => {
      const err = extractError(obj);
      if (err) {
        streamError = err;
        return;
      }

      if (!sawMeta) {
        sawMeta = true;
        sessionId = obj.session_id || sessionId;
        onMeta({ sessionId, stats: obj.stats || null, degraded: !!obj.degraded });
      } else if (obj.session_id) {
        sessionId = obj.session_id;
      }

      const ref = extractReference(obj);
      if (ref) {
        reference = ref;
        onReference(normalizeReference(ref));
      }

      const piece = extractAnswer(obj);
      if (piece) {
        answer = mergeChunk(answer, piece);
        onDelta(answer);
      }
    },
    onText: (text) => {
      if (text) {
        answer = mergeChunk(answer, text);
        onDelta(answer);
      }
    },
    onEnd: () => {
      if (streamError) {
        onError(streamError);
        return;
      }
      if (!answer) {
        onError(normalizeError({ code: -9, message: '未获得回答内容' }));
        return;
      }
      onEnd(answer);
    },
    onError: (err) => {
      if (answer) {
        // 已经出了一部分：保留内容，仅提示被中断
        onEnd(answer);
        return;
      }
      onError(err);
    },
  });

  return {
    abort() {
      stream.abort();
    },
  };
}

/* ============================================================
 * 连通性自检（设置页）
 * ============================================================ */

function diagnose() {
  const steps = [];
  const cfg = config.load();

  const push = (label, ok, detail) => {
    steps.push({ label, ok, detail });
    return ok;
  };

  let endpoint = null;
  try {
    endpoint = config.resolve('chats');
    push('配置检查', true, config.describeEndpoint());
  } catch (err) {
    push('配置检查', false, (err && err.message) || '配置不完整');
    return Promise.resolve(steps);
  }

  return listChats()
    .then((chats) => {
      push('拉取助手列表', true, `共 ${chats.length} 个助手`);
      if (!chats.length) {
        push('助手可用性', false, '还没有助手，请到「助手」页点右下角新建一个');
        return steps;
      }
      const matched = chats.find((item) => item.id === cfg.chatId);
      push(
        '助手可用性',
        true,
        matched
          ? `已选中「${matched.name}」，绑定 ${matched.datasetCount} 个知识库`
          : `当前选中的助手不在列表中，建议重新选择（可选「${chats[0].name}」）`
      );
      const target = matched || chats[0];
      if (target.datasetCount === 0) {
        push('知识库绑定', false, '该助手还没有绑定知识库，问答将检索不到内容');
      } else {
        push('知识库绑定', true, `已绑定 ${target.datasetCount} 个知识库`);
      }
      return createSession(target.id).then(
        (session) => {
          push('创建会话', true, `会话 ID：${session.id || '（未返回）'}`);
          push(
            '流式接收能力',
            true,
            cfg.stream ? '已开启（基础库需 2.20.2 以上）' : '已关闭，使用一次性返回'
          );
          return steps;
        },
        (err) => {
          push('创建会话', false, (err && err.message) || '创建失败');
          return steps;
        }
      );
    })
    .catch((err) => {
      push('拉取助手列表', false, (err && err.message) || '请求失败');
      return steps;
    });
}

module.exports = {
  listChats,
  getChat,
  createChat,
  updateChat,
  deleteChat,
  listSessions,
  createSession,
  deleteSessions,
  ask,
  diagnose,
  normalizeChat,
  normalizeSession,
};
