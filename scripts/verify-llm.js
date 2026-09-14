/**
 * verify-llm.js - 端到端验证「引擎 → 大模型」真实链路
 *
 * 会真实调用大模型（产生少量费用），验证：
 *   1. 引擎能起来、大模型已启用
 *   2. 检索能召回条款
 *   3. 大模型能基于条款给出流式回答
 *   4. 引用来源正确，且回答里的金额能在引用中找到（防止幻觉）
 *
 * 用法：node scripts/verify-llm.js
 */

const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 18900 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;

function request(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: PORT,
        path: apiPath,
        method,
        headers: Object.assign(
          { 'Content-Type': 'application/json' },
          payload ? { 'Content-Length': payload.length } : {}
        ),
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: res.statusCode, body: JSON.parse(text), text });
          } catch (err) {
            resolve({ status: res.statusCode, body: null, text });
          }
        });
      }
    );
    req.on('error', reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

/** 发一条流式问答，返回最终帧 */
function ask(chatId, question, sessionId) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(
      JSON.stringify({ question, session_id: sessionId, stream: true }),
      'utf8'
    );
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: PORT,
        path: `/api/v1/chats/${chatId}/completions`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
      },
      (res) => {
        let last = null;
        let frameCount = 0;
        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          let index = buffer.indexOf('\n');
          while (index >= 0) {
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            if (line.startsWith('data:')) {
              const data = line.slice(5).trim();
              if (data && data !== '[DONE]') {
                try {
                  last = JSON.parse(data);
                  frameCount += 1;
                } catch (err) {
                  /* ignore */
                }
              }
            }
            index = buffer.indexOf('\n');
          }
        });
        res.on('end', () => resolve({ last, frameCount }));
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function waitReady(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await request('GET', '/health');
      if (res.status === 200) {
        return res.body.data;
      }
    } catch (err) {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('引擎启动超时');
}

async function main() {
  const child = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), HOST: '127.0.0.1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => {
    serverLog += d.toString();
  });
  child.stderr.on('data', (d) => {
    serverLog += d.toString();
  });

  let failed = 0;
  const check = (label, ok, extra) => {
    console.log(`  ${ok ? '\u2713' : '\u2717'} ${label}${extra ? `  ${extra}` : ''}`);
    if (!ok) failed += 1;
  };

  try {
    console.log('\n大模型链路验证');
    console.log('─'.repeat(74));
    const health = await waitReady();
    console.log(`引擎已启动：${BASE}`);
    console.log(`大模型：${health.llm.model} @ ${health.llm.baseUrl}`);
    console.log('─'.repeat(74));

    check('大模型已启用', health.llm.enabled === true, `model=${health.llm.model}`);
    check('知识库已就绪', health.counts.datasets > 0, `${health.counts.datasets} 个知识库`);
    check('助手已就绪', health.counts.chats > 0, `${health.counts.chats} 个助手`);
    if (!health.llm.enabled || !health.counts.chats) {
      console.log('\n前置条件不满足，停止验证。');
      process.exit(1);
    }

    const chats = (await request('GET', '/api/v1/chats')).body.data;
    const chat = chats[0];
    const datasetId = chat.datasetIds[0];

    // 1) 检索
    const retrieval = await request('POST', '/api/v1/retrieval', {
      dataset_ids: [datasetId],
      question: '炸单扣多少钱',
      top_k: 5,
      threshold: 0,
    });
    const hit = retrieval.body.data.chunks[0];
    check('检索命中条款', !!hit, hit ? `${hit.docName} · ${hit.heading}` : '无结果');
    check('命中片段包含金额', !!hit && /元/.test(hit.content), hit ? hit.content.slice(0, 40) : '');

    // 2) 流式问答
    console.log('\n【问答 1】炸单扣多少钱？');
    const started = Date.now();
    const first = await ask(chat.id, '炸单扣多少钱');
    const elapsed = Date.now() - started;
    const answer = (first.last && first.last.answer) || '';
    console.log(`  ${answer.replace(/\n/g, '\n  ')}`);
    console.log('');

    check('收到多帧流式输出', first.frameCount >= 2, `${first.frameCount} 帧`);
    check('回答非空', answer.length > 10, `${answer.length} 字`);
    check('回答无乱码', answer.indexOf('\ufffd') < 0);
    check('非降级输出（走的是大模型）', !first.last.degraded, `degraded=${!!first.last.degraded}`);
    check('无生成错误', !first.last.error, first.last.error || '');
    check('响应耗时合理', elapsed < 180000, `${(elapsed / 1000).toFixed(1)}s`);

    const refs = (first.last.reference && first.last.reference.chunks) || [];
    check('引用来源非空', refs.length > 0, `${refs.length} 个片段`);

    // 防幻觉：回答里出现的金额应当能在引用片段里找到
    const amountsInAnswer = Array.from(new Set(answer.match(/\d+\s*元/g) || []));
    const refText = refs.map((item) => item.content).join('\n');
    const grounded = amountsInAnswer.filter((amount) => refText.indexOf(amount.replace(/\s+/g, ' ')) >= 0 || refText.indexOf(amount) >= 0);
    check(
      '回答中的金额在引用里有出处（防幻觉）',
      amountsInAnswer.length === 0 || grounded.length === amountsInAnswer.length,
      amountsInAnswer.length ? `${grounded.length}/${amountsInAnswer.length}：${amountsInAnswer.join('、')}` : '回答未出现具体金额'
    );

    // 3) 多轮
    console.log('【问答 2】钻石陪玩保级要几单？');
    const second = await ask(chat.id, '钻石陪玩保级要几单？', first.last.session_id);
    const answer2 = (second.last && second.last.answer) || '';
    console.log(`  ${answer2.replace(/\n/g, '\n  ')}`);
    console.log('');
    check('多轮问答正常', answer2.length > 10 && !second.last.degraded, `${answer2.length} 字`);
    check('多轮未串台（回答针对第二个问题）', answer2.indexOf('钻石') >= 0 || answer2.indexOf('指定单') >= 0);

    // 4) 非流式
    console.log('【问答 3】客服链接在哪里？（非流式）');
    const once = await request('POST', `/api/v1/chats/${chat.id}/completions`, {
      question: '客服链接在哪里？',
      stream: false,
    });
    const answer3 = (once.body && once.body.data && once.body.data.answer) || '';
    console.log(`  ${answer3.slice(0, 220).replace(/\n/g, '\n  ')}…`);
    console.log('');
    check('非流式返回正常', answer3.length > 10, `${answer3.length} 字`);
    check('客服链接被正确引用', /work\.weixin\.qq\.com/.test(answer3) || /客服/.test(answer3));

    // 5) 会话落库
    const sessions = (await request('GET', `/api/v1/chats/${chat.id}/sessions`)).body.data;
    check('会话已落库', sessions.length > 0 && sessions[0].messageCount >= 3, `${sessions.length} 个会话`);

    console.log('─'.repeat(74));
    console.log(failed ? `\n有 ${failed} 项未通过` : '\n全部通过：DeepSeek 链路正常');
  } catch (err) {
    console.error('\n验证异常：', err.message);
    if (serverLog) {
      console.error('引擎输出（末尾）：\n' + serverLog.split('\n').slice(-15).join('\n'));
    }
    failed += 1;
  } finally {
    try {
      child.kill();
    } catch (err) {
      /* ignore */
    }
  }

  process.exit(failed ? 1 : 0);
}

main();
