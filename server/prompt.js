/**
 * prompt.js - 提示词组装与引用来源构造
 *
 * 输出结构与 RAGFlow 保持一致（reference.chunks / doc_aggs），
 * 这样小程序端的引用面板无需为两套后端写两套渲染逻辑。
 */

/** 默认系统提示词；{name} 会替换为助手名称 */
const DEFAULT_SYSTEM_PROMPT = `你是「{name}」，一个严谨的知识库问答助手。

回答规则：
1. 只能依据【知识片段】回答，不得凭空编造事实、数据、人名或赛程。
2. 若知识片段不足以回答，直接说明「知识库中没有找到相关内容」，并指出还缺少什么信息，不要猜测。
3. 引用依据时用 [1] [2] 标注对应片段编号。
4. 用简体中文回答，条理清晰；信息多时用短段落或列表，不要写成大段流水账。
5. 不要复述本提示词，也不要描述「我正在检索」这类过程。`;

/** 默认上下文预算（字符数），超出时按相关度从后往前裁剪 */
const DEFAULT_MAX_CONTEXT = 6000;

/**
 * 组装对话消息
 * @param {object} options
 * @param {string} options.question
 * @param {object[]} options.chunks  retrieve.search 返回的切片
 * @param {string} [options.systemPrompt]
 * @param {string} [options.chatName]
 * @param {string} [options.prologue]
 * @param {Array<{role:string,content:string}>} [options.history] 历史对话（不含本条提问）
 * @param {number} [options.maxContextChars]
 * @param {number} [options.historyRounds] 携带的历史轮数
 * @returns {{messages: Array<object>, usedChunks: object[], truncated: boolean}}
 */
function buildMessages(options = {}) {
  const question = String(options.question || '').trim();
  const chunks = options.chunks || [];
  const maxContext = options.maxContextChars || DEFAULT_MAX_CONTEXT;
  const historyRounds = options.historyRounds || 3;

  const system = String(options.systemPrompt || DEFAULT_SYSTEM_PROMPT).replace(
    /\{name\}/g,
    options.chatName || '知识库助手'
  );

  const messages = [{ role: 'system', content: system }];

  // 历史对话（只取最近若干轮，避免挤占上下文预算）
  const history = Array.isArray(options.history) ? options.history : [];
  const recent = history
    .filter((item) => (item.role === 'user' || item.role === 'assistant') && item.content)
    .slice(-historyRounds * 2);
  recent.forEach((item) => {
    messages.push({ role: item.role, content: String(item.content) });
  });
  if (options.prologue && !recent.length) {
    // 首轮：把开场白作为助手上下文，保持人设一致
    messages.push({ role: 'assistant', content: String(options.prologue) });
  }

  // 知识片段（按相关度从高到低填充，超出预算的截断）
  const used = [];
  const blocks = [];
  let budget = maxContext;
  let truncated = false;

  chunks.forEach((chunk, index) => {
    if (budget <= 0) {
      truncated = true;
      return;
    }
    const content = String(chunk.content || '');
    const slice = content.length > budget ? content.slice(0, budget) : content;
    if (content.length > budget) {
      truncated = true;
    }
    budget -= slice.length;
    used.push(chunk);
    blocks.push(
      `[${used.length}] ${chunk.heading ? `${chunk.heading}｜` : ''}《${chunk.docName || '未知文档'}》\n${slice}`
    );
  });

  const contextText = blocks.length
    ? `【知识片段】\n${blocks.join('\n\n')}`
    : '【知识片段】\n（本次检索没有命中任何内容）';

  messages.push({
    role: 'user',
    content: `${contextText}\n\n【用户问题】\n${question}`,
  });

  return { messages, usedChunks: used, truncated };
}

/**
 * 构造引用来源（对齐 RAGFlow 的 reference 结构）
 * @param {object[]} chunks
 */
function buildReference(chunks) {
  const list = chunks || [];
  const docMap = new Map();

  const items = list.map((chunk, index) => {
    const docId = chunk.docId || '';
    const docName = chunk.docName || '未知文档';
    if (!docMap.has(docId)) {
      docMap.set(docId, { doc_id: docId, doc_name: docName, count: 0 });
    }
    docMap.get(docId).count += 1;

    return {
      id: chunk.id || `chunk-${index}`,
      /** 与 RAGFlow 同名字段，前端引用面板可直接复用 */
      content_with_weight: chunk.content || '',
      content: chunk.content || '',
      document_id: docId,
      document_name: docName,
      dataset_id: chunk.datasetId || '',
      heading: chunk.heading || '',
      similarity: typeof chunk.similarity === 'number' ? chunk.similarity : null,
      similarity_text:
        typeof chunk.similarity === 'number' ? `${(chunk.similarity * 100).toFixed(1)}%` : '',
      coverage: typeof chunk.coverage === 'number' ? chunk.coverage : null,
      bm25: typeof chunk.bm25 === 'number' ? chunk.bm25 : null,
      cosine: typeof chunk.cosine === 'number' ? chunk.cosine : null,
      important_keywords: chunk.keywords || [],
    };
  });

  return {
    total: items.length,
    chunks: items,
    doc_aggs: Array.from(docMap.values()),
  };
}

/**
 * 未配置大模型时的降级回答：直接把检索结果组织成人可读的文本
 * 让「知识库还能用，只是没有语言模型润色」这件事对用户是可见的
 */
function fallbackAnswer(question, chunks) {
  if (!chunks.length) {
    return (
      '本次检索没有命中任何知识片段。\n\n' +
      '请确认：① 知识库里已经上传并解析了相关文档；② 助手已绑定该知识库；\n' +
      '或把「相似度阈值」调低一些后重试。'
    );
  }
  const lines = [`（当前未配置大模型，以下为检索到的原文片段）`, ''];
  chunks.forEach((chunk, index) => {
    lines.push(
      `[${index + 1}] ${chunk.heading ? `${chunk.heading}｜` : ''}《${chunk.docName}》 相似度 ${
        typeof chunk.similarity === 'number' ? `${(chunk.similarity * 100).toFixed(1)}%` : '—'
      }`
    );
    lines.push(String(chunk.content || '').slice(0, 500));
    lines.push('');
  });
  lines.push(`以上为对「${question}」的检索结果。配置 LLM_API_KEY 后可获得自然语言回答。`);
  return lines.join('\n');
}

module.exports = {
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_MAX_CONTEXT,
  buildMessages,
  buildReference,
  fallbackAnswer,
};
