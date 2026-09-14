/**
 * store.js - 轻量持久化（JSON 文件 + 内存缓存）
 *
 * 选择 JSON 文件而不是数据库的理由：
 *   单机单用户的本地知识库场景，切片量在几千级别，JSON 全量读写完全够用，
 *   且零依赖、可直接打开看数据、便于迁移。
 * 写入采用「临时文件 + rename」保证原子性，避免进程中断写出半截 JSON。
 *
 * 集合：
 *   datasets      知识库
 *   documents     文档
 *   chunks_<kb>   切片（按知识库分文件，避免单文件过大）
 *   chats         聊天助手
 *   sessions      会话
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const cache = new Map();

const COLLECTIONS = ['datasets', 'documents', 'chats', 'sessions'];

/** 32 位十六进制 ID，与 RAGFlow 的 ID 形态保持一致 */
function newId() {
  return crypto.randomBytes(16).toString('hex');
}

function now() {
  return new Date().toISOString();
}

function ensureDir() {
  if (!fs.existsSync(config.dataDir)) {
    fs.mkdirSync(config.dataDir, { recursive: true });
  }
}

function fileOf(name) {
  return path.join(config.dataDir, `${name}.json`);
}

function load(name) {
  if (cache.has(name)) {
    return cache.get(name);
  }
  ensureDir();
  const file = fileOf(name);
  let data = [];
  if (fs.existsSync(file)) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      if (text.trim()) {
        data = JSON.parse(text);
      }
    } catch (err) {
      console.error(`[store] ${name}.json 解析失败，已重置为空：`, err.message);
      data = [];
    }
  }
  if (!Array.isArray(data)) {
    data = [];
  }
  cache.set(name, data);
  return data;
}

function flush(name) {
  const data = cache.get(name) || [];
  ensureDir();
  const file = fileOf(name);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, file);
  return data;
}

/* ============================================================
 * CRUD
 * ============================================================ */

function all(name) {
  return load(name).map((item) => ({ ...item }));
}

function find(name, predicate) {
  return load(name).filter(predicate).map((item) => ({ ...item }));
}

function get(name, id) {
  const found = load(name).find((item) => item.id === id);
  return found ? { ...found } : null;
}

function insert(name, doc) {
  const list = load(name);
  const record = { id: doc.id || newId(), createdAt: now(), updatedAt: now(), ...doc };
  list.push(record);
  flush(name);
  return { ...record };
}

function update(name, id, patch) {
  const list = load(name);
  const index = list.findIndex((item) => item.id === id);
  if (index < 0) {
    return null;
  }
  list[index] = { ...list[index], ...patch, id, updatedAt: now() };
  flush(name);
  return { ...list[index] };
}

function remove(name, id) {
  const list = load(name);
  const index = list.findIndex((item) => item.id === id);
  if (index < 0) {
    return false;
  }
  list.splice(index, 1);
  flush(name);
  return true;
}

/** 批量删除，返回删除条数 */
function removeWhere(name, predicate) {
  const list = load(name);
  const kept = list.filter((item) => !predicate(item));
  const removed = list.length - kept.length;
  if (removed > 0) {
    cache.set(name, kept);
    flush(name);
  }
  return removed;
}

/* ============================================================
 * 切片（按知识库分文件）
 * ============================================================ */

/**
 * 切片版本号：任何切片写入都会 +1，检索索引据此判断是否需要重建。
 * 没有它就得在每次查询时对比全量切片，或者干脆每次重建索引。
 */
const chunkVersions = new Map();

function getChunkVersion(datasetId) {
  return chunkVersions.get(datasetId) || 0;
}

function bumpChunkVersion(datasetId) {
  const next = getChunkVersion(datasetId) + 1;
  chunkVersions.set(datasetId, next);
  return next;
}

function chunkCollection(datasetId) {
  return `chunks_${datasetId}`;
}

function readChunks(datasetId) {
  return all(chunkCollection(datasetId));
}

function getChunks(datasetId) {
  return load(chunkCollection(datasetId));
}

function writeChunks(datasetId, chunks) {
  cache.set(chunkCollection(datasetId), chunks);
  flush(chunkCollection(datasetId));
  bumpChunkVersion(datasetId);
  return chunks;
}

function appendChunks(datasetId, chunks) {
  const list = load(chunkCollection(datasetId));
  chunks.forEach((chunk) => list.push(chunk));
  flush(chunkCollection(datasetId));
  bumpChunkVersion(datasetId);
  return chunks.length;
}

function removeChunksOfDoc(datasetId, docId) {
  const removed = removeWhere(chunkCollection(datasetId), (chunk) => chunk.docId === docId);
  if (removed > 0) {
    bumpChunkVersion(datasetId);
  }
  return removed;
}

function dropChunks(datasetId) {
  const name = chunkCollection(datasetId);
  cache.delete(name);
  const file = fileOf(name);
  if (fs.existsSync(file)) {
    try {
      fs.unlinkSync(file);
    } catch (err) {
      // 某些环境把 unlinkSync 劫持为「移到回收站」且可能失败；删不掉也不阻断逻辑
      console.warn(`[store] 删除 ${name}.json 失败（不影响运行）：${err.message}`);
    }
  }
  bumpChunkVersion(datasetId);
}

/* ============================================================
 * 启动时预热
 * ============================================================ */

function init() {
  ensureDir();
  COLLECTIONS.forEach((name) => load(name));
  // 清掉历史遗留的 .tmp
  try {
    fs.readdirSync(config.dataDir)
      .filter((name) => name.endsWith('.json.tmp'))
      .forEach((name) => fs.unlinkSync(path.join(config.dataDir, name)));
  } catch (err) {
    /* ignore */
  }
}

module.exports = {
  COLLECTIONS,
  newId,
  now,
  all,
  find,
  get,
  insert,
  update,
  remove,
  removeWhere,
  readChunks,
  getChunks,
  writeChunks,
  appendChunks,
  removeChunksOfDoc,
  dropChunks,
  chunkCollection,
  getChunkVersion,
  bumpChunkVersion,
  init,
};
