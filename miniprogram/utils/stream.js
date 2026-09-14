/**
 * stream.js - 流式输出底层：增量 UTF-8 解码 + SSE 解析 + 文本合并
 *
 * 为什么需要这个文件（两个真实会踩的坑）：
 *
 * 1) 小程序没有全局 TextDecoder。常见的
 *    「String.fromCharCode.apply(null, new Uint8Array(buf))」写法在**中文**场景下必然乱码：
 *    一个汉字占 3 字节，网络分片很可能把它从中间切开，半个字符被独立解码就成了乱码。
 *    所以这里实现带状态（pending）的增量解码器，把不完整的字节序列留到下一个分片。
 *
 * 2) RAGFlow 的流式 answer 在不同版本/不同助手配置下语义不一致
 *    （旧版累积全文，新版可能是增量片段）。这里用「新文本是否以旧文本开头」来判定并兼容两者，
 *    避免出现整段答案被重复叠加。
 */

/* ============================================================
 * 增量 UTF-8 解码
 * ============================================================ */

/** 码点 → 字符串（处理需要代理对的补充平面字符） */
function fromCodePoint(cp) {
  if (cp <= 0xffff) {
    return String.fromCharCode(cp);
  }
  const v = cp - 0x10000;
  return String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
}

function toBytes(buffer) {
  if (!buffer) {
    return new Uint8Array(0);
  }
  if (buffer instanceof ArrayBuffer) {
    return new Uint8Array(buffer);
  }
  if (ArrayBuffer.isView(buffer)) {
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }
  return new Uint8Array(0);
}

/**
 * 创建有状态的增量 UTF-8 解码器
 * @returns {{decode: (buf: ArrayBuffer|string) => string, flush: () => string, reset: () => void}}
 */
function createUtf8Decoder() {
  /** 上一分片残留的不完整字节序列 */
  let pending = [];
  /** 是否还在处理首个分片（用于剥离 BOM） */
  let atStart = true;

  function decode(buffer) {
    // 兜底：非分块模式下某些环境直接给字符串
    if (typeof buffer === 'string') {
      return buffer;
    }
    const bytes = toBytes(buffer);
    if (!bytes.length && !pending.length) {
      return '';
    }

    let data;
    if (pending.length) {
      data = new Uint8Array(pending.length + bytes.length);
      data.set(pending, 0);
      data.set(bytes, pending.length);
    } else {
      data = bytes;
    }
    pending = [];

    let out = '';
    let i = 0;
    const len = data.length;

    while (i < len) {
      const b0 = data[i];
      let need;
      let cp;

      if (b0 < 0x80) {
        need = 1;
        cp = b0;
      } else if ((b0 & 0xe0) === 0xc0) {
        need = 2;
        cp = b0 & 0x1f;
      } else if ((b0 & 0xf0) === 0xe0) {
        need = 3;
        cp = b0 & 0x0f;
      } else if ((b0 & 0xf8) === 0xf0) {
        need = 4;
        cp = b0 & 0x07;
      } else {
        // 非法首字节（含 0x80~0xBF 的孤立续字节）：跳过后重新同步
        i += 1;
        continue;
      }

      // 本分片字节不够 —— 关键：整段留到下一分片，绝不半截解码
      if (i + need > len) {
        pending = Array.prototype.slice.call(data, i);
        break;
      }

      let valid = true;
      for (let k = 1; k < need; k += 1) {
        const bx = data[i + k];
        if ((bx & 0xc0) !== 0x80) {
          valid = false;
          break;
        }
        cp = (cp << 6) | (bx & 0x3f);
      }

      if (!valid) {
        // 续字节非法：只跳过首字节，让后续字节重新参与同步
        i += 1;
        continue;
      }

      out += fromCodePoint(cp);
      i += need;
    }

    if (atStart && out) {
      atStart = false;
      if (out.charCodeAt(0) === 0xfeff) {
        out = out.slice(1);
      }
    }

    return out;
  }

  /** 流结束时丢弃残留的半个字符 */
  function flush() {
    pending = [];
    return '';
  }

  function reset() {
    pending = [];
    atStart = true;
  }

  return { decode, flush, reset };
}

/* ============================================================
 * SSE 解析
 * ============================================================ */

const DATA_LINE = /^data\s*:\s?([\s\S]*)$/;

/**
 * 创建 SSE 解析器（按行缓冲，处理被分片切断的半行）
 *
 * @param {object} handlers
 * @param {(obj: object) => void} handlers.onEvent  收到可解析为 JSON 的 data 行
 * @param {(text: string) => void} [handlers.onText] 收到非 JSON 的 data 行（纯文本流兜底）
 * @param {() => void} [handlers.onDone]             收到 [DONE]
 * @returns {{feed: (text: string) => void, end: () => void}}
 */
function createSSEParser(handlers = {}) {
  let buffer = '';
  let finished = false;
  const onEvent = handlers.onEvent || function () {};
  const onText = handlers.onText || function () {};
  const onDone = handlers.onDone || function () {};

  function handleLine(rawLine) {
    if (finished) {
      return;
    }
    let line = rawLine;
    if (line.charCodeAt(line.length - 1) === 0x0d) {
      line = line.slice(0, -1); // 去掉 \r
    }
    if (!line) {
      return; // 空行 = 事件分隔
    }
    if (line.charCodeAt(0) === 0x3a) {
      return; // 以 ':' 开头是注释/心跳，忽略
    }

    const match = DATA_LINE.exec(line);
    if (!match) {
      return; // event: / id: / retry: 等字段忽略
    }

    const payload = match[1];
    if (payload === '[DONE]') {
      finished = true;
      onDone();
      return;
    }
    if (!payload) {
      return;
    }

    try {
      onEvent(JSON.parse(payload));
    } catch (err) {
      // 不是 JSON，按纯文本交给上层
      onText(payload);
    }
  }

  function feed(text) {
    if (finished || !text) {
      return;
    }
    buffer += text;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      handleLine(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      if (finished) {
        return;
      }
      index = buffer.indexOf('\n');
    }
  }

  /** 流结束：把没有换行结尾的最后一行也消化掉 */
  function end() {
    if (finished) {
      return;
    }
    if (buffer) {
      handleLine(buffer);
      buffer = '';
    }
    if (!finished) {
      finished = true;
      onDone();
    }
  }

  return { feed, end };
}

/* ============================================================
 * 流式文本合并
 * ============================================================ */

/**
 * 合并流式文本片段，同时兼容「累积全文」与「增量片段」两种服务端行为
 *
 * @param {string} prev 已累积文本
 * @param {string} next 本次收到的文本
 * @returns {string}
 */
function mergeChunk(prev, next) {
  const before = String(prev || '');
  const chunk = String(next || '');
  if (!chunk) {
    return before;
  }
  if (!before) {
    return chunk;
  }
  // 累积式：新文本以已累积内容开头（含完全相同的情况）
  if (chunk.length >= before.length && chunk.indexOf(before) === 0) {
    return chunk;
  }
  // 增量式：直接拼接
  return before + chunk;
}

/* ============================================================
 * 引用来源归一化
 * ============================================================ */

/**
 * 把 RAGFlow 的 reference 结构压成视图模型
 * 结构形如 { total, chunks: [...], doc_aggs: [{doc_id, doc_name, count}] }
 */
function normalizeReference(reference) {
  if (!reference) {
    return null;
  }
  const chunks = Array.isArray(reference.chunks) ? reference.chunks : [];
  const docAggs = Array.isArray(reference.doc_aggs) ? reference.doc_aggs : [];

  const items = chunks.map((chunk, index) => {
    const content = String(
      chunk.content_with_weight || chunk.content || chunk.highlight || ''
    ).trim();
    const similarity = typeof chunk.similarity === 'number' ? chunk.similarity : null;
    return {
      key: chunk.id || chunk.chunk_id || `chunk-${index}`,
      docName: chunk.document_name || chunk.doc_name || '未知文档',
      docId: chunk.document_id || chunk.doc_id || '',
      /** 所属标题（自建引擎会返回，便于定位到章节） */
      heading: chunk.heading || '',
      similarity,
      similarityText: similarity === null ? '' : `${(similarity * 100).toFixed(1)}%`,
      content: truncateText(content, 400),
      keywords: Array.isArray(chunk.important_keywords) ? chunk.important_keywords : [],
    };
  });

  const docs = docAggs.map((doc, index) => ({
    key: doc.doc_id || `doc-${index}`,
    name: doc.doc_name || doc.name || '未知文档',
    count: doc.count || 0,
  }));

  return {
    total: typeof reference.total === 'number' ? reference.total : items.length,
    items,
    docs,
    docCount: docs.length,
  };
}

function truncateText(text, max) {
  const str = String(text || '');
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

module.exports = {
  createUtf8Decoder,
  createSSEParser,
  mergeChunk,
  normalizeReference,
  fromCodePoint,
};
