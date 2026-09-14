/**
 * kb.js - 知识库、文档与检索
 *
 *   GET    /api/v1/datasets                                    知识库列表
 *   POST   /api/v1/datasets                                    创建知识库
 *   GET    /api/v1/datasets/{id}                               详情（含文档数、切片数）
 *   PUT    /api/v1/datasets/{id}                               更新
 *   DELETE /api/v1/datasets/{id}                               删除（级联文档与切片）
 *   GET    /api/v1/datasets/{id}/documents                     文档列表
 *   POST   /api/v1/datasets/{id}/documents                     新增（文本或文件）
 *   DELETE /api/v1/datasets/{id}/documents/{docId}             删除文档
 *   POST   /api/v1/datasets/{id}/documents/{docId}/reparse     重新解析
 *   GET    /api/v1/datasets/{id}/documents/{docId}/chunks      某文档的切片
 *   GET    /api/v1/datasets/{id}/chunks                        全部切片
 *   POST   /api/v1/retrieval                                   检索测试
 */

const config = require('../utils/config');
const { requestJSON, normalizeError } = require('../utils/request');

function toArray(data) {
  if (Array.isArray(data)) {
    return data;
  }
  if (data && Array.isArray(data.items)) {
    return data.items;
  }
  return [];
}

function normalizeDataset(raw) {
  return {
    id: raw.id || '',
    name: raw.name || '未命名知识库',
    description: raw.description || '',
    chunkSize: raw.chunkSize || 500,
    chunkOverlap: raw.chunkOverlap || 80,
    embeddingModel: raw.embeddingModel || '',
    docCount: raw.docCount || 0,
    parsedDocCount: raw.parsedDocCount || 0,
    parsingDocCount: raw.parsingDocCount || 0,
    failedDocCount: raw.failedDocCount || 0,
    chunkCount: raw.chunkCount || 0,
    charCount: raw.charCount || 0,
    createdAt: raw.createdAt || '',
  };
}

const STATUS_TEXT = {
  parsing: '解析中',
  parsed: '已解析',
  failed: '解析失败',
  pending: '等待解析',
};

function normalizeDocument(raw) {
  const status = raw.status || 'pending';
  const progress = typeof raw.progress === 'number' ? raw.progress : 0;
  return {
    id: raw.id || '',
    datasetId: raw.datasetId || '',
    name: raw.name || '未命名文档',
    sourceType: raw.sourceType || 'text',
    size: raw.size || 0,
    status,
    statusText: STATUS_TEXT[status] || status,
    progress,
    progressPercent: Math.round(progress * 100),
    progressMsg: raw.progressMsg || '',
    chunkCount: raw.chunkCount || 0,
    charCount: raw.charCount || 0,
    parser: raw.parser || '',
    warning: raw.warning || '',
    error: raw.error || '',
    createdAt: raw.createdAt || '',
    parsedAt: raw.parsedAt || '',
    /** 列表页展示用的大小文案 */
    sizeText:
      raw.size > 1024 * 1024
        ? `${(raw.size / 1024 / 1024).toFixed(2)} MB`
        : `${Math.max(1, Math.round((raw.size || 0) / 1024))} KB`,
  };
}

/* ============================================================
 * 知识库
 * ============================================================ */

function listDatasets() {
  const { url, header } = config.resolve('datasets');
  return requestJSON({ url, header, timeout: 20000 }).then((data) =>
    toArray(data).map(normalizeDataset).filter((item) => item.id)
  );
}

function getDataset(id) {
  const { url, header } = config.resolve(`datasets/${id}`);
  return requestJSON({ url, header, timeout: 20000 }).then(normalizeDataset);
}

function createDataset(payload) {
  const { url, header } = config.resolve('datasets');
  return requestJSON({ url, header, method: 'POST', data: payload, timeout: 20000 }).then(normalizeDataset);
}

function updateDataset(id, patch) {
  const { url, header } = config.resolve(`datasets/${id}`);
  return requestJSON({ url, header, method: 'PUT', data: patch, timeout: 20000 }).then(normalizeDataset);
}

function deleteDataset(id) {
  const { url, header } = config.resolve(`datasets/${id}`);
  return requestJSON({ url, header, method: 'DELETE', timeout: 30000 });
}

/* ============================================================
 * 文档
 * ============================================================ */

function listDocuments(datasetId) {
  const { url, header } = config.resolve(`datasets/${datasetId}/documents`);
  return requestJSON({ url, header, timeout: 20000 }).then((data) =>
    toArray(data).map(normalizeDocument).filter((item) => item.id)
  );
}

/** 用纯文本新建文档（最可靠、也最常用：资料直接粘贴） */
function createDocFromText(datasetId, name, text) {
  const { url, header } = config.resolve(`datasets/${datasetId}/documents`);
  return requestJSON({
    url,
    header,
    method: 'POST',
    data: { name, text },
    timeout: 60000,
  }).then(normalizeDocument);
}

/**
 * 上传文件新建文档（wx.uploadFile）
 *
 * 注意：wx.uploadFile 不受 wx.request 的域名白名单限制之外的额外约束，
 * 但仍需保证地址可访问；解析在服务端异步进行，因此这里很快返回。
 * @param {(percent: number) => void} [onProgress]
 */
function uploadDocument(datasetId, filePath, name, onProgress) {
  const cfg = config.load();

  // 云托管模式下 wx.uploadFile 走不通（它不经过 callContainer 内网隧道，
  // 也没有可配置的 uploadFile 合法域名）——直接给出可执行的指引，避免原生报错。
  if (cfg.mode === 'cloud') {
    return Promise.reject(
      normalizeError({
        code: 400,
        message:
          '云托管模式不支持在小程序内上传文件。请在项目仓库更新 server/knowledge 下的文档，推送后在云托管控制台「发布」新版本，系统会自动重建知识库。',
      })
    );
  }

  let endpoint;
  try {
    endpoint = config.resolve(`datasets/${datasetId}/documents`);
  } catch (err) {
    return Promise.reject(normalizeError(err));
  }

  return new Promise((resolve, reject) => {
    const task = wx.uploadFile({
      url: endpoint.url,
      filePath,
      name: 'file',
      header: endpoint.header,
      formData: name ? { name } : {},
      timeout: 120000,
      success: (res) => {
        let body = null;
        try {
          body = JSON.parse(res.data);
        } catch (err) {
          reject(normalizeError({ code: -1, message: `上传返回异常（HTTP ${res.statusCode}）` }));
          return;
        }
        if (body && body.code === 0) {
          resolve(normalizeDocument(body.data));
          return;
        }
        reject(normalizeError({ code: (body && body.code) || -1, message: (body && body.message) || '上传失败' }));
      },
      fail: (err) => reject(normalizeError({ code: -1, message: (err && err.errMsg) || '上传失败' })),
    });

    if (onProgress && task && task.onProgressUpdate) {
      task.onProgressUpdate((res) => onProgress(res.progress));
    }
  });
}

function deleteDocument(datasetId, docId) {
  const { url, header } = config.resolve(`datasets/${datasetId}/documents/${docId}`);
  return requestJSON({ url, header, method: 'DELETE', timeout: 30000 });
}

function reparseDocument(datasetId, docId) {
  const { url, header } = config.resolve(
    `datasets/${datasetId}/documents/${docId}/reparse`
  );
  return requestJSON({ url, header, method: 'POST', timeout: 60000 }).then(normalizeDocument);
}

function listChunks(datasetId, options = {}) {
  const params = [];
  if (options.docId) {
    const { url, header } = config.resolve(
      `datasets/${datasetId}/documents/${options.docId}/chunks`
    );
    return requestJSON({ url, header, timeout: 20000 }).then((data) => ({
      total: (data && data.total) || toArray(data).length,
      chunks: toArray(data.chunks || data),
    }));
  }
  params.push(`offset=${options.offset || 0}`);
  params.push(`limit=${options.limit || 50}`);
  if (options.keyword) {
    params.push(`keyword=${encodeURIComponent(options.keyword)}`);
  }
  const { url, header } = config.resolve(`datasets/${datasetId}/chunks?${params.join('&')}`);
  return requestJSON({ url, header, timeout: 20000 }).then((data) => ({
    total: (data && data.total) || 0,
    chunks: (data && data.chunks) || [],
  }));
}

/* ============================================================
 * 检索测试
 * ============================================================ */

function testRetrieval(payload) {
  const { url, header } = config.resolve('retrieval');
  return requestJSON({
    url,
    header,
    method: 'POST',
    data: {
      dataset_ids: payload.datasetIds || [],
      question: payload.question,
      top_k: payload.topK || 5,
      threshold: typeof payload.threshold === 'number' ? payload.threshold : 0,
      alpha: typeof payload.alpha === 'number' ? payload.alpha : undefined,
    },
    timeout: 60000,
  });
}

module.exports = {
  listDatasets,
  getDataset,
  createDataset,
  updateDataset,
  deleteDataset,
  listDocuments,
  createDocFromText,
  uploadDocument,
  deleteDocument,
  reparseDocument,
  listChunks,
  testRetrieval,
  normalizeDataset,
  normalizeDocument,
  STATUS_TEXT,
};
