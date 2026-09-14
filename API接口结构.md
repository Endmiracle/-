# API 接口结构

本系统有三层接口，自上而下给出每一层的**请求/响应结构**：

```
① 小程序  ──►  ② 自建 RAG 引擎（/api/v1，与 RAGFlow 同构）  ──►  ③ 大模型 / 向量接口（OpenAI 兼容）
```

- ① 不用关心：已在小程序内部封装
- ② 是对接/联调的主要对象
- ③ 只在「接入大模型」「换模型」时看；改 `server/llm.js` 一个文件即可适配任意协议

> 本文所有字段与代码实现一一对应；补充字段（小程序侧）见 `miniprogram/services/`。

---

## 0. 通用约定

### 鉴权

| Header | 说明 |
|---|---|
| `Authorization: Bearer <token>` | 与 RAGFlow 一致 |
| `X-Access-Token: <token>` | 等价写法（小程序设置页填的走这个） |

服务端 `.env` 设了 `ACCESS_TOKEN` 才校验，留空表示不鉴权（仅本机调试）。鉴权失败返回 **HTTP 401** + `{ code: 401, message }`。

### 响应信封（与 RAGFlow 一致）

```jsonc
// 成功
{ "code": 0, "data": { ... } }

// 业务失败：注意 HTTP 仍是 200，看 body.code
{ "code": 404, "message": "助手不存在" }
```

### 错误码

| code | 含义 |
|---|---|
| 0 | 成功 |
| 400 | 参数问题（问题为空、缺少知识库、文件为空等） |
| 401 | 鉴权失败 |
| 404 | 资源不存在 / 接口不存在 |
| 500 | 服务异常 |

---

## 1. 健康检查

```http
GET /health
```

```json
{
  "code": 0,
  "data": {
    "status": "ok",
    "time": "2026-09-11T08:00:00.000Z",
    "llm": { "enabled": true, "model": "deepseek-chat", "baseUrl": "https://api.deepseek.com/v1" },
    "embedding": { "enabled": false, "model": "" },
    "counts": { "datasets": 1, "documents": 2, "chats": 1, "sessions": 3 }
  }
}
```

不需要鉴权，是判断「引擎在不在、大模型配没配」最快的入口。

---

## 2. 知识库 / 文档

### 2.1 知识库对象 `dataset`

```jsonc
{
  "id": "46b18d27...",        // 32 位十六进制
  "name": "羽衣电竞陪玩制度",
  "description": "等级分成、炸单价格、罚款标准、报备与客服",
  "chunkSize": 400,           // 切片目标长度（字符）
  "chunkOverlap": 60,
  "embeddingModel": "",       // 空 = 未启用向量，走 BM25
  "docCount": 2,
  "parsedDocCount": 2,
  "parsingDocCount": 0,
  "failedDocCount": 0,
  "chunkCount": 34,
  "charCount": 5149,
  "createdAt": "...", "updatedAt": "..."
}
```

### 2.2 接口清单

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/datasets` | 列表（含上表统计字段） |
| POST | `/api/v1/datasets` | 创建：`{name, description?, chunkSize?, chunkOverlap?}` |
| GET | `/api/v1/datasets/{id}` | 详情 |
| PUT | `/api/v1/datasets/{id}` | 更新（字段均可选） |
| DELETE | `/api/v1/datasets/{id}` | 删除，级联删文档+切片并从所有助手解绑 → `{id, removedDocs}` |
| GET | `/api/v1/datasets/{id}/documents` | 文档列表 |
| POST | `/api/v1/datasets/{id}/documents` | 新增文档（JSON 文本 或 multipart 文件） |
| GET | `/api/v1/datasets/{id}/documents/{docId}` | 文档详情 |
| DELETE | `/api/v1/datasets/{id}/documents/{docId}` | 删文档及其切片 |
| POST | `/api/v1/datasets/{id}/documents/{docId}/reparse` | 重新解析 |
| GET | `/api/v1/datasets/{id}/documents/{docId}/chunks` | 该文档的切片 |
| GET | `/api/v1/datasets/{id}/chunks?offset=0&limit=50&keyword=` | 全库切片（分页/关键词） |

### 2.3 文档对象 `document`

```jsonc
{
  "id": "9fa7691c...",
  "datasetId": "46b18d27...",
  "name": "羽衣电竞陪玩制度.md",
  "sourceType": "text",        // text | file
  "size": 11183,               // 字节
  "status": "parsed",          // parsing | parsed | failed
  "progress": 1,               // 0~1，parsing 时前端展示进度条
  "progressMsg": "解析完成",
  "chunkCount": 24,
  "charCount": 3640,
  "parser": "plain",           // plain | html | docx | pdf | text
  "warning": "",               // 非致命提示（如 PDF 版式可能错位）
  "error": "",                 // failed 时的具体原因
  "createdAt": "...", "parsedAt": "..."
}
```

### 2.4 新增文档（两种方式）

**A. 纯文本（最常用，也最可靠）**

```bash
curl -X POST http://127.0.0.1:8787/api/v1/datasets/$DS/documents \
  -H "X-Access-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"制度.md","text":"## 一、炸单规则与价格\n| 项目 | 标准 |\n..."}'
```

**B. 文件上传（multipart/form-data）**

```
文件字段名固定为 file；可另带 formData: name=<文件名>
```

小程序侧已封装：`services/kb.js` 的 `uploadDocument`（内部用 `wx.uploadFile`）。

> **解析是异步的**：接口立即返回 `status:"parsing"`，客户端轮询文档列表看进度，大文件不会撑爆上传超时。

---

## 3. 切片与检索

### 3.1 切片对象 `chunk`

```jsonc
{
  "id": "...",
  "datasetId": "...", "docId": "...", "docName": "羽衣电竞陪玩制度.md",
  "index": 3,
  "heading": "## 一、炸单规则与价格",   // 所属小节
  "content": "| 项目 | 标准 |\n| --- | --- |\n| 炸单价格（机密/绝密） | 5 元 / 局 / 人 |",
  "charCount": 168,
  "isTable": true,       // 表格块：每个切片都重复携带表头
  "isMeta": false,       // 文档头来源/版本段：排序降权
  "vector": [0.01, ...]  // 仅启用向量时存在
}
```

### 3.2 检索测试（不经过大模型，调参必备）

```bash
curl -X POST http://127.0.0.1:8787/api/v1/retrieval \
  -H "X-Access-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"dataset_ids":["46b18d27..."],"question":"炸单扣多少钱","top_k":5,"threshold":0}'
```

```jsonc
{
  "code": 0,
  "data": {
    "question": "炸单扣多少钱",
    "total": 2,
    "chunks": [
      {
        "id": "...", "docId": "...", "docName": "羽衣电竞陪玩制度.md",
        "heading": "## 一、炸单规则与价格",
        "content": "| 项目 | 标准 |\n| 炸单价格（机密/绝密） | 5 元 / 局 / 人 |...",
        "similarity": 0.92,   // 0~1，用于阈值过滤
        "coverage": 1.0,      // 概念覆盖率（纯 BM25 时 similarity === coverage）
        "cosine": null,       // 启用向量后才有
        "bm25": 12.4834,      // BM25 原始分（只用于排序，无绝对量纲）
        "isTable": true, "isMeta": false
      }
    ],
    "stats": {
      "datasetCount": 1, "candidateCount": 6, "matchedCount": 2,
      "vectorUsed": false, "vectorError": "", "threshold": 0, "topK": 5
    }
  }
}
```

---

## 4. 聊天助手 / 会话

### 4.1 助手对象 `chat`（＝ 提示词 + 知识库 + 检索/生成参数）

```jsonc
{
  "id": "e0471c44...",
  "name": "羽衣电竞陪玩制度助手",
  "description": "陪玩师制度问答：等级分成、炸单价格、罚款标准、报备与客服",
  "prologue": "你好，我是羽衣电竞陪玩制度助手。等级升级、分成比例…都可以问我。",
  "systemPrompt": "你是「羽衣电竞陪玩制度助手」…",
  "datasetIds": ["46b18d27..."],
  "datasets": [{ "id": "46b18d27...", "name": "羽衣电竞陪玩制度" }],
  "datasetCount": 1,
  "topK": 6,                    // 送进大模型的片段数
  "similarityThreshold": 0.12,  // 相似度阈值（概念覆盖率 / 混合分）
  "hybridAlpha": 0.5,           // 1=纯关键词，0=纯向量（仅启用向量时生效）
  "temperature": 0.2,
  "maxTokens": 1024,
  "model": ""                   // 留空用服务端 LLM_MODEL
}
```

| 方法 | 路径 |
|---|---|
| GET / POST | `/api/v1/chats` |
| GET / PUT / DELETE | `/api/v1/chats/{id}`（DELETE → `{id, removedSessions}`） |
| GET / POST | `/api/v1/chats/{id}/sessions` |
| DELETE | `/api/v1/chats/{id}/sessions`，body `{ids:[...]}` → `{removed}` |
| GET | `/api/v1/chats/{id}/sessions/{sid}` |

### 4.2 会话对象 `session`

```jsonc
{
  "id": "9fa7691c...",
  "chatId": "e0471c44...",
  "name": "炸单扣多少钱",
  "messages": [
    { "role": "assistant", "content": "你好，我是…", "reference": null, "error": "", "createdAt": "..." },
    { "role": "user",      "content": "炸单扣多少钱", "reference": null, "createdAt": "..." },
    { "role": "assistant", "content": "炸单价格（机密/绝密）为 5 元 / 局 / 人…", "reference": { ... }, "createdAt": "..." }
  ],
  "messageCount": 3,
  "preview": "炸单扣多少钱",
  "lastQuestion": "炸单扣多少钱",
  "createdAt": "...", "updatedAt": "..."
}
```

> 新建会话自动写入一条 `assistant` 开场白（来自助手的 `prologue`）。

---

## 5. 问答接口（核心）

```http
POST /api/v1/chats/{chat_id}/completions
```

```jsonc
{
  "question": "炸单扣多少钱",     // 必填
  "session_id": "9fa7691c...",   // 选填；不传或失效会自动新建会话
  "stream": true                 // 选填，默认 true
}
```

### 5.1 流式（`stream: true`，默认）

`Content-Type: text/event-stream`，每帧一行 `data:` + JSON：

```
data:{"answer":"","reference":{...},"session_id":"9fa7691c...","stats":{...}}

data:{"answer":"炸单价格（机密/绝密）","reference":{...},"session_id":"9fa7691c..."}

data:{"answer":"炸单价格（机密/绝密）为 5 元 / 局 / 人…","reference":{...},"session_id":"9fa7691c..."}

data:{"answer":"炸单价格（机密/绝密）为 5 元 / 局 / 人…","reference":{...},"session_id":"9fa7691c...","final":true,"degraded":false,"error":""}

data:[DONE]

```

| 字段 | 说明 |
|---|---|
| `answer` | **累积全文**（不是增量片段），客户端直接替换气泡内容 |
| `reference` | 引用来源，首帧即下发（检索在生成前完成） |
| `session_id` | 会话 ID，首帧下发，便于续接多轮 |
| `stats` | 首帧携带检索统计 |
| `final` | 末帧标记 |
| `degraded` | true = 降级输出（服务端没配大模型，返回检索原文） |
| `error` | 非空表示生成被中断/失败 |

> 每 15 秒有 `: ping` 心跳帧，按 SSE 注释行忽略即可。

小程序侧已封装：`services/chat.js` 的 `ask()` 内部做增量 UTF-8 解码 + SSE 解析，对业务只暴露 `onDelta(累积文本)` / `onReference` / `onMeta` / `onEnd` / `onError`。

### 5.2 非流式（`stream: false`）

```jsonc
{
  "code": 0,
  "data": {
    "answer": "炸单价格（机密/绝密）为 5 元 / 局 / 人…",
    "reference": { ... },
    "session_id": "9fa7691c...",
    "degraded": false,
    "error": "",
    "stats": { ... }
  }
}
```

### 5.3 引用来源 `reference`（与 RAGFlow 同构）

```jsonc
{
  "total": 2,
  "chunks": [
    {
      "id": "...",
      "content_with_weight": "| 项目 | 标准 |\n| 炸单价格（机密/绝密） | 5 元 / 局 / 人 |",  // RAGFlow 同名字段
      "content": "同上（冗余，方便直读）",
      "document_id": "...",
      "document_name": "羽衣电竞陪玩制度.md",
      "dataset_id": "46b18d27...",
      "heading": "## 一、炸单规则与价格",   // 扩展：条款所在小节
      "similarity": 0.92,
      "similarity_text": "92.0%",
      "coverage": 1.0,                     // 扩展：概念覆盖率
      "bm25": 12.4834,                     // 扩展：BM25 原始分
      "cosine": null,                      // 扩展：向量余弦（启用时才有）
      "important_keywords": []
    }
  ],
  "doc_aggs": [ { "doc_id": "...", "doc_name": "羽衣电竞陪玩制度.md", "count": 2 } ]
}
```

### 5.4 问答完整链路

```
question
  → 检索（BM25 + 可选向量，Top-K = chat.topK，阈值 = chat.similarityThreshold）
  → 组装提示词（systemPrompt + 历史 + 【知识片段】+ 问题）
  → 大模型流式生成
  → 逐帧回推 { answer(累积), reference }
  → 落库到 session.messages（user + assistant 各一条）
```

---

## 6. 大模型接入层（第 ③ 层）

### 6.1 当前配置：DeepSeek（OpenAI 兼容协议）

```
POST https://api.deepseek.com/v1/chat/completions
Authorization: Bearer sk-***（写在 server/.env，已 gitignore）
Content-Type: application/json
```

引擎发出的请求体：

```json
{
  "model": "deepseek-chat",
  "messages": [
    { "role": "system",    "content": "你是「羽衣电竞陪玩制度助手」…" },
    { "role": "assistant", "content": "你好，我是…" },
    { "role": "user",      "content": "【知识片段】\n[1] …\n\n【用户问题】\n炸单扣多少钱" }
  ],
  "stream": true,
  "temperature": 0.2,
  "max_tokens": 1024
}
```

上游响应（SSE）：

```
data:{"choices":[{"delta":{"content":"炸单"},"finish_reason":null}]}

data:{"choices":[{"delta":{"content":"价格"},"finish_reason":null}]}

data:{"choices":[{"delta":{"content":""},"finish_reason":"stop"}]}

data:[DONE]
```

引擎只取 `choices[0].delta.content`（非流式时取 `choices[0].message.content`），其余字段忽略 —— 因此**任何 OpenAI 兼容服务都能直接替换**。

### 6.2 换成其它服务（只改 .env，不动代码）

| 服务 | LLM_BASE_URL | LLM_MODEL |
|---|---|---|
| **DeepSeek（当前）** | `https://api.deepseek.com/v1` | `deepseek-chat` |
| 硅基流动 | `https://api.siliconflow.cn/v1` | `deepseek-ai/DeepSeek-V3` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| 本地 Ollama | `http://127.0.0.1:11434/v1` | `qwen2.5:7b` |

改完**重启引擎**。单个助手想用不同模型：在助手配置的「指定模型」里填，留空则用服务端默认。

### 6.3 若换成非 OpenAI 协议（如私有网关 / 自定义协议）

只需重写 `server/llm.js` 里 `chatStream()` 的「发请求 + 解析响应」两步，保持下面这个内部契约不变，其余代码一行都不用动：

```js
/**
 * @param {object}   options.messages      [{role, content}]
 * @param {number}   options.temperature
 * @param {number}   options.maxTokens
 * @param {string}   options.model
 * @param {(text:string)=>void} options.onDelta  每来一段增量文本回调一次（只传增量）
 * @param {()=>void} options.onEnd
 * @param {(err:Error)=>void} options.onError
 * @returns {{abort: Function}}
 */
chatStream(options) → { abort() }
```

约定：
- `onDelta` 传**增量**（引擎内部负责累积成全文再推给前端）
- 上游报错且一个字都没生成时，走 `onError`；已生成一部分则走 `onEnd`（保留已有内容）
- 必须支持 `abort()`：前端点「停止」时调用

`server/rag/retrieve.js` 的 `embedTexts()` 是向量的同类适配点（内部契约：入 `string[]`，出 `number[][]`）。

### 6.4 向量接口（可选增强，当前未启用）

```
POST {EMBEDDING_BASE_URL}/embeddings
{ "model": "BAAI/bge-m3", "input": ["文本1", "文本2"], "encoding_format": "float" }
→ { "data": [ { "index": 0, "embedding": [0.01, ...] } ] }
```

调用失败会**自动降级为纯 BM25**，检索测试卡片上会显示「向量不可用（原因）」。

### 6.5 没配大模型时的行为（降级模式）

问答接口仍可用，返回 `degraded: true`，答案是「检索到的原文片段」直出，不带大模型润色 —— 这是**核对切片与检索质量**最方便的状态，不是报错。

---

## 7. 环境变量一览（`server/.env`）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` / `HOST` | `8787` / `0.0.0.0` | 监听地址（真机访问必须 `0.0.0.0`） |
| `ACCESS_TOKEN` | 空 | 非空则所有 `/api` 请求需带令牌 |
| `DATA_DIR` | `server/data` | 数据与上传原件目录 |
| `MAX_UPLOAD_MB` | `20` | 上传大小上限 |
| `LLM_BASE_URL` | `https://api.deepseek.com/v1` | 大模型地址 |
| `LLM_API_KEY` | 空 | **必填**，否则降级模式 |
| `LLM_MODEL` | `deepseek-chat` | 模型名 |
| `LLM_TEMPERATURE` | `0.3` | 温度（助手可覆盖，制度问答建议 0.1~0.3） |
| `LLM_MAX_TOKENS` | `1024` | 最大输出 |
| `LLM_TIMEOUT_MS` | `180000` | 超时（本地模型建议调大） |
| `EMBEDDING_BASE_URL` / `EMBEDDING_API_KEY` / `EMBEDDING_MODEL` | 空 | 向量增强，留空走 BM25 |
| `RETRIEVAL_TOP_K` / `RETRIEVAL_THRESHOLD` / `RETRIEVAL_ALPHA` | `5` / `0.15` / `0.5` | 检索默认参数（助手可覆盖） |
| `CHUNK_SIZE` / `CHUNK_OVERLAP` / `CHUNK_MIN_SIZE` | `500` / `80` / `60` | 切片默认参数（知识库可覆盖） |
| `SSL_KEY_PATH` / `SSL_CERT_PATH` | 空 | 配置后自动切换 HTTPS |
| `DEBUG` | `false` | 调试日志 |

---

## 8. 三个端点的最小可用示例

```bash
# 1) 引擎与大模型状态
curl http://127.0.0.1:8787/health

# 2) 检索（不花钱、不过大模型）
curl -X POST http://127.0.0.1:8787/api/v1/retrieval \
  -H "Content-Type: application/json" \
  -d '{"dataset_ids":["<KB_ID>"],"question":"炸单扣多少钱","top_k":5,"threshold":0}'

# 3) 问答（流式）
curl -N -X POST http://127.0.0.1:8787/api/v1/chats/<CHAT_ID>/completions \
  -H "Content-Type: application/json" \
  -d '{"question":"炸单扣多少钱","stream":true}'
```
