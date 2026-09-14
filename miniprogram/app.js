const config = require('./utils/config');
const store = require('./utils/store');

App({
  globalData: {
    /** 运行时配置（连接模式、服务地址、助手 ID 等），任何页面改配置后走 config.save + store 广播 */
    config: null,
    windowInfo: null,
    safeAreaBottom: 0,
    /** 底部输入框需要避让的键盘/安全区高度 */
    inputBottom: 0,
  },

  onLaunch() {
    this.globalData.config = config.load();
    this.initCloud();
    this.initWindowInfo();
    store.set('config', this.globalData.config);
  },

  /**
   * 初始化云开发（云托管模式必需）。
   * wx.cloud.init 全局只能调一次，所以在设置页改了云环境 ID 之后，
   * 必须完全退出小程序再进（冷启动）才会生效 —— 这点已在设置页提示。
   */
  initCloud() {
    const cfg = this.globalData.config || {};
    if (cfg.mode !== 'cloud' || !cfg.cloudEnv) {
      return;
    }
    if (typeof wx === 'undefined' || !wx.cloud) {
      console.warn('[app] 当前环境不支持云开发，云托管模式不可用');
      return;
    }
    try {
      wx.cloud.init({ env: cfg.cloudEnv, traceUser: true });
      console.log('[app] 云开发已初始化，环境：', cfg.cloudEnv);
    } catch (err) {
      console.warn('[app] 云开发初始化失败：', err);
    }
  },

  initWindowInfo() {
    try {
      const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      const device = wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync();
      this.globalData.windowInfo = Object.assign({}, win, {
        brand: device.brand,
        model: device.model,
        platform: device.platform,
      });
      this.globalData.safeAreaBottom = win.safeArea
        ? Math.max(0, win.screenHeight - win.safeArea.bottom)
        : 0;
    } catch (err) {
      console.warn('[app] 获取窗口信息失败', err);
    }
  },
});
