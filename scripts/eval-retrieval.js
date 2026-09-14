/**
 * eval-retrieval.js - 领域检索质量验收
 *
 * 为什么单独做这个脚本：制度问答系统的成败几乎全在「能不能召回正确条款」上，
 * 大模型只是把召回的片段组织成人话。所以用一批真实提问做回归，
 * 每次改切片参数、同义词表、阈值之后都跑一遍，避免悄悄变差。
 *
 * 用法：
 *   node scripts/eval-retrieval.js             # 跑全部用例
 *   node scripts/eval-retrieval.js --show 3    # 每个问题打印前 3 个片段
 *   node scripts/eval-retrieval.js --topk 8    # 调整候选数
 *
 * 前置：先执行 node scripts/seed.js 导入制度知识库
 */

const path = require('path');

const ROOT = path.join(__dirname, '..');
const store = require(path.join(ROOT, 'server/store'));
const retrieve = require(path.join(ROOT, 'server/rag/retrieve'));

/**
 * 用例格式：
 *   q        提问（陪玩师的口语问法）
 *   must     期望命中的关键词（全部出现在同一个片段里才算命中）
 *   loose    宽松模式（默认 false）：宽泛/语义型问题没有单一「标准答案」，正确行为是
 *            召回一批相关片段交给大模型综合。这类用例改为检查 Top-K（助手实际取 K 个）
 *            而非 Top-3，并且只要求「出现任意相关片段」。
 *   group    测试分组，便于看哪一类问题容易漏
 */
const CASES = [
  // ---- 等级与分成 ----
  { group: '等级', q: '钻石陪玩保级需要多少单？', must: ['钻石', '指定单'] },
  { group: '等级', q: '新晋打手的分成是多少？', must: ['新晋打手'] },
  { group: '等级', q: '升级魔王要多少单？', must: ['魔王'] },
  { group: '等级', q: '明星陪玩保级要求', must: ['明星'] },
  { group: '等级', q: '各等级的分成比例分别是多少', must: ['分成比例'] },
  { group: '等级', q: '什么时候统一升级', must: ['每周一'] },

  // ---- 金额与罚款 ----
  { group: '金额', q: '炸单要扣多少钱？', must: ['炸单'] },
  { group: '金额', q: '跳车费是多少', must: ['跳车费'] },
  { group: '金额', q: '群里互骂罚款多少', must: ['互骂'] },
  { group: '金额', q: '故意卡保底罚多少', must: ['卡保底'] },
  { group: '金额', q: '私发收款码会怎么样', must: ['收款码'] },
  { group: '金额', q: '外派单子怎么处理', must: ['外派'] },
  { group: '金额', q: '打手私藏物资被举报', must: ['私藏'] },
  { group: '金额', q: '卖号罚款多少钱', must: ['卖号'] },

  // ---- 操作流程 ----
  { group: '流程', q: '接单后老板失联怎么办？', must: ['失联'] },
  { group: '流程', q: '订单报备格式是什么样的', must: ['报备格式'] },
  { group: '流程', q: '接单后多久必须开打', must: ['开打'] },
  { group: '流程', q: '补单有什么要求', must: ['补单'] },
  { group: '流程', q: '退俱乐部领平台搭建费要什么条件', must: ['平台搭建费'] },
  { group: '流程', q: '连炸几把要强制换人', must: ['换人'] },

  // ---- 客服与投诉 ----
  { group: '客服', q: '客服链接在哪里？', must: ['客服'] },
  { group: '客服', q: '客服不处理问题去哪里投诉', must: ['投诉'] },
  { group: '客服', q: '客服是 24 小时在线吗', must: ['24'] },

  // ---- 口语化 / 同义词（考验同义词概念扩展） ----
  { group: '口语', q: '扣钱的项目有哪些', must: ['罚款'], loose: true },
  { group: '口语', q: '被罚钱最狠的是哪种情况', must: ['罚款'], loose: true },
  { group: '口语', q: '怎么才能升级快一点', must: ['升级'] },
  { group: '口语', q: '价格表在哪', must: ['价格'] },
  { group: '口语', q: '老板投诉态度不好会怎样', must: ['态度'] },
  { group: '口语', q: '打手之间能互相加好友吗', must: ['好友'] },
  { group: '口语', q: '不开麦会被罚吗', must: ['开麦'] },
  { group: '口语', q: '装备有什么要求', must: ['装备'] },
];

function parseArgs(argv) {
  const options = { show: 0, topk: 6 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--show') {
      options.show = Number(argv[i + 1]) || 3;
      i += 1;
    } else if (argv[i] === '--topk') {
      options.topk = Number(argv[i + 1]) || 6;
      i += 1;
    }
  }
  return options;
}

function snippet(text, keywords) {
  const str = String(text || '').replace(/\s+/g, ' ');
  const keyword = (keywords || []).find((item) => str.indexOf(item) >= 0) || '';
  const index = keyword ? str.indexOf(keyword) : 0;
  const start = Math.max(0, index - 18);
  return `${start > 0 ? '…' : ''}${str.slice(start, start + 70)}…`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  store.init();
  const dataset = store.all('datasets')[0];
  if (!dataset) {
    console.error('\n没有找到知识库，请先执行：node scripts/seed.js\n');
    process.exit(1);
  }

  const chunkCount = store.getChunks(dataset.id).length;
  console.log('\n检索质量验收');
  console.log('─'.repeat(92));
  console.log(`知识库：${dataset.name}（${chunkCount} 个切片，阈值 ${dataset.chunkSize}/${dataset.chunkOverlap}）`);
  console.log(`候选数：Top ${options.topk}　判定：具体问题 Top3 命中即过，宽泛问题查 Top ${options.topk}`);
  console.log('─'.repeat(92));

  let pass = 0;
  const failures = [];
  const groupStats = {};

  for (const testCase of CASES) {
    // eslint-disable-next-line no-await-in-loop
    const result = await retrieve.search({
      datasetIds: [dataset.id],
      question: testCase.q,
      topK: options.topk,
      threshold: 0,
    });

    const window = testCase.loose ? options.topk : 3;
    const topWindow = result.chunks.slice(0, window);
    const hitIndex = topWindow.findIndex((chunk) =>
      testCase.must.every((keyword) => String(chunk.content).indexOf(keyword) >= 0)
    );
    const ok = hitIndex >= 0;
    const best = result.chunks[0];

    if (ok) {
      pass += 1;
    } else {
      failures.push({ ...testCase, best: best ? best.content.slice(0, 80) : '（无结果）' });
    }

    if (!groupStats[testCase.group]) {
      groupStats[testCase.group] = { total: 0, ok: 0 };
    }
    groupStats[testCase.group].total += 1;
    if (ok) {
      groupStats[testCase.group].ok += 1;
    }

    const mark = ok ? '\u2713' : '\u2717';
    const score = best ? `${(best.similarity * 100).toFixed(0)}%` : '—';
    console.log(
      `${mark} [${testCase.group}] ${testCase.q}`
    );
    if (best) {
      console.log(
        `    命中第 ${hitIndex >= 0 ? hitIndex + 1 : '-'} 位　最高分 ${score}　${
          best.docName
        }　${best.heading ? `${best.heading}　` : ''}`
      );
      console.log(`    ${snippet(ok ? topWindow[hitIndex].content : best.content, testCase.must)}`);
    }

    if (options.show) {
      result.chunks.slice(0, options.show).forEach((chunk, index) => {
        console.log(
          `      ${index + 1}. ${(chunk.similarity * 100).toFixed(0)}%　覆盖率 ${(
            chunk.coverage * 100
          ).toFixed(0)}%　${snippet(chunk.content, testCase.must)}`
        );
      });
    }
    console.log('');
  }

  console.log('─'.repeat(92));
  console.log('分组通过率：');
  Object.keys(groupStats).forEach((group) => {
    const item = groupStats[group];
    const rate = ((item.ok / item.total) * 100).toFixed(0);
    console.log(`  ${group.padEnd(6, '　')} ${item.ok}/${item.total}　${rate}%`);
  });

  const total = CASES.length;
  const rate = ((pass / total) * 100).toFixed(1);
  console.log(`\n总计：${pass}/${total} 通过（${rate}%）`);

  if (failures.length) {
    console.log('\n未通过的用例：');
    failures.forEach((item) => {
      console.log(`  ✗ ${item.q}`);
      console.log(`    期望包含：${item.must.join(' + ')}`);
      console.log(`    实际首位：${item.best}`);
    });
    console.log('');
    process.exit(1);
  }

  console.log('全部通过。\n');
}

main().catch((err) => {
  console.error('验收脚本异常：', err);
  process.exit(1);
});
