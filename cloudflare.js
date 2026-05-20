/**
 * Cloudflare Worker: YouTube iOS 雙語字幕 (V54 - 邊緣快取數據庫 + 算力路由版)
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ==========================================
    // 💡 內部快取 API：專供 Vercel 反向調用，讀寫純文本快取
    // ==========================================
    if (url.pathname === '/api/cache') {
      const token = url.searchParams.get('token');
      const lang = url.searchParams.get('lang');
      if (!token || !lang) return new Response('Missing params', { status: 400 });
      
      const cacheKey = `https://yt-sub-text-cache/v54/${token}/${lang}`;

      // 處理 Vercel 發來的讀取請求
      if (request.method === 'GET') {
        const cachedResp = await caches.default.match(cacheKey);
        if (cachedResp) return cachedResp; // 返回 JSON 文本
        return new Response(null, { status: 404 });
      }
      
      // 處理 Vercel 翻譯完成後的寫入請求
      if (request.method === 'POST') {
        const body = await request.text();
        const resp = new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' }
        });
        // 後台異步寫入，不阻塞網路
        ctx.waitUntil(caches.default.put(cacheKey, resp));
        return new Response('Cache Saved OK');
      }
    }

    // ==========================================
    // 正常 YouTube 請求劫持流程
    // ==========================================
    if (request.method === 'GET') return new Response('Worker V54 (Hybrid Cache & Compute Route)');
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    try {
      const reqBody = new Uint8Array(await request.arrayBuffer());

      // 極低 CPU 消耗的二進制掃描，提取視頻專屬 Token (用作快取 Key)
      function extractReqToken(bytes) {
        const marker = new Uint8Array([80, 65, 109, 111, 100, 101, 114, 110, 95, 116, 114, 97, 110, 115, 99, 114, 105, 112, 116, 95, 118, 105, 101, 119]); 
        for (let i = 0; i <= bytes.length - marker.length; i++) {
          let match = true;
          for (let j = 0; j < marker.length; j++) { if (bytes[i + j] !== marker[j]) { match = false; break; } }
          if (match) {
            const tagIdx = i + marker.length;
            if (bytes[tagIdx] === 0x1a) {
              const len = bytes[tagIdx + 1];
              if (len > 0 && len < 128 && tagIdx + 2 + len <= bytes.length) {
                let idStr = '';
                for (let b of bytes.slice(tagIdx + 2, tagIdx + 2 + len)) idStr += String.fromCharCode(b);
                return idStr;
              }
            }
          }
        }
        return null;
      }
      
      const reqToken = extractReqToken(reqBody) || '';

      const fwd = new Headers();
      const skip = new Set(['host','accept-encoding','content-length','connection','keep-alive',
        'proxy-authenticate','proxy-authorization','te','trailers','transfer-encoding','upgrade',
        'cf-connecting-ip','cf-ray','cf-ew-via','cdn-loop','x-forwarded-for','x-forwarded-proto','x-real-ip']);
      for (const [k, v] of request.headers) { if (!skip.has(k.toLowerCase())) fwd.set(k, v); }
      fwd.set('Accept-Encoding', 'gzip, identity');

      // ⚠️ 核心要求：每次強制向 YouTube 拉取最新鮮、時間戳最準確的 Protobuf
      const ytResp = await fetch('https://youtubei.googleapis.com/youtubei/v1/get_panel', { 
        method: 'POST', headers: fwd, body: reqBody 
      });

      if (!ytResp.ok) return ytResp;
      const isGzip = (ytResp.headers.get('content-encoding') || '').includes('gzip');
      const ytBytes = await ytResp.arrayBuffer();

      // 填寫你的 Vercel 地址 (確保結尾沒有斜槓)
      const vercelUrl = "https://******.vercel.app/api/translate";
      
      // 當前 CF Worker 域名，傳給 Vercel 讓它知道去哪裡讀寫快取
      const cfUrl = url.origin; 

      const vercelResp = await fetch(vercelUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-protobuf',
          'x-target-lang': 'zh-CN,fa',
          'x-gas-urls': JSON.stringify([env.GAS_URL1, env.GAS_URL]),
          'x-is-gzip': isGzip.toString(),
          'x-req-token': reqToken, // 傳遞 Token
          'x-cf-url': cfUrl // 傳遞快取 API 地址
        },
        body: ytBytes // 發送最新鮮的 Protobuf
      });

      if (!vercelResp.ok) {
        console.error("Vercel Node Error");
        return new Response(ytBytes, { status: ytResp.status, headers: ytResp.headers });
      }

      const finalBytes = await vercelResp.arrayBuffer();
      const finalHeaders = new Headers(ytResp.headers);
      finalHeaders.set('Content-Length', finalBytes.byteLength.toString());

      return new Response(finalBytes, { status: ytResp.status, headers: finalHeaders });

    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
  },
};
