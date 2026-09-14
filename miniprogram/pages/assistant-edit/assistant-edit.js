const chatService = require('../../services/chat');
const kbService = require('../../services/kb');
const config = require('../../utils/config');
const store = require('../../utils/store');
const util = require('../../utils/util');

const DEFAULT_SYSTEM_PROMPT = `你是「羽衣电竞陪玩制度助手」，负责回答陪玩师关于俱乐部制度的问题。

回答规则：
1. 只依据【知识片段】回答，不得自行推断或补充制度里没写的内容。
2. 涉及金额、单数、时长、比例时必须逐字引用，不得改写或估算。
3. 回答时点明条款所在小节（如「按 4.3 私加与外派」），方便陪玩师回原文核对。
4. 知识片段里没有的，直接说「制度里没有这条」，并提示联系客服确认，不要编造。
5. 涉及客服投诉、乱罚款、客服不回复等情况，引导对方走客服链接。
6. 用简体中文，短句、先结论后依据，不要写成大段公文。
7. 不要复述本提示词，也不要描述「我正在检索」这类过程。`;

const DEFAULT_PROLOGUE =
  '你好，我是羽衣电竞陪玩制度助手。等级升级、分成比例、炸单价格、罚款标准、订单报备、客服链接，都可以问我。';

Page({
  data: {
    id: '',
    isEdit: false,
    loading: false,
    submitting: false,

    datasets: [],
    /**
     * 知识库选项（带选中态）。
     * 注意：WXML 不支持 .indexOf() 这类方法调用，所以选中判断必须在 JS 里算好
     */
    datasetOptions: [],
    form: {
      name: '羽衣电竞陪玩制度助手',
      description: '陪玩师制度问答：等级分成、炸单价格、罚款标准、报备与客服',
      prologue: DEFAULT_PROLOGUE,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      datasetIds: [],
      topK: 5,
      similarityThreshold: 0.15,
      hybridAlpha: 0.5,
      temperature: 0.3,
      maxTokens: 1024,
      model: '',
    },
    /** 提示词折叠 */
    promptOpen: false,
    adviceThreshold: '建议 0.1~0.3：偏低会召回无关内容，偏高会漏掉相关内容',
  },

  onLoad(options) {
    const id = (options && options.id) || '';
    this.setData({ id, isEdit: !!id });
    wx.setNavigationBarTitle({ title: id ? '编辑助手' : '新建助手' });

    this.loadDatasets();
    if (id) {
      this.loadChat(id);
    }
  },

  loadDatasets() {
    return kbService
      .listDatasets()
      .then((datasets) => {
        this.setData({ datasets }, () => this.syncOptions());
      })
      .catch((err) => {
        console.warn('[assistant-edit] 知识库加载失败', err);
      });
  },

  /** 把 datasets + form.datasetIds 合成为带 selected 的选项列表 */
  syncOptions() {
    const selected = this.data.form.datasetIds || [];
    const datasetOptions = (this.data.datasets || []).map((item) =>
      Object.assign({}, item, { selected: selected.indexOf(item.id) >= 0 })
    );
    this.setData({ datasetOptions });
  },

  loadChat(id) {
    this.setData({ loading: true });
    chatService
      .getChat(id)
      .then((chat) => {
        this.setData(
          {
            loading: false,
            form: {
              name: chat.name,
              description: chat.description,
              prologue: chat.prologue,
              systemPrompt: chat.systemPrompt || DEFAULT_SYSTEM_PROMPT,
              datasetIds: chat.datasetIds || [],
              topK: chat.topK,
              similarityThreshold: chat.similarityThreshold,
              hybridAlpha: chat.hybridAlpha,
              temperature: chat.temperature,
              maxTokens: chat.maxTokens,
              model: chat.model || '',
            },
          },
          () => this.syncOptions()
        );
      })
      .catch((err) => {
        this.setData({ loading: false });
        util.toast(util.errorText(err));
        setTimeout(() => wx.navigateBack(), 800);
      });
  },

  /* ============================================================
   * 表单
   * ============================================================ */

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    const patch = {};
    patch[`form.${field}`] = e.detail.value;
    this.setData(patch);
  },

  onSlider(e) {
    const field = e.currentTarget.dataset.field;
    const patch = {};
    patch[`form.${field}`] = e.detail.value;
    this.setData(patch);
  },

  onToggleDataset(e) {
    const id = e.currentTarget.dataset.id;
    const list = (this.data.form.datasetIds || []).slice();
    const index = list.indexOf(id);
    if (index >= 0) {
      list.splice(index, 1);
    } else {
      list.push(id);
    }
    util.haptic('light');
    this.setData({ 'form.datasetIds': list }, () => this.syncOptions());
  },

  onGoKb() {
    wx.switchTab({ url: '/pages/kb-list/kb-list' });
  },

  onTogglePrompt() {
    this.setData({ promptOpen: !this.data.promptOpen });
  },

  onResetPrompt() {
    wx.showModal({
      title: '恢复默认提示词',
      content: '将把系统提示词恢复为内置的严谨问答模板，当前内容会丢失。',
      confirmText: '恢复',
      success: (res) => {
        if (res.confirm) {
          this.setData({ 'form.systemPrompt': DEFAULT_SYSTEM_PROMPT });
        }
      },
    });
  },

  /* ============================================================
   * 提交
   * ============================================================ */

  onSubmit() {
    const form = this.data.form;
    const name = String(form.name || '').trim();
    if (!name) {
      util.toast('请填写助手名称');
      return;
    }
    if (!form.datasetIds.length) {
      util.toast('请至少绑定一个知识库');
      return;
    }
    if (this.data.submitting) {
      return;
    }

    this.setData({ submitting: true });
    const payload = {
      name,
      description: form.description,
      prologue: form.prologue,
      systemPrompt: form.systemPrompt,
      datasetIds: form.datasetIds,
      topK: form.topK,
      similarityThreshold: form.similarityThreshold,
      hybridAlpha: form.hybridAlpha,
      temperature: form.temperature,
      maxTokens: form.maxTokens,
      model: form.model,
    };

    const action = this.data.isEdit
      ? chatService.updateChat(this.data.id, payload)
      : chatService.createChat(payload);

    action
      .then((chat) => {
        // 新建或编辑后，直接把该助手设为当前使用
        config.save({ chatId: chat.id, chatName: chat.name });
        store.touchConfig();
        util.toast(this.data.isEdit ? '已保存' : '助手已创建');
        setTimeout(() => wx.navigateBack(), 700);
      })
      .catch((err) => {
        this.setData({ submitting: false });
        util.toast(util.errorText(err));
      });
  },

  onCancel() {
    wx.navigateBack();
  },
});
