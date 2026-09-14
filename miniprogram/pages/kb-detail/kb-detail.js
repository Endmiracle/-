const kbService = require('../../services/kb');
const store = require('../../utils/store');
const util = require('../../utils/util');
const config = require('../../utils/config');

const ACCEPT_EXT = ['txt', 'md', 'docx', 'pdf', 'csv', 'json', 'html'];

Page({
  data: {
    id: '',
    dataset: null,
    documents: [],
    loading: true,
    error: '',

    /** 新增文档的两种方式：粘贴文本 / 上传文件 */
    addMode: 'text',
    textForm: { name: '', content: '' },
    submitting: false,
    uploading: false,
    uploadPercent: 0,
    uploadName: '',

    /** 检索测试 */
    testQuestion: '',
    testing: false,
    testResult: null,

    /** 切片预览 */
    panelOpen: false,
    panelTitle: '',
    panelLoading: false,
    panelChunks: [],

    hasParsing: false,
    acceptExt: ACCEPT_EXT,

    /** 云托管模式下不支持在小程序内上传文件（wx.uploadFile 不走内网隧道） */
    isCloud: false,
  },

  onLoad(options) {
    const id = (options && options.id) || '';
    if (!id) {
      this.setData({ loading: false, error: '缺少知识库参数' });
      return;
    }
    this.setData({ id, isCloud: config.load().mode === 'cloud' });
    this.loadAll();

    // 解析是服务端异步进行的，这里轮询进度
    this.timer = setInterval(() => {
      if (this.data.hasParsing && !this.data.loading) {
        this.loadDocuments();
      }
    }, 2000);
  },

  onUnload() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  },

  onPullDownRefresh() {
    this.loadAll().then(() => wx.stopPullDownRefresh());
  },

  loadAll() {
    return Promise.all([this.loadDataset(), this.loadDocuments()]);
  },

  loadDataset() {
    return kbService
      .getDataset(this.data.id)
      .then((dataset) => {
        this.setData({ dataset, error: '' });
        wx.setNavigationBarTitle({ title: dataset.name });
      })
      .catch((err) => {
        this.setData({ error: util.errorText(err), loading: false });
      });
  },

  loadDocuments() {
    return kbService
      .listDocuments(this.data.id)
      .then((documents) => {
        this.setData({
          documents,
          loading: false,
          error: '',
          hasParsing: documents.some((doc) => doc.status === 'parsing'),
        });
      })
      .catch((err) => {
        this.setData({ loading: false, error: util.errorText(err) });
      });
  },

  /* ============================================================
   * 新增文档
   * ============================================================ */

  onSwitchMode(e) {
    this.setData({ addMode: e.currentTarget.dataset.mode });
  },

  onTextInput(e) {
    const field = e.currentTarget.dataset.field;
    const patch = {};
    patch[`textForm.${field}`] = e.detail.value;
    this.setData(patch);
  },

  onSubmitText() {
    const name = String(this.data.textForm.name || '').trim() || `粘贴文本 ${util.formatDate(Date.now(), 'MM-DD HH:mm')}`;
    const content = String(this.data.textForm.content || '').trim();
    if (content.length < 10) {
      util.toast('内容太短，至少 10 个字');
      return;
    }
    if (this.data.submitting) {
      return;
    }
    this.setData({ submitting: true });
    kbService
      .createDocFromText(this.data.id, name, content)
      .then(() => {
        util.toast('已提交，正在解析');
        this.setData({
          submitting: false,
          textForm: { name: '', content: '' },
          addMode: 'text',
        });
        return this.loadAll();
      })
      .catch((err) => {
        this.setData({ submitting: false });
        util.toast(util.errorText(err));
      });
  },

  onChooseFile() {
    if (this.data.isCloud || config.load().mode === 'cloud') {
      wx.showModal({
        title: '云托管模式',
        content:
          '云托管模式不支持在小程序内上传文件。请在项目仓库更新 server/knowledge 下的文档，推送后在云托管控制台「发布」新版本，系统会自动重建知识库。',
        showCancel: false,
        confirmText: '知道了',
      });
      return;
    }
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ACCEPT_EXT,
      success: (res) => {
        const file = (res.tempFiles || [])[0];
        if (!file) {
          return;
        }
        this.doUpload(file.path, file.name, file.size);
      },
      fail: (err) => {
        if (String((err && err.errMsg) || '').indexOf('cancel') < 0) {
          util.toast('选择文件失败');
        }
      },
    });
  },

  doUpload(filePath, name, size) {
    this.setData({ uploading: true, uploadPercent: 0, uploadName: name || '文件' });
    kbService
      .uploadDocument(this.data.id, filePath, name, (percent) => {
        this.setData({ uploadPercent: percent });
      })
      .then(() => {
        this.setData({ uploading: false, uploadName: '' });
        util.toast('已上传，正在解析');
        return this.loadAll();
      })
      .catch((err) => {
        this.setData({ uploading: false, uploadName: '' });
        util.toast(util.errorText(err));
      });
  },

  /* ============================================================
   * 文档操作
   * ============================================================ */

  onDocTap(e) {
    const docId = e.currentTarget.dataset.id;
    const doc = this.data.documents.find((item) => item.id === docId);
    if (!doc) {
      return;
    }
    if (doc.status === 'failed') {
      wx.showModal({
        title: '解析失败',
        content: doc.error || '未知原因',
        confirmText: '重试',
        success: (res) => {
          if (res.confirm) {
            this.onReparse(e);
          }
        },
      });
      return;
    }
    this.openChunks(doc);
  },

  onDocLongPress(e) {
    const docId = e.currentTarget.dataset.id;
    const doc = this.data.documents.find((item) => item.id === docId);
    if (!doc) {
      return;
    }
    wx.showActionSheet({
      itemList: ['查看切片', '重新解析', '删除文档'],
      success: (res) => {
        if (res.tapIndex === 0) {
          this.openChunks(doc);
          return;
        }
        if (res.tapIndex === 1) {
          this.onReparse(e);
          return;
        }
        this.confirmDeleteDoc(doc);
      },
    });
  },

  onReparse(e) {
    const docId = e.currentTarget.dataset.id;
    kbService
      .reparseDocument(this.data.id, docId)
      .then(() => {
        util.toast('已重新提交解析');
        this.loadDocuments();
      })
      .catch((err) => util.toast(util.errorText(err)));
  },

  confirmDeleteDoc(doc) {
    wx.showModal({
      title: '删除文档',
      content: `删除「${doc.name}」及其 ${doc.chunkCount} 个切片？`,
      confirmText: '删除',
      confirmColor: '#d54941',
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        kbService
          .deleteDocument(this.data.id, doc.id)
          .then(() => {
            util.toast('已删除');
            this.loadAll();
          })
          .catch((err) => util.toast(util.errorText(err)));
      },
    });
  },

  openChunks(doc) {
    this.setData({
      panelOpen: true,
      panelTitle: `${doc.name} · ${doc.chunkCount} 个切片`,
      panelLoading: true,
      panelChunks: [],
    });
    kbService
      .listChunks(this.data.id, { docId: doc.id })
      .then((res) => {
        this.setData({ panelLoading: false, panelChunks: res.chunks || [] });
      })
      .catch((err) => {
        this.setData({ panelLoading: false });
        util.toast(util.errorText(err));
      });
  },

  onClosePanel() {
    this.setData({ panelOpen: false, panelChunks: [] });
  },

  /* ============================================================
   * 检索测试
   * ============================================================ */

  onTestInput(e) {
    this.setData({ testQuestion: e.detail.value });
  },

  onTest() {
    const question = String(this.data.testQuestion || '').trim();
    if (!question) {
      util.toast('请输入测试问题');
      return;
    }
    if (this.data.testing) {
      return;
    }
    this.setData({ testing: true });
    kbService
      .testRetrieval({ datasetIds: [this.data.id], question, topK: 5, threshold: 0 })
      .then((res) => {
        const chunks = (res.chunks || []).map((chunk) =>
          Object.assign({}, chunk, {
            similarityText:
              typeof chunk.similarity === 'number' ? `${(chunk.similarity * 100).toFixed(1)}%` : '—',
          })
        );
        this.setData({
          testing: false,
          testResult: { question, chunks, stats: res.stats, total: chunks.length },
        });
      })
      .catch((err) => {
        this.setData({ testing: false });
        util.toast(util.errorText(err));
      });
  },

  /* ============================================================
   * 编辑与删除知识库
   * ============================================================ */

  onEdit() {
    const dataset = this.data.dataset;
    if (!dataset) {
      return;
    }
    wx.showModal({
      title: '重命名知识库',
      editable: true,
      content: dataset.name,
      placeholderText: '输入新的名称',
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        const name = String(res.content || '').trim();
        if (!name) {
          util.toast('名称不能为空');
          return;
        }
        kbService
          .updateDataset(this.data.id, { name })
          .then(() => {
            util.toast('已保存');
            this.loadDataset();
          })
          .catch((err) => util.toast(util.errorText(err)));
      },
    });
  },

  onDeleteDataset() {
    const dataset = this.data.dataset;
    if (!dataset) {
      return;
    }
    wx.showModal({
      title: '删除知识库',
      content: `将删除「${dataset.name}」及其全部文档与切片，并从已绑定的助手中解绑。此操作不可撤销。`,
      confirmText: '删除',
      confirmColor: '#d54941',
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        kbService
          .deleteDataset(this.data.id)
          .then(() => {
            util.toast('已删除');
            store.set('kbRevision', Date.now());
            setTimeout(() => wx.navigateBack(), 600);
          })
          .catch((err) => util.toast(util.errorText(err)));
      },
    });
  },

  onCopyChunk(e) {
    const content = e.currentTarget.dataset.content;
    wx.setClipboardData({
      data: String(content || ''),
      success: () => util.toast('已复制片段'),
    });
  },
});
