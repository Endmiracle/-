/**
 * util.js - 通用工具（纯函数）
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function pad(n) {
  return n < 10 ? `0${n}` : `${n}`;
}

/** 任意输入转 Date，失败返回 null（iOS 不认 'YYYY-MM-DD HH:mm'，统一替换分隔符） */
function toDate(input) {
  if (input === undefined || input === null || input === '') {
    return null;
  }
  if (input instanceof Date) {
    return Number.isNaN(input.getTime()) ? null : input;
  }
  if (typeof input === 'number') {
    const d = new Date(input);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const normalized = String(input).replace(/-/g, '/').replace(/T/, ' ').replace(/\..+$/, '');
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDate(input, fmt = 'YYYY-MM-DD') {
  const d = toDate(input);
  if (!d) {
    return '';
  }
  const map = {
    YYYY: d.getFullYear(),
    MM: pad(d.getMonth() + 1),
    DD: pad(d.getDate()),
    HH: pad(d.getHours()),
    mm: pad(d.getMinutes()),
    ss: pad(d.getSeconds()),
  };
  return fmt.replace(/YYYY|MM|DD|HH|mm|ss/g, (key) => map[key]);
}

function startOfDay(input) {
  const d = toDate(input) || new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 相对时间：刚刚 / N 分钟前 / HH:mm / 昨天 HH:mm / MM-DD HH:mm */
function relativeTime(input) {
  const d = toDate(input);
  if (!d) {
    return '';
  }
  const diff = Date.now() - d.getTime();
  if (diff < 60 * 1000) {
    return '刚刚';
  }
  if (diff < 60 * 60 * 1000) {
    return `${Math.floor(diff / 60000)} 分钟前`;
  }
  if (startOfDay(d) === startOfDay(Date.now())) {
    return formatDate(d, 'HH:mm');
  }
  const gap = Math.round((startOfDay(Date.now()) - startOfDay(d)) / DAY_MS);
  if (gap === 1) {
    return `昨天 ${formatDate(d, 'HH:mm')}`;
  }
  if (gap < 365) {
    return formatDate(d, 'MM-DD HH:mm');
  }
  return formatDate(d, 'YYYY-MM-DD HH:mm');
}

function genId(prefix = 'id') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 防抖（带 cancel，便于页面卸载时清理） */
function debounce(fn, wait = 300) {
  let timer = null;
  const wrapped = function (...args) {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
  wrapped.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return wrapped;
}

/** 节流：流式输出时用它限制滚动频率，避免每来一个分片就 setData 两次 */
function throttle(fn, wait = 200) {
  let last = 0;
  let timer = null;
  const wrapped = function (...args) {
    const now = Date.now();
    const remain = wait - (now - last);
    if (remain <= 0) {
      last = now;
      fn.apply(this, args);
      return;
    }
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      last = Date.now();
      timer = null;
      fn.apply(this, args);
    }, remain);
  };
  wrapped.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return wrapped;
}

/** 截断（按字符数，不按字节） */
function truncate(text, max = 40) {
  const str = String(text || '');
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

/** API Key 脱敏展示 */
function maskSecret(secret) {
  const str = String(secret || '');
  if (!str) {
    return '未填写';
  }
  if (str.length <= 8) {
    return `${str.slice(0, 2)}****`;
  }
  return `${str.slice(0, 4)}****${str.slice(-4)}`;
}

function toast(title, icon = 'none') {
  wx.showToast({ title: String(title || ''), icon, duration: 2000 });
}

function haptic(type = 'light') {
  try {
    wx.vibrateShort({ type });
  } catch (err) {
    /* 部分机型不支持 */
  }
}

/**
 * 把错误统一成可展示文案
 */
function errorText(err) {
  if (!err) {
    return '未知错误';
  }
  if (typeof err === 'string') {
    return err;
  }
  return err.message || err.errMsg || '请求失败';
}

module.exports = {
  DAY_MS,
  toDate,
  formatDate,
  relativeTime,
  genId,
  debounce,
  throttle,
  truncate,
  maskSecret,
  toast,
  haptic,
  errorText,
};
