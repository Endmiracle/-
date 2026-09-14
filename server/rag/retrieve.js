/**
 * retrieve.js - 混合检索
 *
 * 默认策略：
 *   排序 —— BM25（关键词匹配强度）
 *   过滤 —— 查询词覆盖率 coverage（绝对值 0~1，可跨查询设阈值）
 *   排序用相对分、过滤用绝对分，是刻意的：BM25 分数没有绝对量纲，
 *   直接拿它当「相似度阈值」是很多自建 RAG 语义失控的根源。
 *
 * 配置了 EMBEDDING_MODEL 后自动升级为向量增强：
 *   similarity = alpha × coverage + (1 - alpha) × cosine   （alpha 默认 0.5）
 *   两项都是 0~1 的绝对量，此时阈值含义与 RAGFlow 的 similarity_threshold 一致。
 */

const config = require('../config');
const bm25 = require('./bm25');
const { requestText } = require('../http');

/** 元信息切片（文档头来源/版本段）的排序降权系数 */
const META_PENALTY = 0.25;

/* ============================================================
 * 向量
 * ============================================================ */

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (!normA || !normB) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * 调用 OpenAI 兼容的 /embeddings 接口
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
async function embedTexts(texts) {
  if (!config.embedding.enabled) {
    return [];
  }
  const list = (texts || []).map((t) => String(t || '').slice(0, 2000));
  if (!list.length) {
    return [];
  }

  const url = `${config.embedding.baseUrl}/embeddings`;
  const vectors = [];
  const batchSize = Math.max(1, config.embedding.batchSize);

  for (let i = 0; i < list.length; i += batchSize) {
    const batch = list.slice(i, i + batchSize);
    const response = await requestText({
      url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.embedding.apiKey}`,
      },
      body: JSON.stringify({
        model: config.embedding.model,
        input: batch,
        encoding_format: 'float',
      }),
      timeout: config.embedding.timeoutMs,
    });

    let parsed = null;
    try {
      parsed = JSON.parse(response.text);
    } catch (err) {
      throw new Error(`向量接口返回非 JSON（HTTP ${response.status}）：${response.text.slice(0, 200)}`);
    }
    if (!parsed || !Array.isArray(parsed.data)) {
      const message = (parsed && parsed.error && parsed.error.message) || parsed.msg || '向量接口返回异常';
      throw new Error(message);
    }
    parsed.data
      .slice()
      .sort((a, b) => (a.index || 0) - (b.index || 0))
      .forEach((item) => vectors.push(item.embedding));
  }

  return vectors;
}

/** 为切片批量补向量（入库时调用；失败不阻断入库） */
async function attachVectors(chunks) {
  if (!config.embedding.enabled || !chunks.length) {
    return { attached: 0, error: '' };
  }
  try {
    const texts = chunks.map((chunk) => bm25.indexTextOf(chunk));
    const vectors = await embedTexts(texts);
    let attached = 0;
    chunks.forEach((chunk, index) => {
      if (Array.isArray(vectors[index])) {
        chunk.vector = vectors[index];
        attached += 1;
      }
    });
    return { attached, error: '' };
  } catch (err) {
    console.warn('[retrieve] 向量生成失败，已降级为纯 BM25：', err.message);
    return { attached: 0, error: err.message };
  }
}

/* ============================================================
 * 检索
 * ============================================================ */

/**
 * @param {object} options
 * @param {string[]} options.datasetIds
 * @param {string} options.question
 * @param {number} [options.topK]
 * @param {number} [options.threshold]
 * @param {number} [options.alpha]
 * @returns {Promise<{chunks: Array<object>, stats: object}>}
 */
async function search(options = {}) {
  const datasetIds = (options.datasetIds || []).filter(Boolean);
  const question = String(options.question || '').trim();
  const topK = Math.max(1, options.topK || config.retrieval.topK);
  const threshold =
    typeof options.threshold === 'number' ? options.threshold : config.retrieval.similarityThreshold;
  const alpha = typeof options.alpha === 'number' ? options.alpha : config.retrieval.hybridAlpha;

  const stats = {
    datasetCount: datasetIds.length,
    candidateCount: 0,
    matchedCount: 0,
    vectorUsed: false,
    vectorError: '',
    threshold,
    topK,
  };

  if (!datasetIds.length || !question) {
    return { chunks: [], stats };
  }

  // 1) 各知识库分别取候选（每个库内部归一化后再合并，避免不同库的分数不可比）
  const candidates = [];
  datasetIds.forEach((datasetId) => {
    const index = bm25.getIndex(datasetId);
    if (!index.size) {
      return;
    }
    bm25.search(index, question, Math.max(topK * 4, 20)).forEach((hit) => {
      candidates.push({
        chunk: hit.chunk,
        datasetId,
        bm25Raw: hit.raw,
        bm25Norm: hit.norm,
        coverage: hit.coverage,
        cosine: null,
      });
    });
  });
  stats.candidateCount = candidates.length;

  if (!candidates.length) {
    return { chunks: [], stats };
  }

  // 2) 向量增强（可选）
  if (config.embedding.enabled) {
    try {
      const [queryVector] = await embedTexts([question]);
      if (Array.isArray(queryVector)) {
        candidates.forEach((item) => {
          if (Array.isArray(item.chunk.vector) && item.chunk.vector.length) {
            item.cosine = Math.max(0, cosineSimilarity(queryVector, item.chunk.vector));
          }
        });
        stats.vectorUsed = true;
      }
    } catch (err) {
      stats.vectorError = err.message;
      console.warn('[retrieve] 查询向量生成失败，已降级为纯 BM25：', err.message);
    }
  }

  // 3) 打分
  //    排序键与「相似度」刻意分开：
  //    相似度（覆盖率 / 混合分）用于跨查询可比的阈值过滤；
  //    排序键额外叠加「元信息降权」——文档头的来源/版本/适用范围段落字面匹配得分很高但不含答案
  candidates.forEach((item) => {
    item.similarity =
      stats.vectorUsed && item.cosine !== null
        ? alpha * item.coverage + (1 - alpha) * item.cosine
        : item.coverage;
    item.similarity = Number(item.similarity.toFixed(4));

    item.isMeta = !!item.chunk.isMeta;
    const baseScore = stats.vectorUsed ? item.similarity : item.bm25Raw;
    item.rankScore = item.isMeta ? baseScore * META_PENALTY : baseScore;
  });

  // 4) 过滤 + 排序
  const filtered = candidates.filter((item) => item.similarity >= threshold);
  filtered.sort((a, b) => b.rankScore - a.rankScore);

  const picked = filtered.slice(0, topK);
  stats.matchedCount = filtered.length;

  return {
    chunks: picked.map((item) => ({
      id: item.chunk.id,
      content: item.chunk.content,
      heading: item.chunk.heading || '',
      docId: item.chunk.docId,
      docName: item.chunk.docName,
      datasetId: item.datasetId,
      index: item.chunk.index,
      isTable: !!item.chunk.isTable,
      isMeta: item.isMeta,
      similarity: item.similarity,
      coverage: item.coverage,
      cosine: item.cosine,
      bm25: item.bm25Raw,
      keywords: item.chunk.keywords || [],
    })),
    stats,
  };
}

module.exports = {
  search,
  embedTexts,
  attachVectors,
  cosineSimilarity,
};
