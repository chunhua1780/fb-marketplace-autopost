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

  // 从商品链接往上找「卡片」边界:role="article" 最理想直接用;找不到就一层层
  // 往上走,只要祖先节点里还只包含这一个商品链接就继续扩大范围,一旦某层祖先
  // 里出现了第二个商品链接,说明已经跨出了这张卡片、跑到装着好几张卡片的外层
  // 容器里了,就停在上一层。
  function extractCard(anchor) {
    const article = anchor.closest('[role="article"]');
    let card = article || anchor;
    if (!article) {
      let node = anchor;
      let hops = 0;
      while (node && hops < 6) {
        const linksInside = node.querySelectorAll('a[href*="/marketplace/item/"]').length;
        if (linksInside > 1) break;
        card = node;
        node = node.parentElement;
        hops += 1;
      }
    }
    const text = (card.innerText || card.textContent || '').trim();
    const img = card.querySelector('img');
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    return {
      title: lines[0] || '',
      priceText: (text.match(/[$￥][0-9,.]+/) || [''])[0],
      thumbUrl: img ? img.src : '',
    };
  }

  function scan() {
    const scope = findSellingSection() || document;
    const anchors = Array.from(scope.querySelectorAll('a[href*="/marketplace/item/"]'));
    const seen = new Set();
    const items = [];
    for (const a of anchors) {
      const m = (a.getAttribute('href') || '').match(/\/marketplace\/item\/(\d+)/);
      if (!m) continue;
      const itemId = m[1];
      if (seen.has(itemId)) continue;
      seen.add(itemId);

      const { title, priceText, thumbUrl } = extractCard(a);
      if (!title && !priceText && !thumbUrl) continue; // 明显不是一张商品卡片,跳过

      items.push({
        itemId,
        title,
        priceText,
        thumbUrl,
        sourceUrl: `https://www.facebook.com/marketplace/item/${itemId}/`,
      });
    }
    return items;
  }

  chrome.runtime.sendMessage({ type: 'CONTENT_READY' }).catch(() => {});

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'SCAN_MY_LISTINGS') {
      autoScrollToLoadAll().then(() => {
        const items = scan();
        sendResponse({ ok: true, items, diagnostics: collectDiagnostics() });
      });
      return true;
    }
  });
})();
