// content-my-listings.js - 注入到 Facebook Marketplace「我的商品/正在出售」管理页面
//
// 之前的做法是靠代码去猜页面上哪些元素是"商品卡片",反复验证下来这种纯靠猜的
// 方式对不同账号/版本的页面结构太不可靠。现在换成「点选式导入」:打开选择模式
// 后,把鼠标移到你自己的商品上会高亮,点一下就选中——是你在指认"这是我的商品",
// 不是代码在瞎猜。
//
// 大多数情况下能直接从被点的这一行里找到指向商品详情页的链接,当场就能拿到
// 商品 id,不需要跳转。极少数情况下如果这一行里确实没有能识别出 id 的链接,
// 就让这次点击正常发生(不拦截),Facebook 自己知道怎么跳到对应商品页——等页面
// 跳过去之后,由 content-item.js 从当时的网址里读出真正的 id,和刚才记下来的
// 标题/价格/缩略图拼在一起,再自动跳回列表页,不用你自己点后退。

(function () {
  let selectModeActive = false;

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

  function extractFromRow(row) {
    const link = row.querySelector('a[href*="/marketplace/item/"]');
    const ariaLabel = (link && link.getAttribute('aria-label')) || row.getAttribute('aria-label') || '';
    const ariaMatch = ariaLabel.match(ARIA_RE);

    const text = (row.innerText || row.textContent || '').trim();
    const img = row.querySelector('img');
    const priceMatch = text.match(PRICE_RE);

    let title = ariaMatch && ariaMatch.groups.title.trim();
    if (!title) {
      // 退回按行取第一行;如果第一行看起来不像标题(太短、或者就是价格本身),
      // 改成取这一行里所有 <span> 文字里最长的那一段(价格/地点通常比标题短)。
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      title = lines[0] || '';
      if (!title || (priceMatch && title === priceMatch[0])) {
        const spanTexts = Array.from(row.querySelectorAll('span'))
          .map((s) => s.textContent.trim())
          .filter((t) => t && !(priceMatch && t.includes(priceMatch[0])));
        if (spanTexts.length) title = spanTexts.reduce((a, b) => (b.length > a.length ? b : a), '');
      }
    }

    const priceText = (ariaMatch && ariaMatch.groups.price.trim()) || (priceMatch ? priceMatch[0] : '');

    return { title, priceText, thumbUrl: img ? img.src : '' };
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

  function flashConfirm(row) {
    const badge = document.createElement('div');
    badge.textContent = '✅ 已选中';
    badge.style.cssText =
      'position:absolute;background:#16794d;color:#fff;padding:2px 10px;border-radius:10px;' +
      'font-size:12px;z-index:2147483647;pointer-events:none;font-family:sans-serif;';
    const rect = row.getBoundingClientRect();
    badge.style.left = rect.left + window.scrollX + 8 + 'px';
    badge.style.top = rect.top + window.scrollY + 8 + 'px';
    document.body.appendChild(badge);
    setTimeout(() => badge.remove(), 1300);
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

  function handleClick(e) {
    if (!selectModeActive) return;
    if (isActionButtonClick(e.target)) return; // 让「标记为已售出」之类的正常按钮照常工作

    const row = findRowBoundary(e.target);
    if (!isPlausibleRow(row)) return;

    const link = row.querySelector('a[href*="/marketplace/item/"]');
    const m = link && (link.getAttribute('href') || '').match(/\/marketplace\/item\/(\d+)/);
    const info = extractFromRow(row);

    if (m) {
      // 这一行里直接就能拿到商品 id,不用跳转
      e.preventDefault();
      e.stopPropagation();
      const itemId = m[1];
      chrome.runtime.sendMessage({
        type: 'PRODUCT_SELECTED',
        item: { itemId, ...info, sourceUrl: `https://www.facebook.com/marketplace/item/${itemId}/` },
      });
      flashConfirm(row);
      return;
    }

    // 这一行里没找到能识别的链接:记下已经提取到的信息和「回来的网址」,
    // 然后不拦截,让这次点击照常发生——去到商品详情页之后,content-item.js
    // 会从那个页面的真实网址里读出 id,把信息拼起来,再自动跳回这个页面。
    chrome.storage.local.set({
      pendingClickCapture: { ...info, returnUrl: location.href },
    });
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

  // 如果用户点了某个商品、跳转到详情页又自动跳回来了,选择模式应该继续开着,
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
