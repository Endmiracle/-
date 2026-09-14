/**
 * ingest.js - 文档入库：文本抽取 + 切片
 *
 * 抽取：
 *   .txt .md .csv .json .log .yml .xml 等纯文本 → 直接读
 *   .html  → 去标签取正文
 *   .docx  → 手写 zip 读取（见 docx.js），零依赖
 *   .pdf   → 尽力而为：解压内容流 + 提取 Tj/TJ 文本；扫描件或 CID 字体无法还原，
 *            此时会明确报错而不是把乱码灌进知识库
 *
 * 切片：
 *   按「标题 → 段落」结构化切分，超长段落再按长度硬切并保留重叠。
 *   标题会作为元数据保留，并在检索索引中拼进文本提升召回。
 */

const zlib = require('zlib');
const { extractDocxText } = require('./docx');
const config = require('../config');

/* ============================================================
 * 文本抽取
 * ============================================================ */

const TEXT_EXT = ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'yml', 'yaml', 'ini', 'srt', 'vtt'];
const HTML_EXT = ['html', 'htm', 'xhtml'];

function extOf(filename) {
  const match = /\.([a-z0-9]+)$/i.exec(String(filename || ''));
  return match ? match[1].toLowerCase() : '';
}

/** 行内标签直接剔除（换成空格会把「赛制<b>规则</b>」变成「赛制 规则」） */
const INLINE_TAG = /<\/?(b|i|em|strong|span|a|code|small|u|s|sub|sup|mark|font|label|abbr)\b[^>]*>/gi;
/** 块级标签转成换行，保留段落结构 */
const BLOCK_END = /<\/(p|div|li|h[1-6]|tr|table|section|article|blockquote|pre|dd|dt)>/gi;

function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(INLINE_TAG, '')
    .replace(BLOCK_END, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/* ---------- PDF（尽力而为） ---------- */

function unescapePdfString(text) {
  return text.replace(/\\(\d{1,3}|.)/g, (match, group) => {
    switch (group) {
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case '(':
        return '(';
      case ')':
        return ')';
      case '\\':
        return '\\';
      default:
        if (/^\d{1,3}$/.test(group)) {
          return String.fromCharCode(parseInt(group, 8));
        }
        return group;
    }
  });
}

/** 从内容流里抽 Tj / TJ / ' / " 的文本 */
function extractPdfOperators(content) {
  const pieces = [];
  const matcher = /\((?:\\.|[^\\()])*\)\s*(Tj|TJ|'|")|\[((?:[^\][\\]|\\.|\[[^\]]*\])*)\]\s*TJ/g;
  let match;
  while ((match = matcher.exec(content))) {
    if (match[1]) {
      pieces.push(unescapePdfString(match[0].slice(1, match[0].lastIndexOf(')'))));
      continue;
    }
    if (match[2]) {
      const inner = match[2];
      const stringMatcher = /\((?:\\.|[^\\()])*\)/g;
      let inner2;
      let line = '';
      while ((inner2 = stringMatcher.exec(inner))) {
        line += unescapePdfString(inner2[0].slice(1, -1));
      }
      if (line) {
        pieces.push(line);
      }
    }
  }
  return pieces.join('');
}

/** 判断抽取结果是否可信（PDF 里大量乱码时宁可失败也别污染知识库） */
function looksLikeText(text) {
  const str = String(text || '');
  const compact = str.replace(/\s/g, '');
  if (compact.length < 30) {
    return false;
  }
  // CID 字体子集是 PDF 抽取出乱码的头号原因，其特征是大量 (cid:123)
  if (/\(cid:\d+\)/.test(str)) {
    return false;
  }
  // 替换字符过多说明编码没还原出来
  const bad = (str.match(/\ufffd/g) || []).length;
  if (bad / Math.max(1, compact.length) > 0.01) {
    return false;
  }
  const readable = (
    compact.match(
      /[\u4e00-\u9fa5a-zA-Z0-9，。；：、！？（）《》"'\u2018\u2019\u201c\u201d\-—…·%,.;:!?()"'/]/g
    ) || []
  ).length;
  return readable / compact.length > 0.55;
}

function extractPdfText(buf) {
  const raw = buf.toString('latin1');
  const chunks = [];
  const streamMatcher = /stream\r?\n?([\s\S]*?)endstream/g;
  let match;
  while ((match = streamMatcher.exec(raw))) {
    const body = match[1];
    let content = null;
    const compressed = Buffer.from(body, 'latin1');
    try {
      content = zlib.inflateSync(compressed).toString('latin1');
    } catch (err) {
      try {
        content = zlib.inflateRawSync(compressed).toString('latin1');
      } catch (err2) {
        content = body;
      }
    }
    if (content && /(Tj|TJ)/.test(content)) {
      const text = extractPdfOperators(content);
      if (text.trim()) {
        chunks.push(text);
      }
    }
  }
  return chunks.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* ---------- 统一入口 ---------- */

/**
 * @param {object} input
 * @param {string} input.filename 原始文件名（用于判断类型）
 * @param {Buffer} [input.buffer] 文件内容
 * @param {string} [input.text]   直接粘贴的文本（优先级高于 buffer）
 * @returns {{text: string, warning: string, parser: string}}
 */
function extractText(input = {}) {
  if (input.text !== undefined && input.text !== null) {
    return { text: normalize(String(input.text)), warning: '', parser: 'text' };
  }

  const buffer = input.buffer;
  if (!buffer || !buffer.length) {
    throw new Error('文件内容为空');
  }

  const ext = extOf(input.filename);
  const sizeMb = (buffer.length / 1024 / 1024).toFixed(2);

  if (TEXT_EXT.indexOf(ext) >= 0 || !ext) {
    const text = normalize(buffer.toString('utf8'));
    if (!text) {
      throw new Error('未能从文件中解析出文本内容');
    }
    return { text, warning: '', parser: 'plain' };
  }

  if (HTML_EXT.indexOf(ext) >= 0) {
    return { text: normalize(stripHtml(buffer.toString('utf8'))), warning: '', parser: 'html' };
  }

  if (ext === 'docx') {
    return { text: normalize(extractDocxText(buffer)), warning: '', parser: 'docx' };
  }

  if (ext === 'doc') {
    throw new Error('不支持旧版 .doc 格式，请在 Word 中另存为 .docx 后重新上传');
  }

  if (ext === 'pdf') {
    const text = normalize(extractPdfText(buffer));
    if (!looksLikeText(text)) {
      throw new Error(
        `PDF 文本抽取失败（${sizeMb}MB）。常见原因：扫描件（图片型 PDF）或使用了 CID 字体子集。` +
          '建议：用 OCR 转成文本后，在小程序里选择「粘贴文本」方式入库'
      );
    }
    return {
      text,
      warning: 'PDF 为尽力而为抽取，表格与多栏排版可能有错位，建议核对切片内容',
      parser: 'pdf',
    };
  }

  throw new Error(
    `暂不支持 .${ext} 格式。支持：${TEXT_EXT.concat(HTML_EXT, ['docx', 'pdf']).join(' / ')}`
  );
}

/** 统一换行、去多余空白 */
function normalize(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ============================================================
 * 切片
 * ============================================================ */

const HEADING_PATTERNS = [
  /^#{1,6}\s+.*/,
  /^第[一二三四五六七八九十百零〇\d]+[章节部分篇]/,
  /^\d+(\.\d+)*[\s.、]/,
  /^[（(][一二三四五六七八九十\d]+[）)][\s、.]?/,
];

function isHeading(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 40) {
    return false;
  }
  return HEADING_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/** 表格行判定：以 | 开头 */
function isTableRow(line) {
  return /^\|/.test(String(line).trim());
}

/**
 * 去掉行内 Markdown 标记（**加粗** / `代码` / _斜体_）
 * 保留 | 表格分隔符与 URL —— 前者让片段仍能看出表格结构，后者是客服链接，必须保留
 */
function stripInlineMarkdown(text) {
  return String(text || '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, '$1$2');
}

/**
 * 段落化：连续非空行合并为一段；标题独占一段；表格整块保留
 *
 * 表格单独成块是刻意的：制度文档里「罚款金额」大量以表格承载，
 * 如果把表格行揉进普通段落，金额与项目名的对应关系会被稀释，检索精确度明显下降。
 */
function toBlocks(text) {
  const lines = String(text).split('\n');
  const blocks = [];
  let buffer = [];
  let table = [];

  const flushText = () => {
    if (buffer.length) {
      blocks.push({ type: 'text', content: buffer.join(' ').trim() });
      buffer = [];
    }
  };

  const flushTable = () => {
    if (!table.length) {
      return;
    }
    blocks.push({
      type: 'table',
      content: table.join('\n'),
      header: table.slice(0, 2),
      rows: table.slice(2),
    });
    table = [];
  };

  lines.forEach((line) => {
    const trimmed = line.trim();

    if (isTableRow(trimmed)) {
      flushText();
      table.push(trimmed);
      return;
    }
    if (table.length) {
      flushTable();
    }
    if (!trimmed) {
      flushText();
      return;
    }
    if (isHeading(trimmed)) {
      flushText();
      blocks.push({ type: 'heading', content: trimmed });
      return;
    }
    buffer.push(trimmed);
  });

  flushTable();
  flushText();

  return blocks.filter((block) => block.content);
}

/**
 * 元信息块判定：整块都是引用块/标题/来源说明的行
 *
 * 制度文档开头常见「> 来源文档：xxx.docx／> 文档版本：v1／> 适用范围：…」这类段落。
 * 它们包含大量主题词（俱乐部、陪玩师、分级…），字面匹配得分很高，
 * 但完全不含答案，是 RAG 里最典型的噪音源 —— 打上标记后在排序时降权。
 */
function looksLikeMetaChunk(content) {
  const lines = String(content || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) {
    return false;
  }
  const metaLines = lines.filter((line) => {
    const stripped = line.replace(/^[>#\s]+/, '');
    return (
      /^[>#]/.test(line) ||
      /^(来源文档|文档版本|适用范围|更新日期|生效日期|编制|审核|版本|备注)[:：]/.test(stripped)
    );
  });
  return metaLines.length === lines.length;
}

/**
 * 切片
 * @param {string} text
 * @param {object} options
 * @param {number} [options.size]    目标切片长度（字符）
 * @param {number} [options.overlap] 超长段落硬切时的重叠长度
 * @param {number} [options.minSize] 过短的尾块合并阈值
 * @returns {Array<{index:number, heading:string, content:string, charCount:number}>}
 */
function chunkText(text, options = {}) {
  const size = Math.max(120, options.size || config.chunk.size);
  const overlap = Math.min(Math.max(0, options.overlap || config.chunk.overlap), Math.floor(size / 2));
  const minSize = options.minSize || config.chunk.minSize;

  const blocks = toBlocks(text);
  if (!blocks.length) {
    return [];
  }

  const chunks = [];
  let heading = '';
  let current = '';

  const push = (content, currentHeading, extra) => {
    const body = stripInlineMarkdown(String(content).trim());
    if (!body) {
      return;
    }
    chunks.push(
      Object.assign(
        {
          index: chunks.length,
          heading: currentHeading || '',
          content: body,
          charCount: body.length,
          isMeta: looksLikeMetaChunk(body),
        },
        extra || {}
      )
    );
  };

  /**
   * 表格切片：表头 + 若干行成一块，超长时续块重复表头
   * 这样每个片段都自带表头，单独看也能知道「5 元 / 局 / 人」对应的是哪个项目
   */
  const pushTable = (block) => {
    const headerLines = block.header || [];
    const rows = block.rows || [];

    if (!rows.length) {
      push(block.content, heading, { isTable: true });
      return;
    }

    const headerText = headerLines.join('\n');
    let batch = [];
    let batchLength = headerText.length;

    const flushBatch = () => {
      if (!batch.length) {
        return;
      }
      push(`${headerText}\n${batch.join('\n')}`, heading, { isTable: true });
      batch = [];
      batchLength = headerText.length;
    };

    rows.forEach((row) => {
      if (batch.length && batchLength + row.length + 1 > size) {
        flushBatch();
      }
      batch.push(row);
      batchLength += row.length + 1;
    });
    flushBatch();
  };

  /** 超长段落：按句子边界硬切，保留 overlap */
  const splitLong = (paragraph, currentHeading) => {
    let rest = paragraph;
    while (rest.length > size) {
      let cut = rest.lastIndexOf('。', size);
      if (cut < size * 0.5) {
        cut = rest.lastIndexOf('；', size);
      }
      if (cut < size * 0.5) {
        cut = rest.lastIndexOf('\n', size);
      }
      if (cut < size * 0.5) {
        cut = size;
      }
      push(rest.slice(0, cut + 1), currentHeading);
      rest = rest.slice(Math.max(0, cut + 1 - overlap));
    }
    return rest;
  };

  blocks.forEach((block) => {
    if (block.type === 'heading') {
      // 遇到标题就把缓冲清掉（用旧标题落章），随后切换标题
      if (current) {
        push(current, heading);
        current = '';
      }
      heading = block.content;
      return;
    }

    if (block.type === 'table') {
      // 表格与正文不混切，保证金额/项目对应关系不被稀释
      if (current) {
        push(current, heading);
        current = '';
      }
      pushTable(block);
      return;
    }

    if (block.content.length >= size) {
      if (current) {
        push(current, heading);
        current = '';
      }
      const rest = splitLong(block.content, heading);
      current = rest;
      return;
    }

    if (current.length + block.content.length + 1 > size && current.length >= minSize) {
      push(current, heading);
      current = block.content;
      return;
    }

    current = current ? `${current}\n${block.content}` : block.content;
  });

  if (current.trim()) {
    push(current, heading);
  }

  // 合并过短的尾块，避免出现「只有标题一行」的碎片。
  // 表格块不参与合并：它们的价值在于结构化，与正文黏在一起反而降低精确度。
  const merged = [];
  chunks.forEach((chunk) => {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      !prev.isTable &&
      !chunk.isTable &&
      chunk.charCount < minSize &&
      prev.charCount + chunk.charCount <= size * 1.4
    ) {
      prev.content += `\n${chunk.content}`;
      prev.charCount = prev.content.length;
      return;
    }
    merged.push(chunk);
  });

  return merged.map((chunk, index) => ({ ...chunk, index }));
}

module.exports = {
  extractText,
  chunkText,
  stripHtml,
  stripInlineMarkdown,
  looksLikeMetaChunk,
  normalize,
  isHeading,
  isTableRow,
  toBlocks,
  extOf,
  SUPPORTED_EXT: TEXT_EXT.concat(HTML_EXT, ['docx', 'pdf']),
};
