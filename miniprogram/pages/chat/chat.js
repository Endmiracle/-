const chatService = require('../../services/chat');
const local = require('../../services/local');
const config = require('../../utils/config');
const store = require('../../utils/store');
const util = require('../../utils/util');
const { QUICK_QUESTIONS, BRAND } = require('../../utils/constants');

Page({
  data: {
    /** 消息列表：[{_id, role, content, streaming, error, references, refsExpanded, degraded, time, question}] */
    messages: [],
    input: '',
    sending: false,
    /** 云托管模式无法中断已发出的请求，此时隐藏「停止」按钮 */
    canStop: true,

    assistantName: BRAND.name,
    assistantMeta: '',
    /** 助手未就绪时的引导状态：'no-endpoint' | 'no-assistant' | '' */
    blockReason: '',
    blockText: '',

    quickQuestions: QUICK_QUESTIONS,
    welcome: BRAND.welcome,
    prologue: '',
    brandLogo: BRAND.logo,
    brandAvatar: BRAND.avatar,

    scrollTop: 0,
  },

  onLoad() {
    this.followBottom = true;
    this.autoScrollTop = 0;

    // 流式输出时每个分片都要滚动一次，节流避免频繁 setData
    this.scrollToBottom = util.throttle(() => {
      if (!this.followBottom) {
        return;
      }
      const next = this.data.scrollTop + 3000;
      this.autoScrollTop = next;
      this.setData({ scrollTop: next });
    }, 160);

    this.unsubscribeConfig = store.subscribe('configRevision', () => this.bootstrap(true));
    this.unsubscribeSession = store.subscribe('sessionRevision', () => this.resetLocal());

    this.restore();
    this.bootstrap(false);
    this.measureViewport();
  },

  onUnload() {
    if (this.unsubscribeConfig) {
      this.unsubscribeConfig();
    }
    if (this.unsubscribeSession) {
      this.unsubscribeSession();
    }
    if (this.scrollToBottom && this.scrollToBottom.cancel) {
      this.scrollToBottom.cancel();
    }
    this.stopGenerating();
    this.persist();
  },

  onShow() {
    // 「会话记录」页载入历史会话时会把状态写进本地缓存，这里接管
    const state = local.loadState();
    if (state.sessionId && state.sessionId !== this.sessionId) {
      this.sessionId = state.sessionId;
      this.setData({ messages: this.decorate(state.messages), scrollTop: 0 });
      this.followBottom = true;
    }
    // 从助手/设置页返回时刷新一次，保证名称与就绪状态是最新的
    this.bootstrap(false);
  },

  measureViewport() {
    const query = wx.createSelectorQuery();
    query
      .select('.msg-scroll')
      .boundingClientRect((rect) => {
        if (rect) {
          this.viewHeight = rect.height;
        }
      })
      .exec();
  },

  /* ============================================================
   * 会话状态
   * ============================================================ */

  restore() {
    const state = local.loadState();
    this.setData({ messages: this.decorate(state.messages) });
    this.sessionId = state.sessionId || '';
  },

  /** 把持久化/服务端消息装饰成视图模型；流式标记一律重置 */
  decorate(messages) {
    return (messages || [])
      .filter((item) => item && item.content && (item.role === 'user' || item.role === 'assistant'))
      .map((item) =>
        Object.assign({}, item, {
          _id: item._id || util.genId('m'),
          streaming: false,
          error: item.error || '',
          refsExpanded: false,
          time: item.time || util.formatDate(item.createdAt, 'HH:mm'),
        })
      );
  },

  persist() {
    const messages = this.data.messages.map((item) =>
      Object.assign({}, item, { streaming: false, refsExpanded: false })
    );
    local.saveState(this.sessionId, messages);
  },

  resetLocal() {
    this.sessionId = '';
    local.clear();
    this.setData({ messages: [] });
  },

  /** 读取配置并判断当前是否可用 */
  bootstrap(forceReset) {
    const cfg = config.load();
    const patch = {
      assistantName: cfg.chatName || BRAND.name,
      assistantMeta: config.describeEndpoint(),
      canStop: cfg.mode !== 'cloud',
    };

    if (!cfg.chatId) {
      patch.blockReason = 'no-assistant';
      patch.blockText = '还没有选择助手。到「助手」页新建或选中一个助手后即可开始问答。';
      this.setData(patch);
      return;
    }

    patch.blockReason = '';
    patch.blockText = '';

    if (forceReset || this.loadedChatId !== cfg.chatId) {
      this.loadedChatId = cfg.chatId;
      // 换了助手：当前会话不再适用
      this.resetLocal();
      patch.messages = [];
    }

    this.setData(patch);

    chatService
      .listChats()
      .then((chats) => {
        const current = chats.find((item) => item.id === cfg.chatId);
        if (!current) {
          this.setData({
            blockReason: 'no-assistant',
            blockText: '当前选中的助手在服务端已不存在，请到「助手」页重新选择。',
          });
          return;
        }
        this.currentChat = current;
        this.setData({
          assistantName: current.name,
          prologue: current.prologue || '',
          assistantMeta:
            current.datasetCount > 0
              ? `已连接 ${current.datasetCount} 个知识库 · Top ${current.topK}`
              : '尚未绑定知识库，回答可能为空',
        });
      })
      .catch((err) => {
        this.setData({
          blockReason: 'no-endpoint',
          blockText: `${util.errorText(err)}。请到「设置」页检查服务地址与访问令牌。`,
        });
      });
  },

  /* ============================================================
   * 输入
   * ============================================================ */

  onInput(e) {
    this.setData({ input: e.detail.value });
  },

  onFocus() {
    this.followBottom = true;
    this.scrollToBottom();
  },

  onQuickTap(e) {
    const question = e.currentTarget.dataset.question;
    if (!question) {
      return;
    }
    this.setData({ input: question }, () => this.onSend());
  },

  onScroll(e) {
    const detail = e.detail || {};
    const viewHeight = this.viewHeight || 400;
    const bottomGap = (detail.scrollHeight || 0) - ((detail.scrollTop || 0) + viewHeight);
    this.followBottom = bottomGap < 80;
  },

  /* ============================================================
   * 发送与流式接收
   * ============================================================ */

  onSend() {
    if (this.data.sending) {
      util.toast('正在回答中，请稍候');
      return;
    }
    const question = String(this.data.input || '').trim();
    if (!question) {
      util.toast('请输入问题');
      return;
    }
    if (this.data.blockReason) {
      util.toast(this.data.blockText.slice(0, 20));
      return;
    }
    this.sendQuestion(question);
  },

  sendQuestion(question) {
    const userMessage = {
      _id: util.genId('m'),
      role: 'user',
      content: question,
      time: util.formatDate(Date.now(), 'HH:mm'),
    };
    const assistantMessage = {
      _id: util.genId('m'),
      role: 'assistant',
      content: '',
      streaming: true,
      error: '',
      references: null,
      refsExpanded: false,
      time: util.formatDate(Date.now(), 'HH:mm'),
      question,
    };

    const messages = this.data.messages.concat([userMessage, assistantMessage]);
    const assistantIndex = messages.length - 1;

    this.followBottom = true;
    this.setData({ messages, input: '', sending: true });
    this.scrollToBottom();
    util.haptic('light');

    this.currentTask = chatService.ask({
      question,
      sessionId: this.sessionId || undefined,

      onMeta: (meta) => {
        if (meta.sessionId && meta.sessionId !== this.sessionId) {
          this.sessionId = meta.sessionId;
        }
        if (meta.degraded) {
          this.patchMessage(assistantIndex, { degraded: true });
        }
      },

      onReference: (reference) => {
        this.patchMessage(assistantIndex, { references: reference });
      },

      onDelta: (text) => {
        this.patchMessage(assistantIndex, { content: text });
      },

      onEnd: (finalText) => {
        this.patchMessage(assistantIndex, {
          content: finalText || this.data.messages[assistantIndex].content,
          streaming: false,
        });
        this.setData({ sending: false });
        this.currentTask = null;
        this.persist();
      },

      onError: (err) => {
        const message = util.errorText(err);
        const hasContent = !!(this.data.messages[assistantIndex] || {}).content;
        this.patchMessage(assistantIndex, {
          streaming: false,
          error: message,
          content: hasContent ? this.data.messages[assistantIndex].content : '',
        });
        this.setData({ sending: false });
        this.currentTask = null;
        this.persist();
        if (!hasContent) {
          util.haptic('medium');
        }
      },
    });
  },

  /** 只更新指定消息的字段，避免整表重渲染 */
  patchMessage(index, patch) {
    const updates = {};
    Object.keys(patch).forEach((key) => {
      updates[`messages[${index}].${key}`] = patch[key];
    });
    this.setData(updates, () => this.scrollToBottom());
  },

  stopGenerating() {
    if (this.currentTask) {
      this.currentTask.abort();
      this.currentTask = null;
    }
    if (this.data.sending) {
      const messages = this.data.messages.slice();
      const last = messages.length - 1;
      if (last >= 0) {
        messages[last] = Object.assign({}, messages[last], {
          streaming: false,
          error: messages[last].content ? '' : '已停止生成',
        });
      }
      this.setData({ messages, sending: false });
      this.persist();
    }
  },

  onStop() {
    this.stopGenerating();
    util.toast('已停止');
  },

  /* ============================================================
   * 消息操作
   * ============================================================ */

  onToggleRefs(e) {
    const id = e.detail.id;
    const messages = this.data.messages.slice();
    const index = messages.findIndex((item) => item._id === id);
    if (index < 0) {
      return;
    }
    messages[index] = Object.assign({}, messages[index], {
      refsExpanded: !messages[index].refsExpanded,
    });
    this.setData({ messages });
  },

  onCopy(e) {
    const item = e.detail.item || {};
    const text =
      item.role === 'user'
        ? item.content
        : [
            item.content,
            item.references && item.references.total
              ? `\n\n来源：${item.references.docs.map((doc) => doc.name).join('、')}`
              : '',
          ].join('');
    wx.setClipboardData({
      data: String(text || ''),
      success: () => util.toast('已复制'),
    });
  },

  onRetry(e) {
    const item = e.detail.item || {};
    const question = item.question || (this.data.messages.filter((m) => m.role === 'user').slice(-1)[0] || {}).content;
    if (!question) {
      util.toast('找不到对应的问题');
      return;
    }
    if (this.data.sending) {
      util.toast('正在回答中');
      return;
    }
    // 移除失败的这条回答，重新提问
    const messages = this.data.messages.filter((m) => m._id !== item._id);
    this.setData({ messages }, () => this.sendQuestion(question));
  },

  onReferenceTap(e) {
    const reference = e.detail.reference;
    if (!reference || !reference.content) {
      return;
    }
    wx.showModal({
      title: `${reference.docName}${reference.similarityText ? ` · ${reference.similarityText}` : ''}`,
      content: `${reference.heading ? `【${reference.heading}】\n` : ''}${reference.content}`,
      showCancel: false,
      confirmText: '关闭',
    });
  },

  onLongPress(e) {
    const item = e.detail.item || {};
    wx.showActionSheet({
      itemList: ['复制内容', item.references && item.references.total ? '查看引用来源' : '查看助手信息'],
      success: (res) => {
        if (res.tapIndex === 0) {
          this.onCopy({ detail: { item } });
          return;
        }
        if (item.references && item.references.total) {
          this.onToggleRefs({ detail: { id: item._id } });
        } else {
          wx.showModal({
            title: this.data.assistantName,
            content: this.data.assistantMeta,
            showCancel: false,
          });
        }
      },
    });
  },

  /* ============================================================
   * 会话切换
   * ============================================================ */

  onNewSession() {
    if (this.data.sending) {
      util.toast('正在回答中，请先停止');
      return;
    }
    wx.showModal({
      title: '开始新会话',
      content: '当前对话会被清空（服务端历史记录仍可在「会话记录」中查看）。',
      confirmText: '开始',
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        chatService
          .createSession()
          .then((session) => {
            this.sessionId = session.id || '';
            const messages = [];
            if (session.prologue) {
              messages.push({
                _id: util.genId('m'),
                role: 'assistant',
                content: session.prologue,
                streaming: false,
                error: '',
                references: null,
                refsExpanded: false,
                time: util.formatDate(Date.now(), 'HH:mm'),
              });
            }
            this.setData({ messages, scrollTop: 0 });
            this.persist();
            util.toast('已开始新会话');
          })
          .catch((err) => util.toast(util.errorText(err)));
      },
    });
  },

  onOpenHistory() {
    wx.navigateTo({ url: '/pages/history/history' });
  },

  onOpenAssistant() {
    wx.switchTab({ url: '/pages/assistant-list/assistant-list' });
  },

  onOpenSettings() {
    wx.switchTab({ url: '/pages/settings/settings' });
  },

  onShareAppMessage() {
    return {
      title: `${this.data.assistantName} · 基于知识库的智能问答`,
      path: '/pages/chat/chat',
    };
  },
});
