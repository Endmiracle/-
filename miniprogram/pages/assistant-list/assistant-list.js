const chatService = require('../../services/chat');
const config = require('../../utils/config');
const store = require('../../utils/store');
const util = require('../../utils/util');

Page({
  data: {
    list: [],
    currentId: '',
    loading: true,
    error: '',
  },

  onLoad() {
    this.unsubscribe = store.subscribe('chatRevision', () => this.load());
    this.load();
  },

  onShow() {
    this.setData({ currentId: config.load().chatId });
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
    return chatService
      .listChats()
      .then((list) => {
        this.loadedOnce = true;
        const currentId = config.load().chatId;
        // 首次进入且没有选中助手时，自动选第一个，避免用户还要多点一步
        if (!currentId && list.length) {
          this.selectChat(list[0], true);
        }
        this.setData({
          list,
          loading: false,
          error: '',
          currentId: config.load().chatId,
        });
      })
      .catch((err) => {
        this.setData({ loading: false, error: util.errorText(err) });
      });
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  selectChat(chat, silent) {
    if (!chat || !chat.id) {
      return;
    }
    const current = config.load();
    if (current.chatId === chat.id && current.chatName === chat.name && silent) {
      return;
    }
    config.save({ chatId: chat.id, chatName: chat.name });
    this.setData({ currentId: chat.id });
    store.touchConfig();
    if (!silent) {
      util.haptic('light');
      util.toast(`已切换为「${chat.name}」`);
    }
  },

  onSelect(e) {
    const id = e.currentTarget.dataset.id;
    const chat = this.data.list.find((item) => item.id === id);
    this.selectChat(chat, false);
  },

  onEdit(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/assistant-edit/assistant-edit?id=${id}` });
  },

  onCreate() {
    wx.navigateTo({ url: '/pages/assistant-edit/assistant-edit' });
  },

  onLongPress(e) {
    const id = e.currentTarget.dataset.id;
    const chat = this.data.list.find((item) => item.id === id);
    if (!chat) {
      return;
    }
    wx.showActionSheet({
      itemList: ['编辑配置', '删除助手'],
      success: (res) => {
        if (res.tapIndex === 0) {
          this.onEdit(e);
          return;
        }
        this.confirmDelete(chat);
      },
    });
  },

  confirmDelete(chat) {
    wx.showModal({
      title: '删除助手',
      content: `将删除「${chat.name}」及其全部会话记录，知识库本身不受影响。`,
      confirmText: '删除',
      confirmColor: '#d54941',
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        chatService
          .deleteChat(chat.id)
          .then(() => {
            if (config.load().chatId === chat.id) {
              config.save({ chatId: '', chatName: '' });
              store.touchConfig();
            }
            util.toast('已删除');
            this.load();
          })
          .catch((err) => util.toast(util.errorText(err)));
      },
    });
  },

  onGoKb() {
    wx.switchTab({ url: '/pages/kb-list/kb-list' });
  },

  onGoSettings() {
    wx.switchTab({ url: '/pages/settings/settings' });
  },
});
