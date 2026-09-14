const config = require('../../utils/config');
const chatService = require('../../services/chat');
const local = require('../../services/local');
const store = require('../../utils/store');
const util = require('../../utils/util');
const { CONNECTION_MODES } = require('../../utils/constants');

Page({
  data: {
    modes: CONNECTION_MODES,
    mode: 'proxy',
    form: {
      cloudEnv: '',
      cloudService: '',
      proxyBase: '',
      accessToken: '',
      ragflowBase: '',
      apiKey: '',
      stream: true,
      timeout: 90000,
      chatId: '',
      chatName: '',
    },
    tokenMasked: '',
    saving: false,
    testing: false,
    steps: [],
    showGuide: false,
    version: '1.0.0',
  },

  onLoad() {
    this.syncFromConfig();
  },

  onShow() {
    this.syncFromConfig();
  },

  syncFromConfig() {
    const cfg = config.load();
    this.setData({
      mode: cfg.mode,
      tokenMasked: util.maskSecret(cfg.mode === 'direct' ? cfg.apiKey : cfg.accessToken),
      form: {
        cloudEnv: cfg.cloudEnv || '',
        cloudService: cfg.cloudService || '',
        proxyBase: cfg.proxyBase,
        accessToken: cfg.accessToken,
        ragflowBase: cfg.ragflowBase,
        apiKey: cfg.apiKey,
        stream: cfg.stream,
        timeout: cfg.timeout,
        chatId: cfg.chatId,
        chatName: cfg.chatName,
      },
    });
  },

  /* ============================================================
   * 表单
   * ============================================================ */

  onSelectMode(e) {
    const mode = e.currentTarget.dataset.mode;
    if (mode === this.data.mode) {
      return;
    }
    this.setData({ mode });
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    const patch = {};
    patch[`form.${field}`] = e.detail.value;
    this.setData(patch);
  },

  onSwitchStream(e) {
    this.setData({ 'form.stream': e.detail.value });
  },

  onToggleGuide() {
    this.setData({ showGuide: !this.data.showGuide });
  },

  /** 超时值兜底：太小会把正常请求掐断 */
  normalizeTimeout(value) {
    const timeout = Number(value);
    return Number.isFinite(timeout) && timeout >= 10000 ? timeout : 90000;
  },

  /* ============================================================
   * 保存
   * ============================================================ */

  onSave() {
    const form = this.data.form;

    // 云托管模式：不需要地址与密钥，只要环境 ID 与服务名
    if (this.data.mode === 'cloud') {
      const env = String(form.cloudEnv || '').trim();
      const service = String(form.cloudService || '').trim();
      if (!env) {
        util.toast('请填写云托管环境 ID');
        return;
      }
      if (!service) {
        util.toast('请填写云托管服务名');
        return;
      }
      this.setData({ saving: true });
      try {
        config.save({
          mode: 'cloud',
          cloudEnv: env,
          cloudService: service,
          timeout: this.normalizeTimeout(form.timeout),
        });
        store.touchConfig();
        this.syncFromConfig();
        util.toast('已保存，请完全退出小程序再进');
      } catch (err) {
        util.toast(util.errorText(err));
      }
      this.setData({ saving: false });
      return;
    }

    const base = String(this.data.mode === 'direct' ? form.ragflowBase : form.proxyBase).trim();
    if (!base) {
      util.toast(this.data.mode === 'direct' ? '请填写 RAGFlow 地址' : '请填写服务地址');
      return;
    }
    if (!/^https?:\/\//i.test(base)) {
      util.toast('地址需要以 http:// 或 https:// 开头');
      return;
    }

    this.setData({ saving: true });
    try {
      config.save({
        mode: this.data.mode,
        proxyBase: config.trimSlash(form.proxyBase),
        accessToken: String(form.accessToken || '').trim(),
        ragflowBase: config.trimSlash(form.ragflowBase),
        apiKey: String(form.apiKey || '').trim(),
        stream: !!form.stream,
        timeout: this.normalizeTimeout(form.timeout),
      });
      store.touchConfig();
      this.syncFromConfig();
      util.toast('已保存');
    } catch (err) {
      util.toast(util.errorText(err));
    }
    this.setData({ saving: false });
  },

  onReset() {
    wx.showModal({
      title: '恢复默认配置',
      content: '将清空服务地址、访问令牌与已选助手，恢复为出厂默认值。',
      confirmText: '恢复',
      confirmColor: '#d54941',
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        config.reset();
        store.touchConfig();
        this.syncFromConfig();
        this.setData({ steps: [] });
        util.toast('已恢复默认');
      },
    });
  },

  /* ============================================================
   * 自检
   * ============================================================ */

  onTest() {
    if (this.data.testing) {
      return;
    }
    // 先用当前表单值保存一次，避免「改了没保存就自检」造成误判
    this.onSave();
    this.setData({ testing: true, steps: [] });

    chatService
      .diagnose()
      .then((steps) => {
        this.setData({ testing: false, steps });
        const failed = steps.filter((item) => !item.ok);
        util.toast(failed.length ? `有 ${failed.length} 项未通过` : '全部通过');
      })
      .catch((err) => {
        this.setData({ testing: false });
        util.toast(util.errorText(err));
      });
  },

  /* ============================================================
   * 数据管理
   * ============================================================ */

  onClearLocal() {
    wx.showModal({
      title: '清空本机对话',
      content: '只清除本机缓存的对话界面，服务端会话记录不受影响。',
      confirmText: '清空',
      confirmColor: '#d54941',
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        local.clear();
        store.touchSession();
        util.toast('已清空');
      },
    });
  },

  onGoAssistant() {
    wx.switchTab({ url: '/pages/assistant-list/assistant-list' });
  },

  onGoKb() {
    wx.switchTab({ url: '/pages/kb-list/kb-list' });
  },

  onAbout() {
    wx.showModal({
      title: '关于',
      content:
        `版本 ${this.data.version}\n` +
        '羽衣电竞 · 陪玩制度问答系统\n' +
        '前端：微信小程序（原生，深色电竞风）\n' +
        '后端：零依赖 Node RAG 引擎（表格感知切片 + 同义词概念检索 + 大模型流式生成）\n' +
        '知识：羽衣电竞陪玩师制度统一化 / 基本制度',
      showCancel: false,
      confirmText: '关闭',
    });
  },
});
