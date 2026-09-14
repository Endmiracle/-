const kbService = require('../../services/kb');
const store = require('../../utils/store');
const util = require('../../utils/util');

Page({
  data: {
    list: [],
    loading: true,
    error: '',
    showForm: false,
    form: { name: '', description: '' },
    submitting: false,
    /** 展开的统计说明 */
    totalChunks: 0,
    totalDocs: 0,
  },

  onLoad() {
    this.unsubscribe = store.subscribe('kbRevision', () => this.load());
    this.load();
  },

  onShow() {
    // 从详情页返回时刷新统计（解析进度会变）
    if (this.loadedOnce) {
      this.load();
    }
  },

  onUnload() {
    if (this.unsubscribe) {
      this.unsubscribe();
    }
  },

  load() {
    this.setData({ loading: !this.loadedOnce });
    return kbService
      .listDatasets()
      .then((list) => {
        this.loadedOnce = true;
        this.setData({
          list,
          loading: false,
          error: '',
          totalChunks: list.reduce((sum, item) => sum + item.chunkCount, 0),
          totalDocs: list.reduce((sum, item) => sum + item.docCount, 0),
        });
      })
      .catch((err) => {
        this.setData({
          loading: false,
          error: util.errorText(err),
        });
      });
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  /* ============================================================
   * 新建
   * ============================================================ */

  onToggleForm() {
    this.setData({
      showForm: !this.data.showForm,
      form: { name: '', description: '' },
    });
  },

  onFormInput(e) {
    const field = e.currentTarget.dataset.field;
    const patch = {};
    patch[`form.${field}`] = e.detail.value;
    this.setData(patch);
  },

  onSubmit() {
    const name = String(this.data.form.name || '').trim();
    if (!name) {
      util.toast('请填写知识库名称');
      return;
    }
    if (this.data.submitting) {
      return;
    }
    this.setData({ submitting: true });
    kbService
      .createDataset({ name, description: this.data.form.description })
      .then((dataset) => {
        util.toast('知识库已创建');
        this.setData({ showForm: false, form: { name: '', description: '' }, submitting: false });
        this.load();
        // 新建后直接进入，方便马上传文档
        setTimeout(() => {
          wx.navigateTo({ url: `/pages/kb-detail/kb-detail?id=${dataset.id}` });
        }, 400);
      })
      .catch((err) => {
        this.setData({ submitting: false });
        util.toast(util.errorText(err));
      });
  },

  /* ============================================================
   * 条目操作
   * ============================================================ */

  onOpen(e) {
    wx.navigateTo({ url: `/pages/kb-detail/kb-detail?id=${e.currentTarget.dataset.id}` });
  },

  onLongPress(e) {
    const id = e.currentTarget.dataset.id;
    const item = this.data.list.find((dataset) => dataset.id === id);
    if (!item) {
      return;
    }
    wx.showActionSheet({
      itemList: ['重命名', '删除知识库'],
      success: (res) => {
        if (res.tapIndex === 0) {
          this.rename(item);
          return;
        }
        this.confirmDelete(item);
      },
    });
  },

  rename(item) {
    wx.showModal({
      title: '重命名知识库',
      editable: true,
      content: item.name,
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
          .updateDataset(item.id, { name })
          .then(() => {
            util.toast('已保存');
            this.load();
          })
          .catch((err) => util.toast(util.errorText(err)));
      },
    });
  },

  confirmDelete(item) {
    wx.showModal({
      title: '删除知识库',
      content: `将删除「${item.name}」及其 ${item.docCount} 篇文档、${item.chunkCount} 个切片，且会从已绑定的助手中解绑。此操作不可撤销。`,
      confirmText: '删除',
      confirmColor: '#d54941',
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        kbService
          .deleteDataset(item.id)
          .then(() => {
            util.toast('已删除');
            this.load();
          })
          .catch((err) => util.toast(util.errorText(err)));
      },
    });
  },

  onGoSettings() {
    wx.switchTab({ url: '/pages/settings/settings' });
  },

  onShareAppMessage() {
    return { title: '羽衣电竞知识库', path: '/pages/chat/chat' };
  },
});
