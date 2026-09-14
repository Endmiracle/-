/**
 * seed.js - 命令行导入知识库（server/seed.js 的薄壳）
 *
 * 用法：
 *   npm run seed              # 导入 server/knowledge 下的 .md
 *   npm run seed -- --force   # 已有同名知识库时先删除重建
 *   npm run seed -- --dir <路径>
 *
 * 导入逻辑在 server/seed.js（云托管容器启动时复用同一份），这里只负责命令行输出。
 */

const path = require('path');

const ROOT = path.join(__dirname, '..');
const serverSeed = require(path.join(ROOT, 'server/seed'));
const store = require(path.join(ROOT, 'server/store'));
const config = require(path.join(ROOT, 'server/config'));

function parseArgs(argv) {
  const options = { force: false, dir: serverSeed.defaultDir() };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--force') {
      options.force = true;
    } else if (argv[i] === '--dir') {
      options.dir = path.resolve(argv[i + 1]);
      i += 1;
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  console.log('\n羽衣电竞制度知识库 · 导入');
  console.log('─'.repeat(58));
  console.log(`素材目录：${options.dir}`);
  console.log(`数据目录：${config.dataDir}`);

  store.init();
  const result = await serverSeed.run({ dir: options.dir, force: options.force });

  console.log('\n[4/4] 完成');
  console.log('─'.repeat(58));
  console.log(`知识库：${serverSeed.DATASET_NAME}`);
  console.log(
    `文档  ：${result.stats.parsedDocCount}/${result.stats.docCount} 解析成功，失败 ${result.stats.failedDocCount}`
  );
  console.log(`切片  ：${result.stats.chunkCount} 个，共 ${result.stats.charCount} 字符`);
  console.log(`助手  ：${result.chat.name}`);
  console.log('─'.repeat(58));
  console.log('下一步：npm run proxy 启动引擎，再在小程序「设置」页填入服务地址。');
  console.log('');

  if (result.failed.length) {
    console.log('以下文档未解析成功，请检查：');
    result.failed.forEach((item) => console.log(`  · ${item.name}：${item.error}`));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\n导入失败：', err);
  process.exit(1);
});
