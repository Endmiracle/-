Component({
  options: {
    addGlobalClass: true,
  },

  properties: {
    /** 消息对象 */
    item: {
      type: Object,
      value: null,
    },
    /** 助手头像图片地址（本地资源或网络地址） */
    avatarSrc: {
      type: String,
      value: '',
    },
    /** 图片不可用时的兜底文字 */
    avatarText: {
      type: String,
      value: '羽',
    },
  },

  methods: {
    onToggleRefs() {
      this.triggerEvent('togglerefs', { id: this.data.item && this.data.item._id });
    },

    onCopy() {
      this.triggerEvent('copy', { item: this.data.item });
    },

    onRetry() {
      this.triggerEvent('retry', { item: this.data.item });
    },

    onReferenceTap(e) {
      this.triggerEvent('referencetap', {
        index: e.currentTarget.dataset.index,
        reference: this.data.item && this.data.item.references
          ? this.data.item.references.items[e.currentTarget.dataset.index]
          : null,
      });
    },

    onLongPress() {
      this.triggerEvent('longpress', { item: this.data.item });
    },
  },
});
