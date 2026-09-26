// content-my-listings.js - 注入到 Facebook Marketplace「我的商品/正在出售」管理页面
//
// 之前试过让真实点击不被拦截,借 Facebook 自己弹出的「Your Listing」详情对话框
// 去读标题/价格/编号——能读到,但这个对话框是一个真的会挡住整个页面的弹窗,
// 从弹出到关闭这一小段时间里,用户没法点下一个商品,连续选好几个体验很差(点
// 了第二下,其实点在还没关掉的弹窗背景上,根本没选中)。
//
// 后来发现完全不需要靠这个弹窗:商品管理页里,每一行本身在 Facebook 原始的
// HTML 里就已经带着指向这个商品的真实链接(<a href="/marketplace/item/真实
// 编号">),标题/价格也能从这一行自己的 aria-label / 文字里直接读到——不用点
// 开任何东西。所以现在点击完全拦下来(不让 Facebook 收到这次点击,不会弹出
// 任何东西),直接从这一行本身读完标题/价格/真实编号,立刻把编号交给
// background.js 排队,由它在一个新的后台标签页里打开这个商品的独立页面、真正
// 地把完整表单(类别/成色/描述/图片)读一遍——这一步用的是真实的页面导航,不
// 依赖任何合成点击,足够可靠,也完全不挡当前这个页面,可以一个接一个连续点选。

(function () {
  let selectModeActive = false;

  // network-capture.js 跑在页面自己的 JS 环境(MAIN world),拦到 Facebook 自己
  // 请求 GraphQL 拿到的商品列表数据(每条都带着真实编号),通过 postMessage 转
  // 过来。之前商品编号完全靠从这一行的 <a href="/marketplace/item/编号"> 里
  // 提取——如果某种卡片样式/商品状态下这个链接不是这么写的,提取失败,这条记录
  // 就永远没有真实编号,连"删掉重新选一次"都救不回来,因为重新点同一行会踩
  // 到同一个提取失败。现在多一条后路:提取不到链接时,按标题文字去网络抓到的
  // 商品列表里找一下有没有对得上的,大部分情况下也能找到真实编号。
  const netListings = new Map(); // id -> {title, ...}
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== 'fbma-net-capture' || msg.type !== 'LISTING_DATA' || !msg.id) return;
    netListings.set(msg.id, msg.data);
  });

  function normalizeTitleForMatch(text) {
    return (text || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  }

  function titleOverlapScore(a, b) {
    const wa = new Set(normalizeTitleForMatch(a).split(' ').filter(Boolean));
    const wb = new Set(normalizeTitleForMatch(b).split(' ').filter(Boolean));
    if (!wa.size || !wb.size) return 0;
    let common = 0;
    wa.forEach((w) => {
      if (wb.has(w)) common += 1;
    });
    return common / Math.max(wa.size, wb.size);
  }

  function findIdByTitleMatch(title) {
    if (!title) return null;
    let best = null;
    let bestScore = 0;
    netListings.forEach((info, id) => {
      const score = titleOverlapScore(title, info.title);
      if (score > bestScore) {
        bestScore = score;
        best = id;
      }
    });
    return bestScore >= 0.5 ? best : null;
  }

  // 点选的时候网络那边的数据不一定已经到位(页面可能还在加载),这里最多再
  // 等 1.5 秒,不影响手感——用户点完立刻就能看到"已选中"的反馈,这个等待发生
  // 在拿到反馈**之前**的一瞬间,不会让页面看起来卡住。
  function waitForTitleMatch(title, timeoutMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      const iv = setInterval(() => {
        const id = findIdByTitleMatch(title);
        if (id || Date.now() - start > timeoutMs) {
          clearInterval(iv);
          resolve(id || null);
        }
      }, 200);
    });
  }

  function isActionButtonClick(target) {
    const btn = target.closest('div[role="button"], button, a[role="button"]');
    if (!btn) return false;
    const label = (btn.getAttribute('aria-label') || btn.textContent || '').trim();
    return /mark as sold|share|delete|edit|more|标记为已售出|分享|删除|编辑|更多/i.test(label);
  }

  // 从被点的元素往上找「一整行商品」的边界:role="article" 最理想直接用;
  // 找不到就一层层往上走,一旦某层祖先里出现了第二张图片,说明已经跨出这一行、
  // 跑到装着好几个商品的外层容器里了,就停在上一层。
  function findRowBoundary(target) {
    const article = target.closest('[role="article"]');
    if (article) return article;
    let row = target;
    let node = target;
    let hops = 0;
    while (node && hops < 8) {
      if (node.querySelectorAll('img').length > 1) break;
      row = node;
      node = node.parentElement;
      hops += 1;
    }
    return row;
  }

  const PRICE_RE = /(?:[$€£¥₹]\s?\d[\d,.]*|[A-Z]{2,4}\s?\d[\d,.]*)/;
  // Facebook 的商品链接经常会在 aria-label 里放一整句无障碍朗读文字,格式类似
  // "标题, 价格, 城市, 地区" 这种逗号分隔——参考了公开的 Facebook Marketplace
  // 抓取工具(如 github.com/danyk20/facebook-marketplace-scraper)用同样的字段
  // 顺序解析,这一句如果存在,通常比自己拼行内文字更准。
  const ARIA_RE = /^(?<title>.*?),\s*(?<price>[^,]*\d[^,]*),/;

  function extractQuickInfo(el) {
    const link = el.querySelector ? el.querySelector('a[href*="/marketplace/item/"]') : null;
    const ariaLabel = (link && link.getAttribute('aria-label')) || (el.getAttribute && el.getAttribute('aria-label')) || '';
    const ariaMatch = ariaLabel.match(ARIA_RE);

    const text = (el.innerText || el.textContent || '').trim();
    const img = el.querySelector ? el.querySelector('img') : null;
    const priceMatch = text.match(PRICE_RE);

    let title = ariaMatch && ariaMatch.groups.title.trim();
    if (!title) {
      const heading = el.querySelector && el.querySelector('h1, h2, [role="heading"]');
      if (heading) title = heading.textContent.trim();
    }
    if (!title) {
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      title = lines[0] || '';
      if (!title || (priceMatch && title === priceMatch[0])) {
        const spanTexts = Array.from(el.querySelectorAll('span'))
          .map((s) => s.textContent.trim())
          .filter((t) => t && !(priceMatch && t.includes(priceMatch[0])));
        if (spanTexts.length) title = spanTexts.reduce((a, b) => (b.length > a.length ? b : a), '');
      }
    }

    const priceText = (ariaMatch && ariaMatch.groups.price.trim()) || (priceMatch ? priceMatch[0] : '');
    return { title, priceText, thumbUrl: img ? img.src : '' };
  }

  function extractItemId(el) {
    const link = el.querySelector ? el.querySelector('a[href*="/marketplace/item/"]') : null;
    const m = link && (link.getAttribute('href') || '').match(/\/marketplace\/item\/(\d+)/);
    return m ? m[1] : null;
  }

  function isPlausibleRow(row) {
    return !!(row && (row.querySelector('img') || (row.innerText || '').trim().length > 3));
  }

  function clearHighlight() {
    const prev = document.querySelector('[data-fbma-highlighted="1"]');
    if (prev) {
      prev.style.outline = '';
      prev.style.outlineOffset = '';
      prev.style.cursor = '';
      delete prev.dataset.fbmaHighlighted;
    }
  }

  function highlightRow(row) {
    if (row.dataset.fbmaHighlighted === '1') return;
    clearHighlight();
    row.style.outline = '3px solid #1877f2';
    row.style.outlineOffset = '-2px';
    row.style.cursor = 'pointer';
    row.dataset.fbmaHighlighted = '1';
  }

  // 每一行自己的状态小标签,跟着这一行走,状态变化时原地更新文字和颜色,而不是
  // 每次都重新弹一个新的。
  const rowBadges = new Map();

  function setRowBadge(row, text, color) {
    let badge = rowBadges.get(row);
    if (!badge || !badge.isConnected) {
      badge = document.createElement('div');
      badge.style.cssText =
        'position:absolute;color:#fff;padding:2px 10px;border-radius:10px;font-size:12px;' +
        'z-index:2147483647;pointer-events:none;font-family:sans-serif;';
      document.body.appendChild(badge);
      rowBadges.set(row, badge);
    }
    const rect = row.getBoundingClientRect();
    badge.style.left = rect.left + window.scrollX + 8 + 'px';
    badge.style.top = rect.top + window.scrollY + 8 + 'px';
    badge.style.background = color;
    badge.textContent = text;
    return badge;
  }

  function finishRowBadge(row, text, color, ms = 2500) {
    setRowBadge(row, text, color);
    setTimeout(() => {
      const badge = rowBadges.get(row);
      if (badge) {
        badge.remove();
        rowBadges.delete(row);
      }
      delete row.dataset.fbmaQueued; // 处理完了,允许以后需要的话重新点选(比如想重试)
    }, ms);
  }

  function handleMouseMove(e) {
    if (!selectModeActive) return;
    if (isActionButtonClick(e.target)) {
      clearHighlight();
      return;
    }
    const row = findRowBoundary(e.target);
    if (isPlausibleRow(row)) highlightRow(row);
  }

  async function handleClick(e) {
    if (!selectModeActive) return;
    if (isActionButtonClick(e.target)) return; // 让「标记为已售出」之类的正常按钮照常工作

    const row = findRowBoundary(e.target);
    if (!isPlausibleRow(row)) return;
    if (row.dataset.fbmaQueued === '1') return; // 已经选过/处理中了,别重复加

    // 完全拦下这次点击(不让 Facebook 收到,不会弹出任何东西),直接从这一行
    // 本身读标题/价格/真实商品编号——不用等、不会挡屏幕,可以一个接一个连续点。
    e.preventDefault();
    e.stopPropagation();

    row.dataset.fbmaQueued = '1';
    const quickInfo = extractQuickInfo(row);
    let itemId = extractItemId(row);

    if (!itemId) {
      // 这一行本身的 HTML 里没找到能提取编号的链接——不同卡片样式/商品状态下
      // Facebook 渲染出来的结构不完全一样,靠 <a href> 硬提取不是每次都管用。
      // 退一步用网络抓取到的商品列表,按标题文字找找有没有对得上的,大部分
      // 情况下还是能找到真实编号,不用眼睁睁看着这条记录以后没法自动重新上架。
      itemId = findIdByTitleMatch(quickInfo.title) || (await waitForTitleMatch(quickInfo.title, 1500));
    }

    chrome.runtime.sendMessage({ type: 'QUEUE_DETAIL_READ', itemId, quickInfo }).catch(() => {});
    finishRowBadge(
      row,
      itemId ? '📋 已选中,后台读取详情中...' : '⚠️ 没读到真实商品编号,以后可能没法自动重新上架',
      itemId ? '#1877f2' : '#c0362c',
      itemId ? undefined : 4500
    );
  }

  function activateSelectMode() {
    selectModeActive = true;
    document.addEventListener('mousemove', handleMouseMove, true);
    document.addEventListener('click', handleClick, true);
  }

  function deactivateSelectMode() {
    selectModeActive = false;
    clearHighlight();
    document.removeEventListener('mousemove', handleMouseMove, true);
    document.removeEventListener('click', handleClick, true);
  }

  // 如果用户点了某个商品、页面因为跳转又自动跳回来了,选择模式应该继续开着,
  // 不用每次都重新点「开始点选」——所以状态存在 storage 里,每次脚本加载时读一下。
  chrome.storage.local.get('selectModeActive').then(({ selectModeActive: active }) => {
    if (active) activateSelectMode();
  });

  chrome.runtime.sendMessage({ type: 'CONTENT_READY' }).catch(() => {});

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'PING') {
      sendResponse({ ok: true });
      return;
    }
    if (message.type === 'START_SELECT_MODE') {
      chrome.storage.local.set({ selectModeActive: true });
      activateSelectMode();
      sendResponse({ ok: true });
      return;
    }
    if (message.type === 'STOP_SELECT_MODE') {
      chrome.storage.local.set({ selectModeActive: false });
      deactivateSelectMode();
      sendResponse({ ok: true });
      return;
    }
  });
})();
