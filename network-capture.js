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

  // 商品详情页网址里就带着编号,天然只有一个"当前商品"。但"你的商品"管理
  // 列表页不一样——网址本身不带任何商品编号,一页上同时有好几十个商品,
  // 这种页面上"体积最大的几条就是想要的数据"这个假设完全不成立(实测已经
  // 证实过:分享对话框、输入建议这些无关功能预加载的数据经常比真正的商品
  // 数据大得多)。这里换一个思路:不管当前是详情页还是列表页,直接从页面
  // 自己的 DOM 里,把所有目前已经渲染出来、带着真实编号的商品链接都读一遍
  // (这一步就是普通的 DOM 查询,MAIN world 里跟隔离环境一样能访问同一个
  // 页面),响应文字里只要提到了这些已知编号里的任意一个,就当作强烈信号,
  // 优先当作样本——比单纯看响应体积大小精准得多。
  function knownItemIdsOnPage() {
    const ids = new Set();
    const urlId = currentItemIdFromUrl();
    if (urlId) ids.add(urlId);
    document.querySelectorAll('a[href*="/marketplace/item/"]').forEach((a) => {
      const m = (a.getAttribute('href') || '').match(/\/marketplace\/item\/(\d+)/);
      if (m) ids.add(m[1]);
    });
    return ids;
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
    // GraphQL 的列表经常是 {edges:[{node:{...}}]} 这种"连接"结构,真正的图片
    // 字段在 node 里面又包一层,所以 node 本身也当作一个候选对象再找一遍。
    const n = item.node && typeof item.node === 'object' ? item.node : item;
    const candidates = [n.uri, n.url, n.src, n.image && n.image.uri, n.original_image && n.original_image.uri];
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

    // 门槛从 3 降到 2:在商品详情页(有 fallbackId 兜底)问题不大,反正是往同一个
    // id 上合并字段,弱匹配顶多贡献一个字段,不会把已经读到的更好的数据冲掉;
    // 在"你的商品"列表页(没有 fallbackId,必须对象自己带 id 字段才算数)放宽
    // 门槛更重要——列表页一张商品卡片经常只有"标题+编号"或者"价格+编号"这种
    // 比较单薄的结构,门槛卡在 3 会导致大量真实商品完全抓不到、白白浪费了它们
    // 自带的真实编号。
    if (score >= 2) {
      const id = extractListingId(obj) || fallbackId;
      if (id) mergeAndEmit(id, found);
    }
  }

  // 排查用的计数器:不管有没有真的抓到"像商品信息"的数据,只要拦到了一次
  // /api/graphql/ 的响应就 +1、顺手广播一下当前计数。以后要是又出现"读取
  // 详情彻底失败"这种情况,靠这个能马上分清楚是两种完全不同的问题:一种是
  // 这个页面上根本没拦到任何 GraphQL 响应(说明这层拦截机制本身没生效,比如
  // Chrome 版本太旧不支持 MAIN world 注入),另一种是拦到了不少响应、但没有
  // 一个长得像商品信息(说明拦截机制本身是好的,只是这次的打分规则没認出来,
  // 需要调整认的规则,而不是怀疑整个思路)——这两种问题的排查方向完全不同。
  let graphqlSeenCount = 0;

  // 排查用的原始数据样本:每次拦到响应,不管有没有打出分,都留一份「有没有希望
  // 是商品数据」的样本——只留体积最大的几条(真正的商品详情数据量通常比页面上
  // 一堆小的埋点/已读回执请求大得多,这样留下来的大概率就是真正想找的那条),
  // 每条只截前 2000 字(信息量已经够看出字段长什么样,又不会把整个响应的其他
  // 用户隐私内容都塞进去)。之前打分规则死活认不出真实数据时,只能靠我自己
  // 凭经验瞎猜字段名,一次次改一次次错——有这份真实样本以后,只要用户导出发
  // 过来,就能直接照着真实数据把打分规则改对,不用再猜。
  const MAX_SAMPLES = 3;
  const SAMPLE_TRUNC = 2000;
  let rawSamples = [];

  // 挑样本时,"体积最大的几条"这个排序方式实测证明是错的:商品详情页上经常
  // 还预加载着分享对话框(@提及好友的自动补全、隐私选择器这些),这些东西
  // 随随便便就是几十万字符,比真正的商品数据(一个标题/价格/类别/几张图的
  // 链接)大得多——体积最大的几条几乎全是这些无关的分享/输入建议数据,真正
  // 想要的商品数据反而被挤出了样本之外。改成优先挑"响应文字里出现了当前
  // 商品编号"的那些——真正描述这个商品的接口,响应里几乎一定会带着这个商品
  // 自己的编号(不管是当参数回显、还是当字段值),这比"体积大不大"精准太多。
  // 同样带编号的里面还有好几条,再按体积从小到大排——越小的越可能是只聚焦
  // 这一个商品的精简接口,不是又混进了一堆无关内容的大杂烩接口。
  function recordSample(text, knownIds) {
    let mentionsItem = false;
    knownIds.forEach((id) => {
      if (!mentionsItem && text.indexOf(id) >= 0) mentionsItem = true;
    });
    const entry = {
      length: text.length,
      mentionsItem,
      sample: text.length > SAMPLE_TRUNC ? text.slice(0, SAMPLE_TRUNC) + '…(截断)' : text,
    };
    rawSamples.push(entry);
    rawSamples.sort((a, b) => {
      if (a.mentionsItem !== b.mentionsItem) return a.mentionsItem ? -1 : 1;
      return a.mentionsItem ? a.length - b.length : b.length - a.length;
    });
    rawSamples = rawSamples.slice(0, MAX_SAMPLES);
  }

  function handleResponseText(text) {
    if (!text || text.length < 20) return;
    graphqlSeenCount += 1;
    const fallbackId = currentItemIdFromUrl();
    recordSample(text, knownItemIdsOnPage());
    window.postMessage({ source: 'fbma-net-capture', type: 'GRAPHQL_SEEN', count: graphqlSeenCount, samples: rawSamples }, '*');
    const objs = parseMaybeMultiJson(text);
    const seen = new Set();
    for (const obj of objs) scoreAndCollect(obj, seen, fallbackId);
  }

  // 重要发现:实测拦到的响应里,唯一真正带着当前商品编号的一条,只是一个
  // "标记为已浏览过"的小小埋点请求(251字节),根本不是商品详情本身。这说明
  // 商品详情页的真正数据,压根就没有走一次"页面加载完之后再单独发一次请求"
  // 这种客户端 fetch/XHR——很可能 Facebook 在服务器端直接把这些数据渲染
  // 进了最初的 HTML 文档本身(这是 Facebook 广泛使用的一种技术,叫 BigPipe:
  // 把大块数据当作 <script type="application/json"> 标签,分批直接嵌在
  // HTML 里跟着页面一起吐出来,而不是等页面显示出来之后浏览器再单独去问一次
  // 服务器要)。这种数据从来不经过 fetch/XMLHttpRequest,不管怎么拦网络请求
  // 都不可能拦到——之前一直在拦网络请求这一件事上死磕,方向本身就漏了一半。
  //
  // 现在多加一条路:直接扫页面自己 DOM 里所有 <script type="application/
  // json"> 标签,内容按跟网络响应完全一样的打分规则处理一遍。BigPipe 是分批
  // 陆续把这些 <script> 标签插进页面的(不是一次性全部到位),所以要在页面
  // 加载后的几个时间点各扫一次,不能只扫一次就完事。
  function scanEmbeddedJsonScripts() {
    const scripts = document.querySelectorAll('script[type="application/json"]');
    if (!scripts.length) return;
    const fallbackId = currentItemIdFromUrl();
    const knownIds = knownItemIdsOnPage();
    const seen = new Set();
    scripts.forEach((script) => {
      const text = script.textContent;
      if (!text || text.length < 20) return;
      graphqlSeenCount += 1;
      recordSample(text, knownIds);
      let obj;
      try {
        obj = JSON.parse(text);
      } catch (e) {
        return;
      }
      scoreAndCollect(obj, seen, fallbackId);
    });
    window.postMessage({ source: 'fbma-net-capture', type: 'GRAPHQL_SEEN', count: graphqlSeenCount, samples: rawSamples }, '*');
  }

  [400, 1200, 2500, 4500, 7000].forEach((ms) => setTimeout(scanEmbeddedJsonScripts, ms));

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
