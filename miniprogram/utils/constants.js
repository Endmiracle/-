/**
 * constants.js - 全局常量与默认配置
 *
 * 本项目所有可调项集中在两处：
 *   1. 编译期常量：本文件
 *   2. 运行时配置：pages/settings（写入本地 Storage，无需改代码重新编译）
 */

/** 连接模式 */
const CONNECTION_MODES = [
  {
    value: 'cloud',
    label: '云托管',
    desc: '引擎部署在微信云托管，小程序走内网直连。免服务器、免域名、免备案，也不需要填任何密钥。代价是不支持流式，回答一次性返回。',
  },
  {
    value: 'proxy',
    label: '自建服务',
    desc: '引擎跑在你自己的机器/服务器上，配一个 HTTPS 域名。支持逐字流式输出，但需要域名且已备案。',
  },
  {
    value: 'direct',
    label: '直连调试',
    desc: '开发者工具或真机调试时直连本机引擎（需跳过域名校验）。仅联调用，正式环境不可用。',
  },
];

/** 运行时配置默认值 —— 首次进入小程序时写入本地 */
const DEFAULT_CONFIG = {
  /** 'cloud' | 'proxy' | 'direct' */
  mode: 'cloud',

  /* ---------- 云托管模式（推荐：免域名免备案） ---------- */
  /** 云托管环境 ID，形如 prod-1gxxxxxx（云托管控制台右上角「环境」→「我的环境」复制；注意 ≠ 云开发环境 ID） */
  cloudEnv: '',
  /** 云托管服务名，在「云托管 - 服务列表」里看，如 yuyi-rag */
  cloudService: 'yuyi-rag',

  /* ---------- 自建服务 / 直连调试 ---------- */
  /** 自建引擎地址，如 http://192.168.1.10:8787 或 https://your-domain.com */
  proxyBase: 'http://127.0.0.1:8787',
  /** 代理访问令牌（可选，与代理启动时的 ACCESS_TOKEN 一致） */
  accessToken: '',
  /** RAGFlow 地址，直连模式使用，如 http://127.0.0.1:9380 */
  ragflowBase: 'http://127.0.0.1:9380',
  /** RAGFlow API Key（直连模式必填，从 RAGFlow 页面右上角头像 → API 获取） */
  apiKey: '',
  /** 选中的对话助手 ID（Chat Assistant ID） */
  chatId: '',
  /** 选中的助手名称，仅用于展示 */
  chatName: '羽衣电竞陪玩制度助手',
  /**
   * 是否使用流式输出
   * 云托管模式下自动按 false 处理（callContainer 不支持分片接收），此项不生效。
   */
  stream: true,
  /** 单次请求超时（毫秒）。RAGFlow 本地推理较慢，给足时间 */
  timeout: 90000,
};

/** 本地存储键 */
const STORAGE_KEYS = {
  CONFIG: 'yuyi:config:v1',
  MESSAGES: 'yuyi:messages:v1',
  SESSION: 'yuyi:session:v1',
};

/**
 * 首页推荐问题（点击直接提问）
 * 取自陪玩师真实高频提问；改这里即可调整首页引导
 */
const QUICK_QUESTIONS = [
  '钻石陪玩保级需要多少单？',
  '炸单要扣多少钱？',
  '客服链接在哪里？',
  '接单后老板失联怎么办？',
  '哪些行为会被罚款？',
];

/** 品牌信息 */
const BRAND = {
  name: '羽衣电竞陪玩制度助手',
  short: '羽衣',
  tagline: '基于羽衣电竞俱乐部制度知识库的智能问答',
  /** 换主题时同步改 app.wxss 的令牌 */
  welcome:
    '你好，我是羽衣电竞陪玩制度助手。等级升级、分成比例、炸单价格、罚款标准、订单报备、客服链接，都可以问我。',
  /** 吉祥物与品牌图（assets 目录） */
  logo: '/assets/logo.jpg',
  avatar: '/assets/mascot-head.jpg',
};

/** RAGFlow 官方 SDK 接口的路径前缀（代理与直连保持一致，便于一套代码跑两种模式） */
const API_PREFIX = '/api/v1';

/** 开发期日志开关 */
const DEBUG = true;

module.exports = {
  CONNECTION_MODES,
  DEFAULT_CONFIG,
  STORAGE_KEYS,
  QUICK_QUESTIONS,
  BRAND,
  API_PREFIX,
  DEBUG,
};
