// network-capture.js - 运行在页面自己的 JS 环境里(Manifest V3 的 "MAIN" world),
// 不是插件平时用的隔离环境,没法直接用 chrome.runtime,靠 window.postMessage 转交
// 给同一个页面里跑在隔离环境的 content-item.js(它能收 postMessage,也能用
// chrome.runtime 存到 storage 里)。
//
// 为什么要多这一层、直接拦网络请求,而不是继续只靠读页面上渲染出来的文字/图片:
// Facebook Marketplace 是一个整页用 GraphQL 拉数据的 React 应用,页面上「看得到」
// 的东西经常是经过处理的——描述被截断成"...查看更多"、图片是缩略图不是原图、
// 类别/成色这种字段是"独立标题+按钮"结构、按钮上还不带字段名——这些都是 DOM
// 层面天生的限制,选择器再怎么调都绕不开,这也是之前反复卡在类别/成色/图片这几
// 个字段上的根本原因。但页面自己请求这些数据时,响应里是完整、没截断过的原始
// 数据。收费的同类插件之所以能做到"选一下就把所有信息都读全了",用的正是这个
// 思路——不跟 Facebook 的界面较劲,直接看它自己后台要到的数据。
//
// 具体做法:包一层 fetch 和 XMLHttpRequest,专盯 Facebook 自己的 /api/graphql/
// 接口。Facebook 内部的字段名没公开、也会变,所以不去猜具体叫什么名字,而是按
// "长得像不像一条商品信息"打分——有没有类似价格的 {amount,currency} 结构、有
// 没有一串图片直链、有没有看起来像成色的字符串——分数够的对象才当作抓到了数据、
// 传出去,这样即使 Facebook 改了内部字段名,大概率还是能抓到,不用每次改版都来
// 改一遍代码。
(function () {
  if (window.__fbmaNetCaptureInstalled) return;
  window.__fbmaNetCaptureInstalled = true;

  const CONDITION_WORDS = /\b(new|used|refurbished|like new)\b|全新|二手|翻新|良好|一般|轻微使用|重度使用/i;
  const IMG_EXT_RE = /\.(jpe?g|png|webp)(\?|$)/i;

  function currentItemIdFromUrl() {
    const m = location.pathname.match(/\/marketplace\/item\/(\d+)/);
    return m ? m[1] : null;
  }

  function stripJsonSafetyPrefix(text) {
    // Facebook 部分接口会在真正的 JSON 前面加一段防 JSON 劫持的前缀,常见的是
    // "for (;;);",不是每个接口都有,没有也不影响后面的解析。
    return text.replace(/^\s*for\s*\(\s*;\s*;\s*\)\s*;/, '');
  }

  function parseMaybeMultiJson(text) {
    const cleaned = stripJsonSafetyPrefix(text).trim();
    if (!cleaned) return [];
    const results = [];
    // GraphQL 的流式/分片响应经常是"一行一个 JSON 对象",不是一整个数组包起来
    if (cleaned.indexOf('\n') >= 0) {
      for (const line of cleaned.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          results.push(JSON.parse(t));
        } catch (e) {
          // 这一行不是独立的 JSON,忽略,不影响其他行
        }
      }
    }
    if (!results.length) {
      try {
        results.push(JSON.parse(cleaned));
      } catch (e) {
        // 彻底解析不了就放弃这条响应,不是每个 /api/graphql/ 请求都跟商品有关
      }
    }
    return results;
  }

  function looksLikePriceObj(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    return (
      typeof v.formatted_amount === 'string' ||
      (v.currency_amount && typeof v.currency_amount === 'object') ||
      (typeof v.amount === 'string' && /^\d+$/.test(v.amount))
    );
  }

  function extractPriceText(v) {
    if (typeof v.formatted_amount === 'string') return v.formatted_amount;
    if (v.currency_amount && typeof v.currency_amount.formatted_amount === 'string') return v.currency_amount.formatted_amount;
    if (typeof v.amount === 'string') return v.amount;
    return '';
  }

  function imageUrlFromItem(item) {
    if (!item || typeof item !== 'object') return null;
    const candidates = [item.uri, item.url, item.src, item.image && item.image.uri, item.original_image && item.original_image.uri];
    for (const c of candidates) {
      if (typeof c === 'string' && /^https?:\/\//.test(c) && IMG_EXT_RE.test(c)) return c;
    }
    return null;
  }

  function looksLikePhotoArray(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return false;
    let hits = 0;
    for (const item of arr.slice(0, 6)) {
      if (imageUrlFromItem(item)) hits += 1;
    }
    return hits > 0;
  }

  function extractPhotoUrls(arr) {
    const urls = [];
    const seen = new Set();
    for (const item of arr) {
      const u = imageUrlFromItem(item);
      if (u && !seen.has(u)) {
        seen.add(u);
        urls.push(u);
      }
    }
    return urls;
  }

  function extractListingId(obj) {
    for (const key of ['marketplace_listing_id', 'listing_id', 'id']) {
      const v = obj[key];
      if (typeof v === 'string' && /^\d{6,}$/.test(v)) return v;
      if (typeof v === 'number' && String(v).length >= 6) return String(v);
    }
    return null;
  }

  // 累积每个商品编号目前抓到的最佳字段集合——同一个页面里,不同的 GraphQL 请求
  // 经常各带一部分字段(比如翻页/懒加载图片会单独发一次请求),不是一次性全给,
  // 所以要合并而不是每次覆盖;只在新字段"更完整"(比如图片更多、之前是空的)
  // 时才更新那个字段,避免后来某个只带局部信息的请求把已经读到的完整数据冲掉。
  const bestById = new Map();

  function mergeAndEmit(id, found) {
    const prev = bestById.get(id) || {};
    const merged = { ...prev };
    let changed = false;
    for (const key of Object.keys(found)) {
      const nv = found[key];
      const ov = merged[key];
      const better = Array.isArray(nv) ? !ov || nv.length > ov.length : !ov && nv;
      if (better) {
        merged[key] = nv;
        changed = true;
      }
    }
    if (!changed) return;
    bestById.set(id, merged);
    window.postMessage({ source: 'fbma-net-capture', type: 'LISTING_DATA', id, data: merged }, '*');
  }

  function scoreAndCollect(obj, seen, fallbackId) {
    if (!obj || typeof obj !== 'object' || seen.has(obj)) return;
    if (seen.size > 4000) return; // 保险丝,极端情况下避免一条巨大响应把页面卡死
    seen.add(obj);

    let score = 0;
    const found = {};

    for (const key of Object.keys(obj)) {
      let v;
      try {
        v = obj[key];
      } catch (e) {
        continue;
      }
      if (v == null) continue;
      const lk = key.toLowerCase();

      if (!found.title && typeof v === 'string' && lk.indexOf('title') >= 0 && v.length >= 2 && v.length <= 200 && v.indexOf('\n') < 0) {
        found.title = v;
        score += 2;
      }
      if (!found.description && typeof v === 'string' && lk.indexOf('description') >= 0 && v.length > 0) {
        found.description = v;
        score += 2;
      }
      if (!found.price && looksLikePriceObj(v)) {
        const priceText = extractPriceText(v);
        if (priceText) {
          found.price = priceText;
          score += 2;
        }
      }
      if (!found.condition && typeof v === 'string' && lk.indexOf('condition') >= 0 && v.length < 40) {
        found.condition = v;
        score += 2;
      }
      if (!found.condition && typeof v === 'string' && v.length < 30 && CONDITION_WORDS.test(v)) {
        found.condition = v;
        score += 1;
      }
      if (!found.category && typeof v === 'string' && lk.indexOf('category') >= 0 && v.length >= 2 && v.length < 80) {
        found.category = v;
        score += 1;
      }
      if (!found.location && typeof v === 'string' && /location|city_page|reverse_geocode/.test(lk) && v.length >= 2 && v.length < 80) {
        found.location = v;
        score += 1;
      }
      if (!found.photos && looksLikePhotoArray(v)) {
        const urls = extractPhotoUrls(v);
        if (urls.length) {
          found.photos = urls;
          score += 3;
        }
      }

      if (typeof v === 'object') {
        if (Array.isArray(v)) {
          for (const item of v.slice(0, 40)) scoreAndCollect(item, seen, fallbackId);
        } else {
          scoreAndCollect(v, seen, fallbackId);
        }
      }
    }

    if (score >= 3) {
      const id = extractListingId(obj) || fallbackId;
      if (id) mergeAndEmit(id, found);
    }
  }

  function handleResponseText(text) {
    if (!text || text.length < 20) return;
    const fallbackId = currentItemIdFromUrl();
    const objs = parseMaybeMultiJson(text);
    const seen = new Set();
    for (const obj of objs) scoreAndCollect(obj, seen, fallbackId);
  }

  // ── fetch ──
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (...args) {
      const p = origFetch.apply(this, args);
      try {
        const first = args[0];
        const url = typeof first === 'string' ? first : (first && first.url) || '';
        if (/\/api\/graphql\//.test(url)) {
          p.then((res) => {
            try {
              res
                .clone()
                .text()
                .then(handleResponseText)
                .catch(() => {});
            } catch (e) {
              // res.clone() 在个别情况下(响应体已经被读过)会抛错,不影响页面本身继续用这个响应
            }
          }).catch(() => {});
        }
      } catch (e) {
        // 拦截逻辑本身出错也不能影响页面正常发请求,原始 fetch 调用已经在上面发出去了
      }
      return p;
    };
  }

  // ── XMLHttpRequest ──
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__fbmaUrl = url;
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    if (this.__fbmaUrl && /\/api\/graphql\//.test(String(this.__fbmaUrl))) {
      this.addEventListener('load', function () {
        try {
          handleResponseText(this.responseText);
        } catch (e) {}
      });
    }
    return origSend.apply(this, args);
  };
})();
