/**
 * bm25.js - 中文友好的 BM25 检索
 *
 * 为什么用 bigram：中文没有空格，而引入 jieba 之类分词器就意味着第三方依赖。
 * 「按连续汉字切 2-gram」是无词典方案里效果最稳的做法：
 *   文档「赛制规则」→ 赛制 / 制规 / 规则；查询「赛制」→ 赛制  命中
 * 英文与数字按单词切分，统一小写。
 *
 * 索引在内存中按知识库缓存，切片变更时通过版本号失效。
 */

const store = require('../store');
const { GROUPS } = require('./synonyms');

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;
const WORD = /[a-z0-9]+/g;

const K1 = 1.5;
const B = 0.75;

/**
 * 分词
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  const str = String(text || '').toLowerCase();
  const tokens = [];

  // 英文 / 数字
  const words = str.match(WORD) || [];
  for (const word of words) {
    if (word.length >= 2) {
      tokens.push(word);
    }
  }

  // 中文：连续汉字段切 bigram；单字段落保留自身
  const runs = str.match(CJK_RUN) || [];
  for (const run of runs) {
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) {
      tokens.push(run.slice(i, i + 2));
    }
  }

  return tokens;
}

/** 词频统计 */
function termFrequency(tokens) {
  const tf = new Map();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) || 0) + 1);
  }
  return tf;
}

/* ============================================================
 * 查询概念（同义词归并）
 * ============================================================ */

/** 每个同义词组展开后的 token 集合 */
const GROUP_TOKENS = GROUPS.map((words) => {
  const set = new Set();
  words.forEach((word) => tokenize(word).forEach((token) => set.add(token)));
  return Array.from(set);
});

/** token -> 组下标（只归属第一个匹配的组） */
const TOKEN_GROUP = new Map();
GROUP_TOKENS.forEach((tokens, groupIndex) => {
  tokens.forEach((token) => {
    if (!TOKEN_GROUP.has(token)) {
      TOKEN_GROUP.set(token, groupIndex);
    }
  });
});

/**
 * 查询侧噪音 token
 *
 * 中文问句里含虚词的二字组合（「级的」「别是」「的在」）几乎不可能在原文中精确出现，
 * 它们命中率为 0 却会计入覆盖率分母，把真实命中的片段的覆盖率整体压低。
 * 注意：只过滤**查询侧**，索引侧保持原样，不改动文档表示。
 */
const STOP_TOKENS = new Set([
  '哪些', '哪个', '什么', '怎么', '怎样', '如何', '可以', '一下', '请问', '介绍',
  '说明', '时候', '这些', '那些', '这个', '那个', '这边', '我们', '他们', '能否', '是否',
]);
const STOP_CHARS = /[的得了是在有和或这那我你他她它们吗呢吧啊]/;

function isNoiseToken(token) {
  if (STOP_TOKENS.has(token)) {
    return true;
  }
  return token.length === 2 && STOP_CHARS.test(token);
}

/**
 * 把查询拆成「概念」列表
 * 每个概念是一组同义词的 token 集合；覆盖率按概念计，而不是按字面 token 计
 * @param {string} query
 * @returns {Set<string>[]}
 */
function buildQueryConcepts(query) {
  const raw = Array.from(new Set(tokenize(query)));
  const meaningful = raw.filter((token) => !isNoiseToken(token));
  // 整句都是虚词时不做过滤，避免把查询清空
  const tokens = meaningful.length ? meaningful : raw;

  const concepts = [];
  const groupConcept = new Map(); // groupIndex -> Set

  tokens.forEach((token) => {
    const groupIndex = TOKEN_GROUP.get(token);
    if (groupIndex === undefined) {
      concepts.push(new Set([token]));
      return;
    }
    let concept = groupConcept.get(groupIndex);
    if (!concept) {
      concept = new Set(GROUP_TOKENS[groupIndex]);
      groupConcept.set(groupIndex, concept);
      concepts.push(concept);
    } else {
      concept.add(token);
    }
  });

  return concepts;
}

/** 索引文本：把标题一并纳入（标题往往是高信息量的主题词），展示时仍只用 content */
function indexTextOf(chunk) {
  const heading = chunk.heading ? String(chunk.heading) : '';
  const content = String(chunk.content || '');
  return heading ? `${heading}\n${content}` : content;
}

/**
 * 构建倒排索引
 * @param {Array<object>} chunks 切片数组，元素需含 content
 */
function buildIndex(chunks) {
  const postings = new Map(); // token -> Array<[chunkIndex, tf, docLength]>
  const df = new Map(); // token -> 文档频次
  let totalLength = 0;

  chunks.forEach((chunk, index) => {
    const tokens = tokenize(indexTextOf(chunk));
    totalLength += tokens.length;
    const tf = termFrequency(tokens);
    tf.forEach((count, token) => {
      if (!postings.has(token)) {
        postings.set(token, []);
        df.set(token, 0);
      }
      postings.get(token).push([index, count, tokens.length]);
      df.set(token, df.get(token) + 1);
    });
  });

  return {
    chunks,
    postings,
    df,
    avgdl: chunks.length ? totalLength / chunks.length : 1,
    size: chunks.length,
  };
}

/* ============================================================
 * 索引缓存
 * ============================================================ */

const cache = new Map(); // datasetId -> {version, index}

/**
 * 取（并缓存）某个知识库的索引
 * @param {string} datasetId
 * @param {object[]} [chunks] 传入则直接用，不读磁盘
 */
function getIndex(datasetId, chunks) {
  const version = store.getChunkVersion(datasetId);
  const cached = cache.get(datasetId);
  if (cached && cached.version === version && !chunks) {
    return cached.index;
  }
  const list = chunks || store.getChunks(datasetId);
  const index = buildIndex(list);
  cache.set(datasetId, { version, index });
  return index;
}

function invalidate(datasetId) {
  cache.delete(datasetId);
}

/* ============================================================
 * 检索
 * ============================================================ */

/**
 * BM25 检索（概念级）
 *
 * @param {object} index buildIndex 的产物
 * @param {string} query
 * @param {number} topK
 * @returns {Array<{chunk: object, raw: number, norm: number, coverage: number}>}
 *   raw      BM25 原始分（无绝对量纲，只用于排序）
 *   norm     按本次最高分归一化（0~1）
 *   coverage 概念覆盖率 = 命中的概念数 / 查询概念总数
 *            （绝对值，可直接当阈值用；同义词命中即算该概念命中）
 */
function search(index, query, topK = 10) {
  const { postings, df, avgdl, chunks, size } = index;
  if (!size) {
    return [];
  }

  const concepts = buildQueryConcepts(query);
  if (!concepts.length) {
    return [];
  }

  const scores = new Map();
  const matched = new Map();

  for (const aliases of concepts) {
    // 同一个概念里多个同义词命中同一片段时只取最高分，避免重复计分虚高
    const best = new Map();

    for (const token of aliases) {
      const posting = postings.get(token);
      if (!posting) {
        continue;
      }
      const docFreq = df.get(token) || 1;
      // 带 +1 平滑的 IDF，避免高频词出现负分
      const idf = Math.log(1 + (size - docFreq + 0.5) / (docFreq + 0.5));

      for (const [chunkIndex, tf, docLength] of posting) {
        const denom = tf + K1 * (1 - B + (B * docLength) / avgdl);
        const score = idf * ((tf * (K1 + 1)) / denom);
        const previous = best.get(chunkIndex);
        if (previous === undefined || score > previous) {
          best.set(chunkIndex, score);
        }
      }
    }

    best.forEach((score, chunkIndex) => {
      scores.set(chunkIndex, (scores.get(chunkIndex) || 0) + score);
      matched.set(chunkIndex, (matched.get(chunkIndex) || 0) + 1);
    });
  }

  if (!scores.size) {
    return [];
  }

  const conceptCount = concepts.length;
  const ranked = Array.from(scores.entries())
    .map(([chunkIndex, raw]) => ({
      chunk: chunks[chunkIndex],
      raw,
      coverage: (matched.get(chunkIndex) || 0) / conceptCount,
    }))
    .sort((a, b) => b.raw - a.raw);

  const max = ranked[0].raw || 1;
  return ranked.slice(0, topK).map((item) => ({
    chunk: item.chunk,
    raw: Number(item.raw.toFixed(4)),
    norm: Number((item.raw / max).toFixed(4)),
    coverage: Number(item.coverage.toFixed(4)),
  }));
}

module.exports = {
  tokenize,
  termFrequency,
  buildIndex,
  getIndex,
  invalidate,
  search,
  indexTextOf,
  buildQueryConcepts,
  GROUP_TOKENS,
  K1,
  B,
};
