/* eslint-disable */
/**
 * check-project.js - 小程序静态自检（不需要打开开发者工具）
 *
 * 用法：node scripts/check-project.js  [项目根目录]
 *
 * 检查 6 类最容易只在上线前才暴露的问题：
 *   1. 所有 .json 能否解析
 *   2. app.json 声明的页面，.js/.wxml/.json 是否齐全
 *   3. usingComponents 路径能否解析
 *   4. WXML 里用到的自定义组件是否已在 app.json 或页面 json 注册
 *   5. <wxs src> 与 require('...') 的相对路径是否存在
 *   6. WXML 里 bind/catch 的处理函数是否在对应 JS 中定义
 */

const fs = require('fs');
const path = require('path');

const root = process.argv[2] || path.join(__dirname, '..');
const mpRoot = path.join(root, 'miniprogram');
const errors = [];
const warns = [];
const notes = [];

/** 小程序内置组件（带连字符的），不需要注册 */
const BUILTIN = new Set([
  'scroll-view', 'swiper-item', 'movable-view', 'movable-area', 'cover-view', 'cover-image',
  'rich-text', 'web-view', 'open-data', 'official-account', 'navigation-bar', 'page-meta',
  'match-media', 'keyboard-accessory', 'picker-view', 'picker-view-column', 'checkbox-group',
  'radio-group', 'ad-custom', 'page-container', 'share-element', 'root-portal', 'grid-view',
  'list-view', 'sticky-header', 'sticky-section', 'snapshot', 'span', 'double-tap-gesture-handler',
  'tap-gesture-handler', 'vertical-drag-gesture-handler', 'horizontal-drag-gesture-handler',
  'pan-gesture-handler', 'scale-gesture-handler', 'force-press-gesture-handler',
  'longpress-gesture-handler', 'nested-scroll-header', 'nested-scroll-body', 'functional-page-navigator',
  'channel-live', 'channel-video', 'store-home', 'store-product', 'voip-room', 'inline-payment-panel',
]);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    errors.push(`JSON 解析失败: ${path.relative(root, file)} -> ${err.message}`);
    return null;
  }
}

function walk(dir, filter, out = []) {
  if (!fs.existsSync(dir)) {
    return out;
  }
  for (const name of fs.readdirSync(dir)) {
    if (name === 'miniprogram_npm' || name === 'node_modules' || name === '.git' || name === 'data') {
      continue;
    }
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      walk(full, filter, out);
    } else if (filter(name)) {
      out.push(full);
    }
  }
  return out;
}

/** 去掉注释，避免文档示例里的 require 被误判 */
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/* ---- 1. JSON ---- */
const jsonFiles = walk(root, (n) => n.endsWith('.json'));
jsonFiles.forEach(readJson);
notes.push(`JSON 文件 ${jsonFiles.length} 个，全部解析通过`);

/* ---- 2. 页面完整性 ---- */
const appJson = readJson(path.join(mpRoot, 'app.json'));
const globalComponents = (appJson && appJson.usingComponents) || {};
(appJson.pages || []).forEach((page) => {
  ['.js', '.wxml', '.json'].forEach((ext) => {
    if (!fs.existsSync(path.join(mpRoot, page + ext))) {
      errors.push(`app.json 声明的页面缺文件: ${page}${ext}`);
    }
  });
});

/* ---- 3. usingComponents 路径 ---- */
function resolveComponent(fromFile, compPath) {
  if (compPath.startsWith('/')) {
    return `${path.join(mpRoot, compPath.replace(/^\//, ''))}.json`;
  }
  if (compPath.startsWith('.')) {
    return `${path.resolve(path.dirname(fromFile), compPath)}.json`;
  }
  return `${path.join(mpRoot, 'miniprogram_npm', compPath)}.json`;
}

jsonFiles.forEach((file) => {
  const json = readJson(file);
  if (!json || !json.usingComponents) {
    return;
  }
  Object.keys(json.usingComponents).forEach((tag) => {
    const target = resolveComponent(file, json.usingComponents[tag]);
    if (!fs.existsSync(target)) {
      errors.push(`组件路径无法解析: ${path.relative(root, file)} -> ${tag}: ${json.usingComponents[tag]}`);
    }
  });
});

/* ---- 4. 自定义组件是否注册 ---- */
const wxmlFiles = walk(mpRoot, (n) => n.endsWith('.wxml'));
wxmlFiles.forEach((wxml) => {
  const content = fs.readFileSync(wxml, 'utf8');
  const jsonPath = wxml.replace(/\.wxml$/, '.json');
  const local = fs.existsSync(jsonPath) ? (readJson(jsonPath) || {}).usingComponents || {} : {};
  const declared = new Set([...Object.keys(globalComponents), ...Object.keys(local)]);

  const used = new Set();
  const re = /<([a-zA-Z][a-zA-Z0-9-]*)/g;
  let match;
  while ((match = re.exec(content))) {
    const tag = match[1];
    if (tag.indexOf('-') > 0 && !BUILTIN.has(tag)) {
      used.add(tag);
    }
  }
  used.forEach((tag) => {
    if (!declared.has(tag)) {
      errors.push(`组件未注册: ${path.relative(root, wxml)} 使用了 <${tag}>`);
    }
  });
});

/* ---- 5. wxs / require ---- */
const wxsRe = /<wxs\s+src="([^"]+)"/g;
wxmlFiles.forEach((wxml) => {
  const content = fs.readFileSync(wxml, 'utf8');
  let match;
  while ((match = wxsRe.exec(content))) {
    if (!fs.existsSync(path.resolve(path.dirname(wxml), match[1]))) {
      errors.push(`wxs 文件不存在: ${path.relative(root, wxml)} -> ${match[1]}`);
    }
  }
});

const jsFiles = walk(root, (n) => n.endsWith('.js') && n !== 'check-project.js');
const reqRe = /require\(['"](\.[^'"]+)['"]\)/g;
jsFiles.forEach((js) => {
  const content = stripComments(fs.readFileSync(js, 'utf8'));
  let match;
  while ((match = reqRe.exec(content))) {
    const base = path.resolve(path.dirname(js), match[1]);
    const ok = [base, `${base}.js`, path.join(base, 'index.js')].some((file) => fs.existsSync(file));
    if (!ok) {
      errors.push(`require 路径不存在: ${path.relative(root, js)} -> ${match[1]}`);
    }
  }
});

/* ---- 6. 事件处理函数 ---- */
wxmlFiles.forEach((wxml) => {
  const js = wxml.replace(/\.wxml$/, '.js');
  if (!fs.existsSync(js)) {
    return;
  }
  const jsContent = stripComments(fs.readFileSync(js, 'utf8'));
  const content = fs.readFileSync(wxml, 'utf8');
  const bindRe = /(?:bind|catch):?([a-zA-Z]+)="([a-zA-Z_$][\w$]*)"/g;
  const handlers = new Set();
  let match;
  while ((match = bindRe.exec(content))) {
    handlers.add(match[2]);
  }
  handlers.forEach((handler) => {
    if (!new RegExp(`\\b${handler}\\s*\\(`).test(jsContent)) {
      warns.push(`事件处理函数可能缺失: ${path.relative(root, wxml)} -> ${handler}()`);
    }
  });
});

/* ---- 6.5 引用的本地资源是否存在 ---- */
wxmlFiles.forEach((wxml) => {
  const content = fs.readFileSync(wxml, 'utf8');
  const srcRe = /src="(\/[^"]+)"/g;
  let match;
  while ((match = srcRe.exec(content))) {
    const asset = path.join(mpRoot, match[1].replace(/^\//, ''));
    if (!fs.existsSync(asset)) {
      errors.push(`引用了不存在的本地资源: ${path.relative(root, wxml)} -> ${match[1]}`);
    }
  }
});

/* ---- 7. WXML 表达式禁忌写法 ---- */
/**
 * WXML 的 {{ }} 只支持「取值 + 运算符 + 三元」，不支持函数调用。
 * 写 Math.floor(x) / list.indexOf(v) 不会报错，只会静静地渲染成空，
 * 是排查成本最高的一类问题，所以在这里静态拦住。
 */
wxmlFiles.forEach((wxml) => {
  const content = fs.readFileSync(wxml, 'utf8');
  // 去掉 wxs 内联块与注释
  const cleaned = content.replace(/<wxs[\s\S]*?<\/wxs>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const exprRe = /\{\{([\s\S]*?)\}\}/g;
  let match;
  while ((match = exprRe.exec(cleaned))) {
    const expr = match[1];
    const methodCall = /\.\s*[a-zA-Z_$][\w$]*\s*\(/.exec(expr);
    if (methodCall) {
      errors.push(
        `WXML 表达式中出现方法调用（不支持）: ${path.relative(root, wxml)} -> {{${expr.trim().slice(0, 60)}}}`
      );
      continue;
    }
    const globalCall = /\b(Math|JSON|Date|Object|Array|parseInt|parseFloat|String|Number)\s*\./.exec(expr);
    if (globalCall) {
      errors.push(
        `WXML 表达式中使用内置对象（不支持）: ${path.relative(root, wxml)} -> {{${expr.trim().slice(0, 60)}}}`
      );
    }
  }

  // 文本节点里的字面量 \n 不会换行，只会原样显示
  if (/\\n/.test(cleaned)) {
    warns.push(`WXML 文本中出现字面量 \\n（不会换行）: ${path.relative(root, wxml)}`);
  }
});

/* ---- 输出 ---- */
console.log('\n===== 小程序静态自检 =====');
notes.forEach((item) => console.log(`[信息] ${item}`));
console.log(`待检 WXML ${wxmlFiles.length} 个，JS ${jsFiles.length} 个`);
if (warns.length) {
  console.log('\n--- 提醒 ---');
  warns.forEach((item) => console.log(`  ! ${item}`));
}
if (errors.length) {
  console.log('\n--- 错误 ---');
  errors.forEach((item) => console.log(`  x ${item}`));
  console.log(`\n共 ${errors.length} 个错误`);
  process.exit(1);
}
console.log('\n全部检查通过，无错误。');
