// content-my-listings.js - 注入到 Facebook Marketplace「我的商品/正在出售」管理页面
// 负责扫描当前账号所有在售商品的 id / 标题 / 价格 / 缩略图,供「导入」功能使用。
// 只做只读扫描,不会点击或修改任何内容。

(function () {
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function countItemAnchors() {
    return document.querySelectorAll('a[href*="/marketplace/item/"]').length;
  }

  // Facebook 的商品列表经常放在一个自己会滚动的内层容器里,不一定是整个窗口在
  // 滚。先找到第一个商品卡片,再从它往上找真正会滚动的祖先;找不到就退回滚 window。
  function pickScrollTarget() {
    const firstAnchor = document.querySelector('a[href*="/marketplace/item/"]');
    const container = firstAnchor ? findScrollableAncestor(firstAnchor) : null;
    return container || window;
  }

  async function autoScrollToLoadAll(maxRounds = 14) {
    const target = pickScrollTarget();
    let lastCount = -1;
    for (let i = 0; i < maxRounds; i++) {
      if (target === window) {
        window.scrollTo(0, document.body.scrollHeight);
      } else {
        target.scrollTop = target.scrollHeight;
      }
      await sleep(900);
      const count = countItemAnchors();
      if (count === lastCount) break;
      lastCount = count;
    }
    if (target === window) window.scrollTo(0, 0);
    else target.scrollTop = 0;
  }

  // 尝试把扫描范围限定在「正在出售/Selling」这个区块里,避免把页面上其他推荐
  // 商品(不是你自己发的)也扫进来。找不到对应区块就退回扫整个页面。
  function findSellingSection() {
    const headingCandidates = ['selling', 'your listings', '正在出售', '我的商品', '刊登中'];
    const headings = Array.from(document.querySelectorAll('h1, h2, h3, span[role="heading"], div[role="heading"]'));
    for (const h of headings) {
      const t = (h.textContent || '').trim().toLowerCase();
      if (headingCandidates.some((c) => t.includes(c))) {
        // 找一个包含这个标题、同时也包含商品链接的祖先容器
        let node = h.parentElement;
        let hops = 0;
        while (node && hops < 8) {
          if (node.querySelector('a[href*="/marketplace/item/"]')) return node;
          node = node.parentElement;
          hops += 1;
        }
      }
    }
    return null;
  }

  // 卖家自己的「正在出售」页面实测是一行一个商品的列表(缩略图+标题+价格+状态
  // 文字+「Mark as sold / Share / ...」这一排按钮),不是图文卡片网格。价格前面
  // 常常是货币代码而不是货币符号(比如 AED250、USD1,200),不能只认 $ ￥ 这种符号。
  const PRICE_RE = /(?:[$€£¥₹]\s?\d[\d,.]*|[A-Z]{2,4}\s?\d[\d,.]*)/;

  // 从商品链接往上找「行/卡片」边界:role="article" 最理想直接用;找不到就一层层
  // 往上走,只要祖先节点里还只包含这一个商品链接就继续扩大范围,一旦某层祖先
  // 里出现了第二个商品链接,说明已经跨出了这一行、跑到装着好几个商品的外层
  // 容器里了,就停在上一层。
  function findRowBoundary(anchor) {
    const article = anchor.closest('[role="article"]');
    if (article) return article;
    let card = anchor;
    let node = anchor;
    let hops = 0;
    while (node && hops < 8) {
      const linksInside = node.querySelectorAll('a[href*="/marketplace/item/"]').length;
      if (linksInside > 1) break;
      card = node;
      node = node.parentElement;
      hops += 1;
    }
    return card;
  }

  function extractFromRow(row) {
    const text = (row.innerText || row.textContent || '').trim();
    const img = row.querySelector('img');
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const priceMatch = text.match(PRICE_RE);
    return {
      title: lines[0] || '',
      priceText: priceMatch ? priceMatch[0] : lines[1] || '',
      thumbUrl: img ? img.src : '',
    };
  }

  // 策略一:直接按「商品链接」找(最理想,能直接拿到 itemId)
  function scanByItemLinks(scope) {
    const anchors = Array.from(scope.querySelectorAll('a[href*="/marketplace/item/"]'));
    const found = new Map();
    for (const a of anchors) {
      const m = (a.getAttribute('href') || '').match(/\/marketplace\/item\/(\d+)/);
      if (!m) continue;
      const itemId = m[1];
      if (found.has(itemId)) continue;
      const row = findRowBoundary(a);
      const info = extractFromRow(row);
      if (!info.title && !info.priceText && !info.thumbUrl) continue;
      found.set(itemId, { itemId, ...info });
    }
    return found;
  }

  // 策略二(兜底):Facebook 有的版本商品标题可能不是直接可见 href 的 <a>,
  // 改成按每一行都会有的「Mark as sold / 标记为已售出」这类操作按钮定位到行,
  // 再从这一行里找有没有能提取出 itemId 的链接。找不到 itemId 的行就跳过
  // (没有 id 没法定位到具体商品,不能导入)。
  function scanByActionButtons(scope) {
    const buttonCandidates = ['Mark as sold', 'Mark As Sold', '标记为已售出', '标为已售出', '標記為已售出'];
    const buttons = Array.from(
      scope.querySelectorAll('div[role="button"], span[role="button"], button, a[role="button"]')
    ).filter((el) => fbTextMatches(el.getAttribute('aria-label') || el.textContent, buttonCandidates));

    const found = new Map();
    for (const btn of buttons) {
      let node = btn.parentElement;
      let row = null;
      let hops = 0;
      while (node && hops < 10) {
        if (node.querySelector('img')) {
          row = node;
        }
        if (node.querySelectorAll('div[role="button"], button').length > 6) break; // 明显已经跨出这一行
        node = node.parentElement;
        hops += 1;
      }
      if (!row) continue;

      const link = row.querySelector('a[href*="/marketplace/item/"]');
      const m = link && (link.getAttribute('href') || '').match(/\/marketplace\/item\/(\d+)/);
      if (!m) continue;
      const itemId = m[1];
      if (found.has(itemId)) continue;

      const info = extractFromRow(row);
      found.set(itemId, { itemId, ...info });
    }
    return found;
  }

  function scan() {
    const section = findSellingSection();
    const scope = section || document;
    const byLinks = scanByItemLinks(scope);
    const byButtons = scanByActionButtons(scope);
    const merged = new Map([...byButtons, ...byLinks]); // 链接法拿到的信息通常更全,后合并的覆盖前面的

    const items = Array.from(merged.values()).map((it) => ({
      ...it,
      sourceUrl: `https://www.facebook.com/marketplace/item/${it.itemId}/`,
    }));

    const diagnostics = {
      ...collectDiagnostics(),
      foundBySection: !!section,
      foundByItemLinks: byLinks.size,
      foundByActionButtons: byButtons.size,
    };

    return { items, diagnostics };
  }

  chrome.runtime.sendMessage({ type: 'CONTENT_READY' }).catch(() => {});

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'PING') {
      sendResponse({ ok: true });
      return;
    }
    if (message.type === 'SCAN_MY_LISTINGS') {
      autoScrollToLoadAll().then(() => {
        const { items, diagnostics } = scan();
        sendResponse({ ok: true, items, diagnostics });
      });
      return true;
    }
  });
})();
