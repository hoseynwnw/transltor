const zlib = require('zlib');
const util = require('util');
const gunzip = util.promisify(zlib.gunzip);
const gzip = util.promisify(zlib.gzip);

const config = { api: { bodyParser: false } };

function varintSize(v) { v = v >>> 0; let s = 0; do { s++; v >>>= 7; } while (v > 0); return s; }
function writeVarint(buf, offset, value) { let v = value >>> 0; while (v > 0x7f) { buf[offset++] = (v & 0x7f) | 0x80; v >>>= 7; } buf[offset] = v; }

class PbReader {
  constructor(bytes) { this.buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes); this.pos = 0; this.len = this.buf.length; }
  eof() { return this.pos >= this.len; }
  uint32() { let r = 0, s = 0; while (this.pos < this.len) { const b = this.buf[this.pos++]; r |= (b & 0x7f) << s; if ((b & 0x80) === 0) return r >>> 0; s += 7; if (s >= 35) { this.pos++; return r >>> 0; } } return 0; }
  bytes() { const len = this.uint32(); if (this.pos + len > this.len) throw new Error('overrun'); const s = this.buf.slice(this.pos, this.pos + len); this.pos += len; return s; }
}

class PbWriter {
  constructor() { this.bufs = []; this.totalLen = 0; }
  _push(b) { const d = b instanceof Uint8Array ? b : new Uint8Array(b); this.bufs.push(d); this.totalLen += d.length; }
  uint32(v) { const buf = new Uint8Array(varintSize(v >>> 0)); writeVarint(buf, 0, v >>> 0); this._push(buf); return this; }
  bytes(data) { const d = data instanceof Uint8Array ? data : new Uint8Array(data); this.uint32(d.length); this._push(d); return this; }
  finish() { const out = new Uint8Array(this.totalLen); let off = 0; for (const b of this.bufs) { out.set(b, off); off += b.length; } return out; }
}

function pbDecode(bytes) {
  const r = new PbReader(bytes); const obj = {};
  while (!r.eof()) {
    let tag; try { tag = r.uint32(); } catch { break; } if (tag === 0) break;
    const fn = tag >>> 3, wt = tag & 0x07, key = String(fn); let val;
    try {
      if (wt === 0) val = { t: 'varint', v: r.uint32() };
      else if (wt === 1) { if (r.pos + 8 > r.len) break; val = { t: 'fixed64', v: r.buf.slice(r.pos, r.pos + 8) }; r.pos += 8; }
      else if (wt === 2) {
        const raw = r.bytes(); let nested = null;
        if (raw.length >= 2) { try { const n = pbDecode(raw); if (Object.keys(n).length > 0) nested = n; } catch {} }
        val = nested ? { t: 'msg', v: nested, raw } : { t: 'raw', v: raw };
      }
      else if (wt === 5) { if (r.pos + 4 > r.len) break; const dv = new DataView(r.buf.buffer, r.buf.byteOffset + r.pos, 4); val = { t: 'fixed32', v: dv.getUint32(0, true) }; r.pos += 4; }
      else break;
    } catch { break; }
    if (key in obj) { const ex = obj[key]; obj[key] = Array.isArray(ex) ? [...ex, val] : [ex, val]; } else obj[key] = val;
  }
  return obj;
}

const ENC = new TextEncoder();
const UTF8 = new TextDecoder('utf-8', { fatal: true });

function pbEncode(obj) {
  const w = new PbWriter();
  for (const [key, fieldVal] of Object.entries(obj)) {
    const fn = parseInt(key); if (isNaN(fn) || fn <= 0) continue;
    const items = Array.isArray(fieldVal) ? fieldVal : [fieldVal];
    for (const val of items) {
      if (!val) continue;
      if (val.t === 'varint') { w.uint32((fn << 3) | 0); w.uint32(val.v); }
      else if (val.t === 'fixed64') { w.uint32((fn << 3) | 1); w._push(val.v); }
      else if (val.t === 'fixed32') { w.uint32((fn << 3) | 5); const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, val.v, true); w._push(b); }
      else if (val.t === 'string') { w.uint32((fn << 3) | 2); w.bytes(ENC.encode(val.v)); }
      else if (val.t === 'msg') {
        if (val.dirty) { w.uint32((fn << 3) | 2); w.bytes(pbEncode(val.v)); }
        else if (val.raw) { w.uint32((fn << 3) | 2); w.bytes(val.raw); }
        else { w.uint32((fn << 3) | 2); w.bytes(pbEncode(val.v)); }
      }
      else if (val.t === 'raw') { w.uint32((fn << 3) | 2); w.bytes(val.v); }
    }
  }
  return w.finish();
}

function tryStr(val) {
  if (!val || Array.isArray(val)) return null;
  if (val.t === 'string') return val.v;
  if (val.t === 'raw') { try { return UTF8.decode(val.v); } catch { return null; } }
  if (val.t === 'msg' && val.raw) { try { return UTF8.decode(val.raw); } catch { return null; } }
  return null;
}

function isTimestamp(s) { return s && /^(?:\d{1,2}:)?\d{1,2}:\d{2}$/.test(s.trim()); }

function findDeepText(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const f1 = obj['1'];
  if (f1) {
    let str = '';
    if (Array.isArray(f1)) str = f1.map(item => tryStr(item) || '').join('');
    else str = tryStr(f1) || '';
    if (str && !isTimestamp(str) && str.trim().length > 3) return str;
  }
  for (const val of Object.values(obj)) {
    for (const item of (Array.isArray(val) ? val : [val])) {
      if (item && item.t === 'msg') {
        const res = findDeepText(item.v);
        if (res) return res;
      }
    }
  }
  return null;
}

function extractTimeAndText(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const f1 = obj['1'], f5 = obj['5'];
  if (f1 && f5) {
    let t1 = '';
    if (Array.isArray(f1)) t1 = f1.map(item => tryStr(item) || '').join('');
    else t1 = tryStr(f1) || '';
    const t5 = Array.isArray(f5) ? tryStr(f5[0]) : tryStr(f5);
    if (t1 && isTimestamp(t5)) return { time: t5, text: t1, type: 'normal' };
  }
  if (f1 && !f5) {
    const t1 = Array.isArray(f1) ? tryStr(f1[0]) : tryStr(f1);
    if (isTimestamp(t1)) {
      const f2obj = obj['2'];
      if (f2obj) {
        const text = findDeepText(Array.isArray(f2obj) ? { _items: f2obj } : (f2obj.t === 'msg' ? f2obj.v : null));
        if (text) return { time: t1, text, type: 'nested' };
      }
    }
  }
  return null;
}

function adjustField7(obj, appendBytesLength) {
  const f7 = obj['7'];
  if (f7 && !Array.isArray(f7) && f7.t === 'varint' && f7.v > 0) {
    obj['7'] = { t: 'varint', v: f7.v + appendBytesLength };
  }
}

function replaceDeepText(obj, appendStr) {
  if (!obj || typeof obj !== 'object') return false;
  const f1 = obj['1'];
  if (f1) {
    let str = '';
    if (Array.isArray(f1)) str = f1.map(item => tryStr(item) || '').join('');
    else str = tryStr(f1) || '';
    if (str && !isTimestamp(str) && str.trim().length > 3) {
      if (Array.isArray(f1)) f1.push({ t: 'string', v: appendStr });
      else obj['1'] = { t: 'string', v: str + appendStr };
      adjustField7(obj, ENC.encode(appendStr).length);
      obj.__dirty = true;
      return true;
    }
  }
  for (const [key, val] of Object.entries(obj)) {
    if (key === '__dirty') continue;
    for (const item of (Array.isArray(val) ? val : [val])) {
      if (item && item.t === 'msg') {
        if (replaceDeepText(item.v, appendStr)) { item.dirty = true; obj.__dirty = true; return true; }
      }
    }
  }
  return false;
}

function hackTextAndLength(obj, appendStr, extractedType) {
  if (!obj || typeof obj !== 'object') return;
  if (extractedType === 'normal') {
    const f1 = obj['1'];
    if (f1) {
      if (Array.isArray(f1)) f1.push({ t: 'string', v: appendStr });
      else { const str = tryStr(f1) || ''; obj['1'] = { t: 'string', v: str + appendStr }; }
      adjustField7(obj, ENC.encode(appendStr).length);
      obj.__dirty = true;
    }
  } else if (extractedType === 'nested') {
    const f2 = obj['2'];
    if (f2) {
      const target = Array.isArray(f2) ? f2.find(item => item && item.t === 'msg') : (f2.t === 'msg' ? f2 : null);
      if (target && replaceDeepText(target.v, appendStr)) { target.dirty = true; obj.__dirty = true; }
    }
  }
}

function collectSegmentsGlobally(obj, segments = []) {
  if (!obj || typeof obj !== 'object') return segments;
  const extracted = extractTimeAndText(obj);
  if (extracted) {
    segments.push({ origText: extracted.text, origTime: extracted.time, type: extracted.type });
    return segments;
  }
  for (const val of Object.values(obj)) {
    for (const item of (Array.isArray(val) ? val : [val])) {
      if (item && item.t === 'msg') collectSegmentsGlobally(item.v, segments);
    }
  }
  return segments;
}

function injectTranslationsGlobally(obj, translations, state = { idx: 0 }, targetLang = 'zh-CN') {
  if (!obj || typeof obj !== 'object') return false;
  let changed = false;
  const extracted = extractTimeAndText(obj);
  if (extracted) {
    const cleanOrig = extracted.text.replace(/\n/g, ' ').trim();
    let zh = translations[state.idx];
    if (!zh || zh === cleanOrig) zh = `【受限】${cleanOrig.slice(0, 10)}...`;

    const rtlLangs = ['ar', 'he', 'fa', 'ur']; 
    const isRtl = rtlLangs.some(l => targetLang.startsWith(l));
    let appendStr = isRtl ? `\n${zh}` : `\n\u3000\u3000${zh}`;

    hackTextAndLength(obj, appendStr, extracted.type);
    obj.__dirty = true;
    state.idx++;
    return true;
  }
  for (const val of Object.values(obj)) {
    for (const item of (Array.isArray(val) ? val : [val])) {
      if (item && item.t === 'msg') {
        if (injectTranslationsGlobally(item.v, translations, state, targetLang)) {
          item.dirty = true; obj.__dirty = true; changed = true;
        }
      }
    }
  }
  return changed;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
let globalCircuitBroken = false;
let currentGasIndex = 0;

// 【修改】加入 runCtx 參數來記錄配額
async function translateBatch(texts, targetLang, gasUrls, runCtx) {
  const clean = texts.map(t => (t || '').replace(/\n/g, ' ').trim());
  if (globalCircuitBroken) return clean;

  let attempts = 0;
  while (attempts < gasUrls.length) {
    if (currentGasIndex >= gasUrls.length) currentGasIndex = gasUrls.length - 1;
    let myTryIndex = currentGasIndex; 
    let gasUrl = gasUrls[myTryIndex];
    if (!gasUrl) return clean;
    
    try {
      const r = await fetch(gasUrl, { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ texts: clean, targetLang })
      }); 

      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (data.error) throw new Error(data.error);

      // 保存最新的配額到上下文
      if (data.quota) {
          console.log(`[GAS] 線路 ${myTryIndex} | 當前配額: ${data.quota} / 5000`);
          if (runCtx) runCtx.quota = data.quota;
      }

      globalCircuitBroken = false;
      const translatedArray = data.translations || [];
      if (translatedArray.length === clean.length) return translatedArray;
      return clean;
    } catch (e) {
      if (e.message.includes('1 日にサービス') || e.message.includes('Too many')) {
        if (currentGasIndex === myTryIndex) {
          currentGasIndex++;
          if (currentGasIndex >= gasUrls.length) globalCircuitBroken = true;
        }
      } else {
        return clean; 
      }
    }
    attempts++;
  }
  return clean;
}

// 【修改】加入 runCtx 參數傳遞
async function translateAll(segments, targetLang, gasUrls, runCtx) {
  if (!segments || !segments.length) return { translations: [] };
  globalCircuitBroken = false;
  const BS = 50; const CC = 4;  
  const batches = [];
  for (let i = 0; i < segments.length; i += BS) batches.push(segments.slice(i, i + BS));
  
  const results = new Array(batches.length);
  let index = 0;

  async function runner() {
    while (index < batches.length) {
      const i = index++;
      const batchTexts = batches[i].map(s => s.origText.replace(/\n/g, ' ').trim());
      if (i > 0 && !globalCircuitBroken) await sleep(200); 
      results[i] = await translateBatch(batchTexts, targetLang, gasUrls, runCtx);
    }
  }

  const workers = Array(Math.min(CC, batches.length)).fill(0).map(() => runner());
  await Promise.all(workers);
  return { translations: results.flat() };
}

module.exports = async function (req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let buffer = Buffer.concat(chunks);

    const targetLang = req.headers['x-target-lang'] || 'zh-CN,fa';
    const isGzip = req.headers['x-is-gzip'] === 'true';
    const reqToken = req.headers['x-req-token'];
    const cfUrl = req.headers['x-cf-url'];
    
    let gasUrls = [];
    if (process.env.SECRET_GAS_URL) {
      gasUrls = [process.env.SECRET_GAS_URL];
    } else {
      gasUrls = ['https://script.google.com/macros/s/AKfycbxUfXTjUQX6q1FiVjv5ZsNblPcOCbU_cJVO7BWXhctl1RX6Y5FA8xGvwPLnyVs5A_Q/exec'];
    }

    if (isGzip) buffer = await gunzip(buffer);
    const parsed = pbDecode(new Uint8Array(buffer));
    const segments = collectSegmentsGlobally(parsed);

    let cacheStatus = "MISS_AND_TRANSLATED"; 
    let runCtx = { quota: null }; // 用來記錄這次運行的 GAS 配額

    if (segments.length > 0) {
      let finalTranslations = null;

      // 1. 讀取 CF 快取
      if (reqToken && cfUrl) {
         try {
            const cacheResp = await fetch(`${cfUrl}/api/cache?token=${reqToken}&lang=${targetLang}`);
            if (cacheResp.ok) {
               const data = await cacheResp.json();
               if (data.translations && data.translations.length === segments.length) {
                  finalTranslations = data.translations;
                  cacheStatus = "HIT_EDGE_CACHE"; // 命中快取！
                  console.log("✅ Vercel 命中 CF 邊緣純文本快取，跳過 GAS 翻譯");
               }
            }
         } catch(e) { }
      }

      // 2. 若未命中則進行翻譯，並寫入快取
      if (!finalTranslations) {
         const { translations } = await translateAll(segments, targetLang, gasUrls, runCtx);
         finalTranslations = translations;

         // 💡 【核心修復】加入 await，強制 Vercel 等待快取寫入完畢，徹底消滅 SocketError
         if (reqToken && cfUrl && finalTranslations.length === segments.length) {
             try {
               const wRes = await fetch(`${cfUrl}/api/cache?token=${reqToken}&lang=${targetLang}`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ translations: finalTranslations })
               });
               await wRes.text(); 
             } catch (e) {
               console.error("Write Cache Error", e);
             }
         }
      }

      // 3. 寫入新鮮的 Protobuf
      injectTranslationsGlobally(parsed, finalTranslations, { idx: 0 }, targetLang);
    }

    let finalBuffer = Buffer.from(pbEncode(parsed));
    if (isGzip) finalBuffer = await gzip(finalBuffer);

    // 💡 透過 HTTP Header 將狀態與配額傳回給 Cloudflare
    res.setHeader('X-Cache-Status', cacheStatus);
    if (runCtx.quota) {
        res.setHeader('X-GAS-Quota', runCtx.quota.toString());
    }
    
    res.setHeader('Content-Type', 'application/x-protobuf');
    res.status(200).send(finalBuffer);

  } catch (error) {
    console.error("Vercel Error:", error);
    res.status(500).json({ error: error.message });
  }
};
module.exports.config = config;
