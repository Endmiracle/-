/**
 * docx.js - 零依赖的 .docx 文本抽取
 *
 * 原理：.docx 本质是一个 zip 包，正文在 word/document.xml 里。
 * Node 内置 zlib 已提供 inflateRaw，因此不需要任何第三方库就能读 zip：
 *   1. 从文件尾部找 EOCD（中央目录结束标记）
 *   2. 遍历中央目录，拿到每个条目的压缩方式与数据偏移
 *   3. 读本地文件头 → 取压缩数据 → method 0 直读 / method 8 用 inflateRaw 解压
 *   4. 从 document.xml 提取 <w:t> 文本，段落边界转成换行
 */

const zlib = require('zlib');

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

/** 从尾部查找 EOCD（注释最长 65535 字节） */
function findEndOfCentralDirectory(buf) {
  const maxComment = 0xffff;
  const start = Math.max(0, buf.length - maxComment - 22);
  for (let i = buf.length - 22; i >= start; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      return i;
    }
  }
  return -1;
}

/**
 * 读取 zip 中的全部条目
 * @param {Buffer} buf
 * @returns {Map<string, Buffer>} 文件名 -> 解压后的内容
 */
function readZipEntries(buf) {
  const entries = new Map();
  const eocd = findEndOfCentralDirectory(buf);
  if (eocd < 0) {
    throw new Error('不是有效的 zip/docx 文件（未找到目录结束标记）');
  }

  const total = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < total; i += 1) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CD_SIG) {
      break;
    }
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength);

    // 本地文件头里的名称/扩展区长度才决定数据起点
    if (localOffset + 30 <= buf.length && buf.readUInt32LE(localOffset) === LFH_SIG) {
      const localNameLength = buf.readUInt16LE(localOffset + 26);
      const localExtraLength = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      let data = buf.slice(dataStart, dataStart + compressedSize);

      if (method === 8) {
        try {
          data = zlib.inflateRawSync(data);
        } catch (err) {
          data = Buffer.alloc(0);
        }
      } else if (method !== 0) {
        data = Buffer.alloc(0);
      }
      entries.set(name, data);
    }

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/** XML 实体解码 */
function decodeEntities(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (match, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

/**
 * 提取 .docx 正文
 * @param {Buffer} buf
 * @returns {string}
 */
function extractDocxText(buf) {
  const entries = readZipEntries(buf);
  const doc = entries.get('word/document.xml');
  if (!doc || !doc.length) {
    throw new Error('docx 中未找到 word/document.xml，文件可能已损坏');
  }

  let xml = doc.toString('utf8');

  // 段落与换行先转成占位换行，避免随后被当作标签去掉
  xml = xml
    .replace(/<w:br\s*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:tab\s*\/>/g, '\t');

  // 去掉所有 XML 标签，留下的即正文
  let text = xml.replace(/<[^>]*>/g, '');

  text = decodeEntities(text);

  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line, index, list) => line || (index > 0 && list[index - 1]))
    .join('\n')
    .trim();
}

module.exports = {
  readZipEntries,
  extractDocxText,
  decodeEntities,
};
