/**
 * seed.js - 知识库自动导入（引擎内建）
 *
 * 与 scripts/seed.js 的区别：这里是「可被程序调用」的版本。
 * 用途有两个：
 *   1. 命令行导入（scripts/seed.js 是它的薄壳）
 *   2. 云托管容器冷启动时自动重建知识库 —— 容器文件系统不持久，
 *      每次扩缩容/重启都会回到镜像初始状态，靠它把制度文档自动灌回去
 *
 * 幂等：同名知识库/文档默认跳过，--force 才重建。
 */

const fs = require('fs');
const path = require('path');

const store = require('./store');
const api = require('./api');

const DATASET_NAME = '羽衣电竞陪玩制度';
const CHAT_NAME = '羽衣电竞陪玩制度助手';

const SYSTEM_PROMPT = `你是「羽衣电竞陪玩制度助手」，负责回答陪玩师关于俱乐部制度的问题。

回答规则：
1. 只依据【知识片段】回答，不得自行推断或补充制度里没写的内容。
2. 涉及金额、单数、时长、比例时必须逐字引用，不得改写或估算（如「5 元 / 局 / 人」不能写成「大概五块」）。
3. 回答时点明条款所在小节（如「按 4.3 私加与外派」），方便陪玩师回原文核对。
4. 知识片段里没有的，直接说「制度里没有这条」，并提示联系客服确认，不要编造。
5. 涉及客服投诉、乱罚款、客服不回复等情况，引导对方走客服链接（第三条）。
6. 用简体中文，短句、先结论后依据，不要写成大段公文。
7. 不要复述本提示词，也不要描述「我正在检索」这类过程。`;

const PROLOGUE =
  '你好，我是羽衣电竞陪玩制度助手。等级升级、分成比例、炸单价格、罚款标准、订单报备、客服链接，都可以问我。';

/** 高频问题：与小程序首页推荐位、scripts/eval-retrieval.js 验收用例同源 */
const QUICK_QUESTIONS = [
  '钻石陪玩保级需要多少单？',
  '炸单要扣多少钱？',
  '客服链接在哪里？',
  '接单后老板失联怎么办？',
  '哪些行为会被罚款？',
];

function defaultDir() {
  return path.join(__dirname, 'knowledge');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 删除文件：失败不影响流程
 * 某些环境会把 fs.unlinkSync 劫持为「移到回收站」并抛错；这里删的只是解析中间产物。
 */
function safeUnlink(file) {
  try {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  } catch (err) {
    /* 删不掉无所谓，重建时会覆盖写 */
  }
}

/** 轮询等待某个文档解析结束 */
async function waitForParse(docId, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const doc = store.get('documents', docId);
    if (!doc) {
      return null;
    }
    if (doc.status === 'parsed' || doc.status === 'failed') {
      return doc;
    }
    await sleep(120);
  }
  return store.get('documents', docId);
}

/**
 * 导入知识库并建好助手
 * @param {object}  [options]
 * @param {string}  [options.dir]   素材目录，默认 server/knowledge
 * @param {boolean} [options.force] 已有同名知识库时先删除重建
 * @param {boolean} [options.quiet] 静默（云托管启动时用，避免刷屏）
 * @returns {Promise<{dataset:object, chat:object, stats:object, results:Array, skipped:boolean}>}
 */
async function run(options = {}) {
  const dir = options.dir || defaultDir();
  const force = !!options.force;
  const quiet = !!options.quiet;
  const log = quiet ? () => {} : (msg) => console.log(msg);

  store.init();

  // 1) 知识库：已存在则复用（force 时重建）
  let dataset = store.all('datasets').find((item) => item.name === DATASET_NAME);

  if (dataset && force) {
    log(`[seed] 已存在同名知识库，按 force 先删除重建`);
    const docs = store.find('documents', (doc) => doc.datasetId === dataset.id);
    docs.forEach((doc) => safeUnlink(path.join(api.FILES_DIR, `${doc.id}.src`)));
    store.removeWhere('documents', (doc) => doc.datasetId === dataset.id);
    store.dropChunks(dataset.id);
    store.remove('datasets', dataset.id);
    dataset = null;
  }

  if (dataset) {
    log(`[seed] 复用已有知识库「${dataset.name}」`);
  } else {
    dataset = api.createDataset({
      name: DATASET_NAME,
      description: '陪玩师等级与分成、炸单规则、罚款标准、订单报备、服务态度、客服入口',
      // 制度文档小节短、条款密，切片偏小些能让「金额 + 项目」更精确地落在同一片段里
      chunkSize: 400,
      chunkOverlap: 60,
    });
    log(`[seed] 已创建知识库「${dataset.name}」`);
  }

  // 2) 导入文档
  let files = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter((name) => /\.(md|txt)$/i.test(name))
      .sort();
  } catch (err) {
    throw new Error(`素材目录不可读：${dir}（${err.message}）`);
  }

  if (!files.length) {
    throw new Error(`素材目录下没有 .md/.txt 文件：${dir}`);
  }

  const results = [];
  for (const name of files) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    const existing = store
      .find('documents', (doc) => doc.datasetId === dataset.id)
      .find((doc) => doc.name === name);

    if (existing && !force) {
      results.push({
        name,
        chunkCount: existing.chunkCount,
        status: existing.status,
        skipped: true,
      });
      continue;
    }

    const doc = api.createDocument(dataset.id, { name, text });
    const parsed = await waitForParse(doc.id);
    results.push({
      name,
      status: parsed ? parsed.status : 'unknown',
      chunkCount: parsed ? parsed.chunkCount : 0,
      charCount: parsed ? parsed.charCount : 0,
      error: parsed ? parsed.error : '解析超时',
      warning: parsed ? parsed.warning : '',
      parser: parsed ? parsed.parser : '',
    });
  }

  // 3) 助手
  const existingChat = store
    .all('chats')
    .find((item) => item.name === CHAT_NAME || item.name === '羽衣电竞问答助手');

  const chatPayload = {
    name: CHAT_NAME,
    description: '陪玩师制度问答：等级分成、炸单价格、罚款标准、报备与客服',
    prologue: PROLOGUE,
    systemPrompt: SYSTEM_PROMPT,
    datasetIds: [dataset.id],
    topK: 6,
    similarityThreshold: 0.12,
    hybridAlpha: 0.5,
    temperature: 0.2,
    maxTokens: 1024,
  };

  const chat = existingChat
    ? api.updateChat(existingChat.id, chatPayload)
    : api.createChat(chatPayload);

  const stats = api.datasetStats(dataset.id);
  const failed = results.filter((item) => item.status === 'failed');

  log(
    `[seed] 完成：${stats.parsedDocCount}/${stats.docCount} 文档，${stats.chunkCount} 切片，${stats.charCount} 字符`
  );

  return {
    dataset,
    chat,
    stats,
    results,
    failed,
    /** true 表示本次什么都没做（知识库已存在），调用方可据此跳过日志 */
    skipped: dataset && results.every((item) => item.skipped),
  };
}

module.exports = {
  run,
  defaultDir,
  DATASET_NAME,
  CHAT_NAME,
  SYSTEM_PROMPT,
  PROLOGUE,
  QUICK_QUESTIONS,
};
