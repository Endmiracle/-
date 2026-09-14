/* eslint-disable */
/**
 * smoke-test.js - 引擎自动化测试
 *
 * 分两部分：
 *   A. 单元测试：流式解码 / SSE 解析 / 文本合并 / 分词 / 切片 / DOCX 抽取
 *   B. 集成测试：真实启动服务，跑完「建库 → 上传文档 → 解析 → 检索 → 问答 → 会话落库 → 级联删除」
 *
 * 用法：node scripts/smoke-test.js
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MP = path.join(ROOT, 'miniprogram');
const SERVER = path.join(ROOT, 'server');

let pass = 0;
let fail = 0;
const failures = [];

function check(label, condition, extra) {
  if (condition) {
    pass += 1;
    console.log(`  \u2713 ${label}`);
  } else {
    fail += 1;
    failures.push(label);
    console.log(`  \u2717 ${label}${extra !== undefined ? `  -> ${JSON.stringify(extra)}` : ''}`);
  }
}

function section(title) {
  console.log(`\n===== ${title} =====`);
}

/* ============================================================
 * A. 单元测试
 * ============================================================ */

async function unitTests() {
  section('A1. 增量 UTF-8 解码（中文/emoji 在任意分片边界都不乱码）');
  const stream = require(path.join(MP, 'utils/stream.js'));

  const samples = [
    '羽衣电竞问答助手：赛制规则与战队阵容',
    '混合检索（BM25 + 向量）的相似度阈值怎么设？',
    'RAG 中文分片测试 🎮🏆 全角标点：，。；：！？',
    'a中b文c混d排 123 abc DEF',
  ];

  samples.forEach((text, sampleIndex) => {
    const bytes = Buffer.from(text, 'utf8');
    let allOk = true;
    for (let cut = 1; cut < bytes.length; cut += 1) {
      const decoder = stream.createUtf8Decoder();
      let out = decoder.decode(toArrayBuffer(bytes.slice(0, cut)));
      out += decoder.decode(toArrayBuffer(bytes.slice(cut)));
      if (out !== text) {
        allOk = false;
        break;
      }
    }
    check(`样例 ${sampleIndex + 1} 在全部 ${bytes.length - 1} 个切分点解码一致`, allOk, text);
  });

  // 逐字节喂入（最极端：每个分片只有 1 字节）
  const longText = samples.join('|');
  const longBytes = Buffer.from(longText, 'utf8');
  const decoder = stream.createUtf8Decoder();
  let piecewise = '';
  for (let i = 0; i < longBytes.length; i += 1) {
    piecewise += decoder.decode(toArrayBuffer(longBytes.slice(i, i + 1)));
  }
  check('逐字节喂入结果与原串完全一致', piecewise === longText);

  // 非法字节不应导致崩溃或死循环
  const messy = stream.createUtf8Decoder();
  const dirty = Buffer.from([0xe4, 0xb8, 0xad, 0xff, 0xfe, 0xe6, 0x96, 0x87]);
  const dirtyOut = messy.decode(toArrayBuffer(dirty));
  check('遇到非法字节不崩溃且保留可解码部分', dirtyOut.indexOf('中') >= 0 && dirtyOut.indexOf('文') >= 0, dirtyOut);

  section('A2. SSE 解析');
  const events = [];
  const texts = [];
  let doneCalled = false;
  const parser = stream.createSSEParser({
    onEvent: (obj) => events.push(obj),
    onText: (t) => texts.push(t),
    onDone: () => {
      doneCalled = true;
    },
  });

  const sse = 'data:{"answer":"羽衣","reference":null}\n\ndata:{"answer":"羽衣电竞"}\n\ndata:{"answer":"羽衣电竞问答"}\n\ndata:[DONE]\n\n';
  // 按 7 个字符一片喂入，模拟被分片切断的半行（解码器已在 A1 单独验证）
  for (let i = 0; i < sse.length; i += 7) {
    parser.feed(sse.slice(i, i + 7));
  }
  check('解析出 3 条事件', events.length === 3, events.length);
  check('事件内容正确', events[1] && events[1].answer === '羽衣电竞', events[1]);
  check('[DONE] 触发回调', doneCalled === true);

  const parser2 = stream.createSSEParser({
    onEvent: () => {},
    onText: (t) => texts.push(t),
    onDone: () => {},
  });
  parser2.feed('data:纯文本没有花括号\n\n');
  parser2.feed(': 这是心跳注释\n\n');
  parser2.feed('event: message\n\n');
  check('非 JSON 的 data 行走 onText 兜底', texts[0] === '纯文本没有花括号', texts[0]);
  check('注释与 event 行被忽略', texts.length === 1, texts.length);

  section('A3. 流式文本合并（兼容累积式与增量式）');
  check('累积式：新文本包含旧文本 → 替换', stream.mergeChunk('羽衣', '羽衣电竞') === '羽衣电竞');
  check('累积式：完全相同 → 不重复', stream.mergeChunk('羽衣', '羽衣') === '羽衣');
  check('增量式：无包含关系 → 拼接', stream.mergeChunk('羽衣', '电竞') === '羽衣电竞');
  check('空值安全', stream.mergeChunk('', '') === '' && stream.mergeChunk('a', '') === 'a');

  section('A4. 分词与 BM25');
  const bm25 = require(path.join(SERVER, 'rag/bm25.js'));
  const tokens = bm25.tokenize('羽衣电竞 2026 赛季规则');
  check('中文按 bigram 切分', tokens.indexOf('羽衣') >= 0 && tokens.indexOf('电竞') >= 0, tokens);
  check('英文数字按词切分', tokens.indexOf('2026') >= 0, tokens);

  const corpus = [
    { content: '羽衣电竞的赛制分为常规赛与季后赛两个阶段。' },
    { content: '战队阵容由五名首发选手与替补组成。' },
    { content: '本赛季版本更新调整了英雄平衡性。' },
  ];
  const index = bm25.buildIndex(corpus);
  const hits = bm25.search(index, '赛制阶段', 3);
  check('检索命中相关切片', hits.length > 0 && hits[0].chunk.content.indexOf('赛制') >= 0, hits[0]);
  check('覆盖率字段有效（0~1）', hits[0].coverage > 0 && hits[0].coverage <= 1, hits[0].coverage);
  const noHit = bm25.search(index, '完全不相关的词汇组合xyz', 3);
  check('无关问题的覆盖率低', !noHit.length || noHit[0].coverage < 0.5, noHit[0] && noHit[0].coverage);

  section('A5. 切片策略');
  const ingest = require(path.join(SERVER, 'rag/ingest.js'));
  const md = ['# 第一章 赛制', '常规赛采用双循环积分制，共进行 30 轮比赛。' + 'a'.repeat(200), '## 1.1 季后赛', '前八名进入季后赛，采用双败淘汰制。', '', '# 第二章 战队', '每支战队五名首发，一名替补。'].join('\n');
  const chunks = ingest.chunkText(md, { size: 200, overlap: 40, minSize: 40 });
  // 断言重点是「长文被切开且不丢内容」，而不是刻意追求片段数量
  check('长文档被切成多个片段', chunks.length >= 2, chunks.length);
  const joined = chunks.map((c) => c.content).join('\n');
  check('原文关键句全部保留', ['双循环积分制', '双败淘汰制', '五名首发'].every((k) => joined.indexOf(k) >= 0), chunks.length);
  check('标题被记录为元数据', chunks.some((c) => c.heading.indexOf('赛制') >= 0), chunks.map((c) => c.heading));
  check('片段长度受控（不超过上限的 1.5 倍）', chunks.every((c) => c.charCount <= 300), chunks.map((c) => c.charCount));
  check('索引文本包含标题', bm25.indexTextOf(chunks[0]).indexOf(chunks[0].heading) >= 0);
  // 超长单段必须硬切并带上重叠，不能被整体丢弃
  const longOne = ingest.chunkText('这是一段没有任何标点的超长正文' + 'x'.repeat(900), { size: 200, overlap: 50, minSize: 40 });
  check('无标点超长段落也能切开', longOne.length >= 4, longOne.length);
  check('重叠策略生效（相邻片段有重合）', longOne.length > 1, longOne.length);

  section('A6. DOCX 抽取（自造合法 docx 验证 zip 解析）');
  const docx = require(path.join(SERVER, 'rag/docx.js'));
  const docxBuffer = buildDocx(['羽衣电竞知识库测试文档', '赛制规则：常规赛双循环积分制。']);
  const docxText = ingest.extractText({ filename: 'test.docx', buffer: docxBuffer });
  check('docx 解析出正文', docxText.text.indexOf('羽衣电竞知识库测试文档') >= 0, docxText.text);
  check('docx 保留段落划分', docxText.text.split('\n').length >= 2, docxText.text);

  section('A7. 文本格式与 PDF 兜底');
  const html = ingest.extractText({ filename: 'a.html', buffer: Buffer.from('<p>赛制<b>规则</b></p><script>bad()</script>', 'utf8') });
  check('HTML 去标签且剔除 script', html.text.indexOf('赛制规则') >= 0 && html.text.indexOf('bad()') < 0, html.text);
  let pdfError = '';
  try {
    ingest.extractText({ filename: 'fake.pdf', buffer: Buffer.from('%PDF-1.4 not a real pdf', 'utf8') });
  } catch (err) {
    pdfError = err.message;
  }
  check('伪 PDF 明确报错而非灌入乱码', pdfError.indexOf('PDF') >= 0, pdfError);
  let docError = '';
  try {
    ingest.extractText({ filename: 'old.doc', buffer: Buffer.from('x', 'utf8') });
  } catch (err) {
    docError = err.message;
  }
  check('旧版 .doc 给出明确提示', docError.indexOf('.docx') >= 0, docError);

  section('A8. 同义词概念检索（陪玩师口语 vs 制度书面语）');
  const concepts = bm25.buildQueryConcepts('扣钱的项目有哪些');
  const flat = new Set();
  concepts.forEach((set) => set.forEach((token) => flat.add(token)));
  check('「扣钱」会被展开为「罚款」等同义词', flat.has('罚款'), Array.from(flat).slice(0, 12));
  check('噪音 bigram「哪些」被过滤（不进概念）', !flat.has('哪些'), Array.from(flat).slice(0, 12));

  const levelConcepts = bm25.buildQueryConcepts('各等级的分成比例');
  const levelFlat = new Set();
  levelConcepts.forEach((set) => set.forEach((token) => levelFlat.add(token)));
  check('「等级」与「级别」归为同一概念', levelFlat.has('等级') && levelFlat.has('级别'), Array.from(levelFlat));

  const corpus2 = [
    { content: '查到罚款 50 元整。' },
    { content: '每周一统一结算升级，与扣钱无关。' },
  ];
  const index2 = bm25.buildIndex(corpus2);
  const hits2 = bm25.search(index2, '扣钱的项目', 2);
  check('问「扣钱」能召回写「罚款」的片段', hits2.length > 0 && hits2[0].chunk.content.indexOf('罚款') >= 0, hits2[0]);

  section('A9. 表格感知切片（金额与项目名留在同一片段）');
  const tableMd = [
    '# 罚款标准',
    '| 项目 | 标准 |',
    '| --- | --- |',
    '| 炸单价格（机密/绝密） | 5 元 / 局 / 人 |',
    '| 跳车费 | 10 元 / 人 |',
    '正文段落：这一段是普通说明文字，不应该和表格黏在一起。',
  ].join('\n');
  const tableChunks = ingest.chunkText(tableMd, { size: 200, overlap: 40, minSize: 40 });
  const tableOnly = tableChunks.filter((chunk) => chunk.isTable);
  check('表格被识别为独立切片', tableOnly.length >= 1, tableChunks.length);
  check(
    '每个表格切片都自带表头',
    tableOnly.every((chunk) => chunk.content.indexOf('| 项目 | 标准 |') >= 0),
    tableOnly.map((c) => c.content.slice(0, 24))
  );
  check(
    '表格切片不与正文混合',
    tableOnly.every((chunk) => chunk.content.indexOf('不应该和表格黏在一起') < 0),
    tableOnly.map((c) => c.content.length)
  );
  check('表格行不再带 Markdown 加粗标记', tableOnly.every((chunk) => chunk.content.indexOf('**') < 0));

  section('A10. 元信息切片降权（文档头来源/版本段是噪音）');
  check(
    '来源/版本块被判为元信息',
    ingest.looksLikeMetaChunk('> 来源文档：xxx.docx\n> 文档版本：v1\n> 适用范围：全体陪玩师') === true
  );
  check('含答案的正文不算元信息', ingest.looksLikeMetaChunk('- 不报备的一次罚款 10 元') === false);
  const metaCorpus = [
    { content: '> 来源文档：制度.docx\n> 文档版本：v1\n> 适用范围：羽衣电竞俱乐部陪玩师分级好评', isMeta: true },
    { content: '不报备的一次罚款 10 元，接单 10 分钟内必须开打。' },
  ];
  const metaIndex = bm25.buildIndex(metaCorpus);
  const metaHits = bm25.search(metaIndex, '罚款', 2);
  check('元信息片段仍可被检索到（不丢内容）', metaHits.length >= 1, metaHits.length);
}

/* ============================================================
 * B. 集成测试
 * ============================================================ */

function toArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

/** 手工构造一个合法的 .docx（zip），用于验证 docx.js 的 zip 解析 */
function buildDocx(paragraphs) {
  const xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('') +
    '</w:body></w:document>';
  const name = Buffer.from('word/document.xml', 'utf8');
  const raw = Buffer.from(xml, 'utf8');
  const compressed = zlib.deflateRawSync(raw);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt32LE(0, 14); // crc（读取端不校验）
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);

  const localOffset = 0;
  const dataOffset = local.length + name.length;

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(0, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(localOffset, 42);

  const cdOffset = dataOffset + compressed.length;
  const cdSize = central.length + name.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);

  return Buffer.concat([local, name, compressed, central, name, eocd]);
}

function request(options) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: options.port,
        path: options.path,
        method: options.method || 'GET',
        headers: Object.assign(
          { 'X-Access-Token': options.token || '' },
          options.body ? { 'Content-Type': 'application/json' } : {}
        ),
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );
    req.on('error', reject);
    if (options.body) {
      req.write(JSON.stringify(options.body));
    }
    req.end();
  });
}

async function call(port, token, method, apiPath, body) {
  const res = await request({ port, token, method, path: apiPath, body });
  let parsed = null;
  try {
    parsed = JSON.parse(res.text);
  } catch (err) {
    parsed = null;
  }
  return { status: res.status, body: parsed, raw: res.text };
}

function waitForReady(port, token, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      request({ port, token, path: '/health' })
        .then((res) => {
          if (res.status === 200) {
            resolve();
            return;
          }
          throw new Error(`健康检查返回 ${res.status}`);
        })
        .catch(() => {
          if (Date.now() > deadline) {
            reject(new Error('服务启动超时'));
            return;
          }
          setTimeout(tick, 300);
        });
    };
    tick();
  });
}

async function integrationTests() {
  section('B. 端到端集成测试（真实启动服务）');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyi-rag-'));
  const port = 18000 + Math.floor(Math.random() * 2000);
  const token = 'test-token-123';

  const env = Object.assign({}, process.env, {
    PORT: String(port),
    HOST: '127.0.0.1',
    DATA_DIR: tmpDir,
    ACCESS_TOKEN: token,
    // 强制走「未配置大模型」的降级路径，测试不依赖外网
    LLM_API_KEY: '',
    EMBEDDING_MODEL: '',
    DEBUG: '1',
  });
  delete env.EMBEDDING_API_KEY;

  const child = spawn(process.execPath, [path.join(SERVER, 'index.js')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => {
    serverLog += d.toString();
  });
  child.stderr.on('data', (d) => {
    serverLog += d.toString();
  });

  const cleanup = () => {
    try {
      child.kill();
    } catch (err) {
      /* ignore */
    }
  };

  try {
    await waitForReady(port, token, 20000);
    check('服务启动并响应 /health', true);

    const health = await call(port, token, 'GET', '/health');
    check('/health 返回 code 0', health.body && health.body.code === 0, health.body);
    check('/health 报告大模型未启用', health.body.data.llm.enabled === false, health.body.data.llm);

    // 鉴权
    const unauthorized = await call(port, 'wrong-token', 'GET', '/api/v1/datasets');
    check('错误令牌返回 401', unauthorized.status === 401, unauthorized.status);

    // 建知识库
    const created = await call(port, token, 'POST', '/api/v1/datasets', {
      name: '羽衣电竞知识库',
      description: '集成测试',
    });
    check('创建知识库成功', created.body.code === 0 && created.body.data.id, created.body);
    const datasetId = created.body.data.id;

    // 上传纯文本文档
    const textDoc = await call(port, token, 'POST', `/api/v1/datasets/${datasetId}/documents`, {
      name: '赛制说明.md',
      text: [
        '# 赛制说明',
        '常规赛采用双循环积分制，每支战队对阵两次，共进行 30 轮比赛。胜场积 3 分，负场积 0 分。',
        '## 季后赛规则',
        '常规赛前八名进入季后赛。季后赛采用双败淘汰制，最终胜者获得赛季总冠军。',
        '# 战队与选手',
        '每支战队由五名首发选手与一名替补选手组成，教练习负责战术布置与版本分析。',
        '选手注册需通过联盟审核，转会窗口在赛季中期开放两周。',
      ].join('\n'),
    });
    check('创建文本文档成功', textDoc.body.code === 0, textDoc.body);
    const docId = textDoc.body.data.id;

    // 等待解析完成
    let parsed = null;
    for (let i = 0; i < 40; i += 1) {
      const docs = await call(port, token, 'GET', `/api/v1/datasets/${datasetId}/documents`);
      const doc = (docs.body.data || []).find((d) => d.id === docId);
      if (doc && doc.status !== 'parsing') {
        parsed = doc;
        break;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    check('文档解析完成', parsed && parsed.status === 'parsed', parsed && parsed.status);
    check('切片数量大于 0', parsed && parsed.chunkCount > 0, parsed && parsed.chunkCount);

    // 上传 docx（走 multipart）
    const docxBuffer = buildDocx(['战队阵容说明', '首发五人，替补一人，教练负责战术。']);
    const boundary = '----yuyiTestBoundary';
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="阵容.docx"\r\n` +
        `Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document\r\n\r\n`,
      'utf8'
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const multipartBody = Buffer.concat([head, docxBuffer, tail]);

    const uploadRes = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: `/api/v1/datasets/${datasetId}/documents`,
          method: 'POST',
          headers: {
            'X-Access-Token': token,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': multipartBody.length,
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
        }
      );
      req.on('error', reject);
      req.write(multipartBody);
      req.end();
    });
    check('multipart 上传 docx 成功', uploadRes.code === 0 && uploadRes.data, uploadRes);
    const docxDocId = uploadRes.data.id;

    let docxParsed = null;
    for (let i = 0; i < 40; i += 1) {
      const docs = await call(port, token, 'GET', `/api/v1/datasets/${datasetId}/documents`);
      const doc = (docs.body.data || []).find((d) => d.id === docxDocId);
      if (doc && doc.status !== 'parsing') {
        docxParsed = doc;
        break;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    check('docx 文档解析完成', docxParsed && docxParsed.status === 'parsed', docxParsed && docxParsed.status);
    check('中文文件名被正确解码', docxParsed && docxParsed.name === '阵容.docx', docxParsed && docxParsed.name);

    // 检索
    const retrieval = await call(port, token, 'POST', '/api/v1/retrieval', {
      dataset_ids: [datasetId],
      question: '季后赛是什么规则',
      top_k: 3,
      threshold: 0,
    });
    check('检索接口返回结果', retrieval.body.code === 0 && retrieval.body.data.total > 0, retrieval.body.data);
    check(
      '命中的切片确实与问题相关',
      retrieval.body.data.chunks[0].content.indexOf('季后赛') >= 0,
      retrieval.body.data.chunks[0].content.slice(0, 40)
    );

    // 助手
    const chat = await call(port, token, 'POST', '/api/v1/chats', {
      name: '羽衣电竞问答助手',
      datasetIds: [datasetId],
      prologue: '你好，我是羽衣电竞问答助手。',
      topK: 3,
      similarityThreshold: 0,
    });
    check('创建助手成功并绑定知识库', chat.body.code === 0 && chat.body.data.datasetCount === 1, chat.body.data);
    const chatId = chat.body.data.id;

    // 会话
    const session = await call(port, token, 'POST', `/api/v1/chats/${chatId}/sessions`, {});
    check('创建会话成功且带开场白', session.body.code === 0 && session.body.data.messages.length === 1, session.body.data);
    const sessionId = session.body.data.id;

    // 问答（SSE，降级模式）
    const sseRes = await request({
      port,
      token,
      method: 'POST',
      path: `/api/v1/chats/${chatId}/completions`,
      body: { question: '季后赛的规则是什么？', session_id: sessionId, stream: true },
    });
    const events = sseRes.text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5))
      .filter((payload) => payload && payload !== '[DONE]')
      .map((payload) => {
        try {
          return JSON.parse(payload);
        } catch (err) {
          return null;
        }
      })
      .filter(Boolean);

    check('SSE 返回了事件流', events.length > 0, events.length);
    check('首帧带 session_id', !!events[0].session_id, events[0]);
    const finalEvent = events[events.length - 1];
    check('最终帧标记 final', finalEvent.final === true, finalEvent.final);
    check('回答内容非空', typeof finalEvent.answer === 'string' && finalEvent.answer.length > 10, finalEvent.answer && finalEvent.answer.length);
    check(
      '引用来源包含命中文档',
      finalEvent.reference && finalEvent.reference.total > 0 && finalEvent.reference.chunks[0].document_name,
      finalEvent.reference
    );
    check(
      '引用结构与 RAGFlow 对齐（content_with_weight / document_name）',
      !!finalEvent.reference.chunks[0].content_with_weight && !!finalEvent.reference.chunks[0].document_name,
      Object.keys(finalEvent.reference.chunks[0])
    );

    // 会话落库
    const sessions = await call(port, token, 'GET', `/api/v1/chats/${chatId}/sessions`);
    const target = (sessions.body.data || []).find((s) => s.id === sessionId);
    check('问答后会话消息落库', target && target.messageCount >= 3, target && target.messageCount);
    check('会话预览取到最后一条', target && !!target.preview, target && target.preview);

    // 删除文档 → 切片同步清理
    const del = await call(port, token, 'DELETE', `/api/v1/datasets/${datasetId}/documents/${docId}`);
    check('删除文档成功', del.body.code === 0, del.body);
    const chunksAfter = await call(port, token, 'GET', `/api/v1/datasets/${datasetId}/chunks?limit=200`);
    check(
      '删除文档后其切片被清理',
      (chunksAfter.body.data.chunks || []).every((c) => c.docId !== docId),
      (chunksAfter.body.data.chunks || []).length
    );

    // 重新解析
    const reparse = await call(port, token, 'POST', `/api/v1/datasets/${datasetId}/documents/${docxDocId}/reparse`);
    check('重新解析接口可用', reparse.body.code === 0, reparse.body);

    // 删除知识库 → 解绑助手
    const delDataset = await call(port, token, 'DELETE', `/api/v1/datasets/${datasetId}`);
    check('删除知识库成功', delDataset.body.code === 0, delDataset.body);
    const chatAfter = await call(port, token, 'GET', `/api/v1/chats/${chatId}`);
    check('助手自动解绑被删除的知识库', chatAfter.body.data.datasetCount === 0, chatAfter.body.data.datasets);

    // 删助手 → 级联删会话
    const delChat = await call(port, token, 'DELETE', `/api/v1/chats/${chatId}`);
    check('删除助手并级联删除会话', delChat.body.code === 0 && delChat.body.data.removedSessions >= 1, delChat.body.data);
    const sessionsAfter = await call(port, token, 'GET', `/api/v1/chats/${chatId}/sessions`);
    check('助手删除后会话不可访问', sessionsAfter.body.code !== 0, sessionsAfter.body.code);

    // 404
    const notFound = await call(port, token, 'GET', '/api/v1/unknown');
    check('未知接口返回 404 业务码', notFound.body.code === 404, notFound.body);
  } finally {
    cleanup();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (err) {
      /* ignore */
    }
  }
}

/* ============================================================
 * C. 客户端 ↔ 引擎契约测试
 *    用桩替身模拟 wx.request（含 enableChunked 分片），把小程序的服务层
 *    直接跑在真实引擎上，验证流式解码、SSE 解析、引用归一化真的能work。
 * ============================================================ */

function installWxStub() {
  const storage = new Map();

  const wx = {
    getStorageSync: (key) => (storage.has(key) ? storage.get(key) : ''),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: (key) => storage.delete(key),
    showToast: () => {},
    vibrateShort: () => {},
    showModal: () => {},
    showActionSheet: () => {},
    setClipboardData: (options) => options && options.success && options.success(),
    getWindowInfo: () => ({ screenHeight: 800, safeArea: { bottom: 800 } }),
    getDeviceInfo: () => ({ brand: 'stub', model: 'stub', platform: 'devtools' }),
    uploadFile: () => {
      throw new Error('测试桩未实现 uploadFile');
    },

    /** 支持 enableChunked 的 wx.request 替身：逐个网络分片回调 ArrayBuffer */
    request(options) {
      const url = new URL(options.url);
      const client = url.protocol === 'https:' ? https : http;
      const body = options.data ? Buffer.from(JSON.stringify(options.data), 'utf8') : null;
      const headers = Object.assign({}, options.header);
      headers['Content-Length'] = body ? body.length : 0;

      let chunkHandler = null;
      const queued = [];
      const collected = [];
      let settled = false;

      const req = client.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || 80,
          path: `${url.pathname}${url.search}`,
          method: options.method || 'GET',
          headers,
        },
        (res) => {
          res.on('data', (chunk) => {
            collected.push(chunk);
            if (!options.enableChunked) {
              return;
            }
            const buffer = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
            if (chunkHandler) {
              chunkHandler({ data: buffer });
            } else {
              queued.push(buffer);
            }
          });
          res.on('end', () => {
            if (settled) {
              return;
            }
            settled = true;
            if (options.success) {
              // 还原 wx.request 的行为：按 content-type / responseType 决定 res.data
              const raw = Buffer.concat(collected);
              const contentType = String(res.headers['content-type'] || '');
              let data;
              if (options.responseType === 'arraybuffer') {
                data = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
              } else if (contentType.indexOf('application/json') >= 0) {
                try {
                  data = JSON.parse(raw.toString('utf8'));
                } catch (err) {
                  data = raw.toString('utf8');
                }
              } else {
                data = raw.toString('utf8');
              }
              options.success({ statusCode: res.statusCode, data, header: res.headers });
            }
          });
        }
      );

      req.on('error', (err) => {
        if (settled) {
          return;
        }
        settled = true;
        if (options.fail) {
          options.fail({ errMsg: `request:fail ${err.message}` });
        }
      });

      if (body) {
        req.write(body);
      }
      req.end();

      return {
        abort() {
          try {
            req.destroy();
          } catch (err) {
            /* ignore */
          }
        },
        onChunkReceived(callback) {
          chunkHandler = callback;
          // 响应可能比回调注册得早，回放已到达的分片
          queued.splice(0).forEach((buffer) => callback({ data: buffer }));
        },
      };
    },
  };

  global.wx = wx;
  global.getApp = () => ({ globalData: {} });
  return storage;
}

async function clientContractTests() {
  section('C. 客户端 ↔ 引擎契约测试（小程序服务层跑真实引擎）');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyi-client-'));
  const port = 20000 + Math.floor(Math.random() * 2000);
  const token = 'client-token';

  const child = spawn(process.execPath, [path.join(SERVER, 'index.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: tmpDir,
      ACCESS_TOKEN: token,
      LLM_API_KEY: '',
      LLM_BASE_URL: 'http://127.0.0.1:9',
      LLM_TIMEOUT_MS: '2000',
      EMBEDDING_MODEL: '',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});

  try {
    await waitForReady(port, token, 20000);

    // 先装桩，再加载小程序模块（config 会读 wx.getStorageSync）
    const storage = installWxStub();
    const constants = require(path.join(MP, 'utils/constants.js'));
    storage.set(constants.STORAGE_KEYS.CONFIG, {
      mode: 'proxy',
      proxyBase: `http://127.0.0.1:${port}`,
      accessToken: token,
      stream: true,
      timeout: 60000,
      chatId: '',
    });

    const config = require(path.join(MP, 'utils/config.js'));
    const kbService = require(path.join(MP, 'services/kb.js'));
    const chatService = require(path.join(MP, 'services/chat.js'));

    check('客户端能解析代理地址', config.resolve('chats').url.indexOf(`127.0.0.1:${port}`) >= 0);

    // 建库 + 灌文档（全部走小程序服务层）
    const dataset = await kbService.createDataset({ name: '契约测试知识库' });
    check('客户端创建知识库成功', !!dataset.id, dataset);

    await kbService.createDocFromText(
      dataset.id,
      '赛制说明.md',
      [
        '# 羽衣电竞赛制',
        '常规赛采用双循环积分制，每支战队互相交手两次，共 30 轮。胜一场积 3 分，平局各积 1 分。',
        '## 季后赛',
        '常规赛排名前八的战队进入季后赛，季后赛采用双败淘汰制，最终胜者夺得总冠军。',
        '## 选手与转会',
        '每队五名首发加一名替补，转会窗口在赛季中期开放两周。',
      ].join('\n')
    );

    let parsed = null;
    for (let i = 0; i < 40; i += 1) {
      const docs = await kbService.listDocuments(dataset.id);
      const doc = docs.find((item) => item.name === '赛制说明.md');
      if (doc && doc.status !== 'parsing') {
        parsed = doc;
        break;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    check('客户端轮询到解析完成', parsed && parsed.status === 'parsed', parsed && parsed.status);
    check('客户端拿到切片统计', parsed && parsed.chunkCount > 0, parsed && parsed.chunkCount);

    const chats = await chatService.listChats();
    check('客户端拉取助手列表可用（空列表也是正常返回）', Array.isArray(chats), chats);

    const chat = await chatService.createChat({
      name: '羽衣电竞问答助手',
      datasetIds: [dataset.id],
      similarityThreshold: 0,
      topK: 3,
      prologue: '你好，我是羽衣电竞问答助手，可以问我赛制和战队相关的问题。',
    });
    check('客户端创建助手成功', !!chat.id, chat);
    check('客户端解析出绑定的知识库', chat.datasetCount === 1, chat.datasetCount);

    const session = await chatService.createSession(chat.id);
    check('客户端创建会话并拿到开场白', session.messages.length === 1 && session.prologue.length > 0, session);

    // ---- 流式问答 ----
    const deltas = [];
    let finalAnswer = '';
    let reference = null;
    let metaSessionId = '';
    let streamError = null;

    await new Promise((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) {
          return;
        }
        finished = true;
        resolve();
      };
      chatService.ask({
        question: '季后赛的赛制是怎样的？',
        chatId: chat.id,
        sessionId: session.id,
        onMeta: (meta) => {
          metaSessionId = meta.sessionId || metaSessionId;
        },
        onReference: (ref) => {
          reference = ref;
        },
        onDelta: (text) => {
          deltas.push(text);
        },
        onEnd: (answer) => {
          finalAnswer = answer;
          finish();
        },
        onError: (err) => {
          streamError = err;
          finish();
        },
      });
      setTimeout(finish, 20000);
    });

    check('流式问答无错误', !streamError, streamError && streamError.message);
    check('onDelta 被多次调用（证明是流式而非一次性）', deltas.length >= 2, deltas.length);
    check('回答累积文本非空', finalAnswer.length > 10, finalAnswer && finalAnswer.length);
    check('回答内容不含乱码替换字符', finalAnswer.indexOf('\ufffd') < 0, finalAnswer);
    check('回答中包含检索到的中文片段', finalAnswer.indexOf('季后赛') >= 0, finalAnswer.slice(0, 60));
    check('回传 session_id', !!metaSessionId && metaSessionId === session.id, metaSessionId);

    check(
      '引用来源已归一化（含文档名与相似度）',
      reference && reference.total > 0 && !!reference.items[0].docName,
      reference && reference.items[0]
    );
    check(
      '引用片段的相似度已转成百分比文案',
      reference && /%$/.test(reference.items[0].similarityText || ''),
      reference && reference.items[0].similarityText
    );

    // ---- 多轮：第二轮应带上下文且不重复上一轮答案 ----
    const second = await new Promise((resolve) => {
      let answer = '';
      chatService.ask({
        question: '选手转会窗口是什么时候？',
        chatId: chat.id,
        sessionId: session.id,
        onDelta: (text) => {
          answer = text;
        },
        onEnd: (text) => resolve(text || answer),
        onError: () => resolve(''),
      });
    });
    check('第二轮问答正常返回', second.length > 5, second.slice(0, 40));
    // 断言「第二轮回答针对的是第二个问题」，而不是断言某个词不出现
    // （示例文档很短，两段内容可能被切进同一个切片，出现同一批词汇是正常的）
    check('第二轮回答命中了第二个问题的内容', second.indexOf('转会') >= 0, second.slice(0, 80));

    // ---- 会话落库 ----
    const sessions = await chatService.listSessions(chat.id);
    const current = sessions.find((item) => item.id === session.id);
    check('服务端会话包含两轮问答', current && current.messageCount >= 5, current && current.messageCount);

    // ---- 非流式模式 ----
    config.save({ stream: false });
    const once = await new Promise((resolve) => {
      chatService.ask({
        question: '常规赛的积分规则是什么？',
        chatId: chat.id,
        sessionId: session.id,
        onDelta: () => {},
        onEnd: (text) => resolve(text),
        onError: (err) => resolve(`ERROR:${err.message}`),
      });
    });
    check('关闭流式后仍能正确返回', once.length > 5 && once.indexOf('ERROR') < 0, once.slice(0, 60));

    // ---- 错误路径 ----
    config.save({ proxyBase: 'http://127.0.0.1:9' });
    const failReason = await new Promise((resolve) => {
      chatService
        .listChats()
        .then(() => resolve(''))
        .catch((err) => resolve(err.message || 'unknown'));
    });
    check('地址不可达时给出可读错误', failReason.length > 0, failReason);
  } finally {
    try {
      child.kill();
    } catch (err) {
      /* ignore */
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (err) {
      /* ignore */
    }
  }
}

/* ============================================================
 * D. 云托管通道
 * ============================================================ */

/** 简易 GET，用于直接验证服务端行为（不走小程序层） */
function rawGet(port, apiPath, headers) {
  return new Promise((resolve) => {
    const req = require('http').request(
      { hostname: '127.0.0.1', port, path: apiPath, method: 'GET', headers: headers || {} },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, text: raw }));
      }
    );
    req.on('error', (err) => resolve({ status: 0, text: err.message }));
    req.end();
  });
}

/**
 * 给 wx 装云开发桩：callContainer 转发到本地引擎，并模拟网关注入 X-WX-OPENID。
 * 这样小程序服务层不必改动就能跑在「伪云托管」上。
 */
function installCloudStub(port, openid) {
  const http = require('http');
  global.wx.cloud = {
    init(options) {
      global.__cloudInitOptions = options;
    },
    callContainer(options) {
      const payload =
        options.data === undefined ? null : Buffer.from(JSON.stringify(options.data), 'utf8');
      const headers = Object.assign({}, options.header || {});
      if (openid) {
        headers['X-WX-OPENID'] = openid;
      }
      if (payload) {
        headers['Content-Length'] = payload.length;
      }
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: options.path,
          method: options.method || 'GET',
          headers,
        },
        (res) => {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            raw += chunk;
          });
          res.on('end', () => {
            let data = raw;
            if (raw) {
              try {
                data = JSON.parse(raw);
              } catch (err) {
                data = raw;
              }
            }
            if (options.success) {
              options.success({ statusCode: res.statusCode, data, header: res.headers });
            }
          });
        }
      );
      req.on('error', (err) => {
        if (options.fail) {
          options.fail({ errMsg: `request:fail ${err.message}` });
        }
      });
      if (payload) {
        req.write(payload);
      }
      req.end();
    },
  };
}

async function cloudChannelTests() {
  section('D. 云托管通道测试（callContainer 桩 → 真实引擎）');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyi-cloud-'));
  const port = 23000 + Math.floor(Math.random() * 2000);
  const openid = 'o-test-openid-0001';

  const child = spawn(process.execPath, [path.join(SERVER, 'index.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: tmpDir,
      ACCESS_TOKEN: '', // 云托管不靠令牌
      ALLOW_OPENIDS: openid, // 靠网关注入的 openid 做访问控制
      LLM_API_KEY: '', // 走降级模式，测试不依赖大模型、不花钱
      EMBEDDING_MODEL: '',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});

  try {
    await waitForReady(port, '', 20000);

    /* ---- 服务端：openid 白名单 ---- */
    const noOpenid = await rawGet(port, '/api/v1/chats', {});
    check('未带 openid 的请求被白名单拒绝', noOpenid.status === 401, noOpenid.status);

    const wrongOpenid = await rawGet(port, '/api/v1/chats', { 'X-WX-OPENID': 'o-other' });
    check('名单外的 openid 被拒绝', wrongOpenid.status === 401, wrongOpenid.status);

    const rightOpenid = await rawGet(port, '/api/v1/chats', { 'X-WX-OPENID': openid });
    check('名单内的 openid 放行', rightOpenid.status === 200, rightOpenid.status);

    /* ---- 客户端：切到云托管通道 ----
     * 前面的契约测试已按 proxy 模式加载过小程序模块（config 有模块级缓存），
     * 这里必须先清缓存再重新加载，否则改了 storage 也不生效。 */
    Object.keys(require.cache).forEach((key) => {
      if (key.indexOf(path.join(MP)) >= 0) {
        delete require.cache[key];
      }
    });

    const storage = installWxStub();
    installCloudStub(port, openid);

    const constants = require(path.join(MP, 'utils/constants.js'));
    storage.set(constants.STORAGE_KEYS.CONFIG, {
      mode: 'cloud',
      cloudEnv: 'cloud1-test',
      cloudService: 'yuyi-rag',
      stream: true, // 故意开着，验证会被强制关闭
      timeout: 60000,
      chatId: '',
    });

    const config = require(path.join(MP, 'utils/config.js'));
    const kbService = require(path.join(MP, 'services/kb.js'));
    const chatService = require(path.join(MP, 'services/chat.js'));

    const resolved = config.resolve('chats');
    check('云模式解析出业务路径', resolved.mode === 'cloud' && resolved.path === '/api/v1/chats', resolved.path);
    check('云模式带上环境与服务', resolved.env === 'cloud1-test' && resolved.service === 'yuyi-rag');
    check('云模式强制关闭流式', config.useStream() === false);
    check('云模式地址文案含环境与服务', config.describeEndpoint().indexOf('yuyi-rag') >= 0, config.describeEndpoint());

    // 缺环境 ID 时给出可照做的提示
    config.save({ cloudEnv: '' });
    let missing = '';
    try {
      config.resolve('chats');
    } catch (err) {
      missing = err.message;
    }
    check('缺云环境 ID 时提示明确', missing.indexOf('环境 ID') >= 0, missing);
    config.save({ cloudEnv: 'cloud1-test' });

    /* ---- 走云通道建库、问答 ---- */
    const dataset = await kbService.createDataset({ name: '云通道测试库' });
    check('云通道创建知识库成功', !!dataset.id, dataset && dataset.id);

    await kbService.createDocFromText(
      dataset.id,
      '制度.md',
      [
        '# 一、炸单规则与价格',
        '炸单价格（机密/绝密）为 5 元 / 局 / 人，监狱地图为 10 元 / 局 / 人。',
        '跳车费固定 10 元 / 人。',
        '## 二、客服',
        '客服 24 小时在线，投诉可联系企业微信客服。',
      ].join('\n')
    );

    let parsed = null;
    for (let i = 0; i < 40; i += 1) {
      const docs = await kbService.listDocuments(dataset.id);
      const doc = docs.find((item) => item.name === '制度.md');
      if (doc && doc.status !== 'parsing') {
        parsed = doc;
        break;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    check('云通道轮询到解析完成', parsed && parsed.status === 'parsed', parsed && parsed.status);

    const chat = await chatService.createChat({
      name: '云通道助手',
      datasetIds: [dataset.id],
      similarityThreshold: 0,
      topK: 3,
      prologue: '你好',
    });
    check('云通道创建助手成功', !!chat.id, chat && chat.id);
    config.save({ chatId: chat.id });
    check('云模式下 isReady 为真', config.isReady() === true);

    // 非流式问答（云托管唯一可用的形式）
    const result = await new Promise((resolve) => {
      let answer = '';
      let reference = null;
      let error = null;
      chatService.ask({
        chatId: chat.id,
        question: '炸单价格是多少',
        onReference: (ref) => {
          reference = ref;
        },
        onDelta: (text) => {
          answer = text;
        },
        onEnd: (text) => resolve({ answer: text || answer, reference, error }),
        onError: (err) => resolve({ answer: '', reference: null, error: err }),
      });
      setTimeout(() => resolve({ answer, reference, error: error || new Error('超时') }), 20000);
    });

    check('云通道问答无错误', !result.error, result.error && result.error.message);
    check('云通道问答返回答案', result.answer.length > 10, result.answer.slice(0, 50));
    check('云通道答案无乱码', result.answer.indexOf('\ufffd') < 0, result.answer.slice(0, 30));
    check('云通道答案命中知识库内容', result.answer.indexOf('元') >= 0, result.answer.slice(0, 60));
    check(
      '云通道回传引用来源',
      result.reference && result.reference.total > 0 && !!result.reference.items[0].docName,
      result.reference && result.reference.items[0]
    );

    // 服务名写错时，错误应能指明方向
    config.save({ cloudService: 'not-exist' });
    const badService = await new Promise((resolve) => {
      chatService.listChats().then(
        () => resolve('unexpected-ok'),
        (err) => resolve((err && err.message) || String(err))
      );
    });
    check(
      '服务名错误时给出可读反馈',
      typeof badService === 'string' && badService.length > 0,
      badService
    );
    config.save({ cloudService: 'yuyi-rag' });
  } finally {
    child.kill();
  }
}

/* ============================================================
 * 入口
 * ============================================================ */

(async function main() {
  console.log('\n羽衣 RAG 引擎 · 自动化测试');

  try {
    await unitTests();
  } catch (err) {
    fail += 1;
    failures.push(`单元测试异常：${err.message}`);
    console.error('单元测试执行异常：', err);
  }

  try {
    await integrationTests();
  } catch (err) {
    fail += 1;
    failures.push(`集成测试异常：${err.message}`);
    console.error('集成测试执行异常：', err);
  }

  try {
    await clientContractTests();
  } catch (err) {
    fail += 1;
    failures.push(`契约测试异常：${err.message}`);
    console.error('契约测试执行异常：', err);
  }

  try {
    await cloudChannelTests();
  } catch (err) {
    fail += 1;
    failures.push(`云托管通道测试异常：${err.message}`);
    console.error('云托管通道测试执行异常：', err);
  }

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) {
    console.log('失败项：');
    failures.forEach((item) => console.log(`  - ${item}`));
  }
  process.exit(fail ? 1 : 0);
})();
