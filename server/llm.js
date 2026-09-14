/**
 * llm.js - 大模型调用（OpenAI 兼容 /chat/completions，流式）
 *
 * 兼容所有 OpenAI 协议的服务：DeepSeek、OpenAI、硅基流动、月之暗面、
 * 本地 Ollama（需开启 OpenAI 兼容层）、vLLM / LM Studio 等。
 * 只换 LLM_BASE_URL / LLM_MODEL 即可，无需改代码。
 *
 * 对外只暴露「增量文本」回调，累积拼接由调用方（api.js）负责，
 * 这样一处累积逻辑同时服务 SSE 输出与最终入库。
 */

const config = require('./config');
const { requestStream } = require('./http');

const DATA_LINE = /^data\s*:\s?(.*)$/;

/**
 * 解析 OpenAI 风格的 SSE 片段
 * @returns {{delta: string, finish: string|null, done: boolean}}
 */
function parseChunkText(text) {
  let delta = '';
  let finish = null;
  let done = false;

  text.split('\n').forEach((rawLine) => {
    const line = rawLine.replace(/\r$/, '');
    if (!line || line.startsWith(':')) {
      return;
    }
    const match = DATA_LINE.exec(line);
    if (!match) {
      return;
    }
    const payload = match[1].trim();
    if (!payload) {
      return;
    }
    if (payload === '[DONE]') {
      done = true;
      return;
    }
    let obj = null;
    try {
      obj = JSON.parse(payload);
    } catch (err) {
      return;
    }
    const choice = obj && Array.isArray(obj.choices) ? obj.choices[0] : null;
    if (!choice) {
      return;
    }
    if (choice.delta && typeof choice.delta.content === 'string') {
      delta += choice.delta.content;
    } else if (choice.message && typeof choice.message.content === 'string') {
      delta += choice.message.content;
    }
    if (choice.finish_reason) {
      finish = choice.finish_reason;
    }
  });

  return { delta, finish, done };
}

/**
 * 流式对话
 * @param {object} options
 * @param {Array<{role:string, content:string}>} options.messages
 * @param {(text: string) => void} options.onDelta 增量文本
 * @param {() => void} options.onEnd
 * @param {(err: Error) => void} options.onError
 * @param {number} [options.temperature]
 * @param {number} [options.maxTokens]
 * @param {string} [options.model]
 * @returns {{abort: Function}}
 */
function chatStream(options = {}) {
  const onDelta = options.onDelta || function () {};
  const onEnd = options.onEnd || function () {};
  const onError = options.onError || function () {};

  if (!config.llm.enabled) {
    onError(new Error('未配置大模型：请在 server/.env 中设置 LLM_API_KEY 后重启服务'));
    return { abort() {} };
  }

  let buffer = '';
  let receivedAny = false;
  let sawSse = false;
  let httpStatus = 0;
  let upstreamError = '';

  const stream = requestStream({
    url: `${config.llm.baseUrl}/chat/completions`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.llm.apiKey}`,
    },
    body: JSON.stringify({
      model: options.model || config.llm.model,
      messages: options.messages,
      stream: true,
      temperature:
        typeof options.temperature === 'number' ? options.temperature : config.llm.temperature,
      max_tokens: options.maxTokens || config.llm.maxTokens,
    }),
    timeout: config.llm.timeoutMs,
    onStart: (meta) => {
      httpStatus = meta.status;
    },
    onChunk: (text) => {
      buffer += text;
      if (!sawSse && /\bdata\s*:/.test(buffer)) {
        sawSse = true;
      }

      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index + 1);
        buffer = buffer.slice(index + 1);
        const parsed = parseChunkText(line);
        if (parsed.delta) {
          receivedAny = true;
          onDelta(parsed.delta);
        }
        index = buffer.indexOf('\n');
      }
    },
    onEnd: () => {
      if (buffer.trim()) {
        const parsed = parseChunkText(buffer);
        if (parsed.delta) {
          receivedAny = true;
          onDelta(parsed.delta);
        }
      }

      if (receivedAny) {
        onEnd();
        return;
      }

      // 一个 token 都没收到：多半是上游报错，把原因翻译出来
      const trimmed = buffer.trim();
      if (trimmed) {
        try {
          const obj = JSON.parse(trimmed);
          upstreamError =
            (obj.error && (obj.error.message || obj.error.code)) || obj.message || trimmed.slice(0, 300);
        } catch (err) {
          upstreamError = trimmed.slice(0, 300);
        }
      }
      if (!upstreamError) {
        upstreamError = `大模型没有返回内容（HTTP ${httpStatus}）`;
      }
      onError(new Error(upstreamError));
    },
    onError: (err) => {
      if (receivedAny) {
        // 已经输出了一部分内容，按正常结束处理，避免用户看到的内容被丢弃
        onEnd();
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

/** 是否已配置可用的大模型 */
function isEnabled() {
  return !!config.llm.enabled;
}

/** 供 /health 展示（不含密钥） */
function info() {
  return {
    enabled: config.llm.enabled,
    model: config.llm.model,
    baseUrl: config.llm.baseUrl,
  };
}

module.exports = {
  chatStream,
  isEnabled,
  info,
  parseChunkText,
};
