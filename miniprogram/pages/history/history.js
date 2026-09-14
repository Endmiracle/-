const chatService = require('../../services/chat');
const local = require('../../services/local');
const config = require('../../utils/config');
const util = require('../../utils/util');
const { normalizeReference } = require('../../utils/stream');

Page({
  data: {
    list: [],
    currentSessionId: '',
    loading: true,
    error: '',
    assistantName: '',
  },

  onLoad() {
    const state = local.loadState();
    this.setData({
      currentSessionId: state.sessionId || '',
      assistantName: config.load().chatName || '未选择助手',
    });
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  load() {
    this.setData({ loading: !this.loadedOnce });
    return chatService
      .listSessions()
      .then((list) => {
        this.loadedOnce = true;
        this.setData({
          list: list.map((item) =>
            Object.assign({}, item, {
              timeText: util.relativeTime(item.updatedAt),
            })
          ),
          loading: false,
          error: '',
        });
      })
      .catch((err) => {
        this.setData({ loading: false, error: util.errorText(err) });
      });
  },

  /** 打开历史会话：写入本地缓存后切回问答页，问答页 onShow 会自动接管 */
  onOpen(e) {
    const id = e.currentTarget.dataset.id;
    const session = this.data.list.find((item) => item.id === id);
    if (!session) {
      return;
    }
    const messages = (session.messages || [])
      .filter((item) => item && item.content && (item.role === 'user' || item.role === 'assistant'))
      .map((item) => ({
        _id: util.genId('m'),
        role: item.role,
        content: item.content,
        streaming: false,
        error: item.error || '',
        references: item.reference ? normalizeReference(item.reference) : null,
        refsExpanded: false,
        time: util.formatDate(item.createdAt, 'HH:mm'),
      }));

    if (!messages.length) {
      util.toast('该会话暂无消息');
      return;
    }

    local.saveState(session.id, messages);
    util.toast('已载入会话');
    setTimeout(() => {
      wx.switchTab({ url: '/pages/chat/chat' });
    }, 400);
  },

  onLongPress(e) {
    const id = e.currentTarget.dataset.id;
    const session = this.data.list.find((item) => item.id === id);
    if (!session) {
      return;
    }
    wx.showModal({
      title: '删除会话',
      content: `删除「${session.name}」及其 ${session.messageCount} 条消息？`,
      confirmText: '删除',
      confirmColor: '#d54941',
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        chatService
          .deleteSessions(session.chatId || config.load().chatId, [session.id])
          .then(() => {
            if (this.data.currentSessionId === session.id) {
              local.clear();
              this.setData({ currentSessionId: '' });
            }
            util.toast('已删除');
            this.load();
          })
          .catch((err) => util.toast(util.errorText(err)));
      },
    });
  },

  onNewSession() {
    chatService
      .createSession()
      .then(() => {
        local.clear();
        util.toast('已创建新会话');
        setTimeout(() => wx.switchTab({ url: '/pages/chat/chat' }), 400);
      })
      .catch((err) => util.toast(util.errorText(err)));
  },

  onGoAssistant() {
    wx.switchTab({ url: '/pages/assistant-list/assistant-list' });
  },
});
