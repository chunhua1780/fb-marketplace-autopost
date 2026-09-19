// content-my-listings.js - 注入到 Facebook Marketplace「我的商品/正在出售」管理页面
// 负责扫描当前账号所有在售商品的 id / 标题 / 价格 / 缩略图,供「导入」功能使用。
// 只做只读扫描,不会点击或修改任何内容。

(function () {
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Marketplace 的「我的商品」列表通常是滚动加载的,先滚到底触发把所有卡片加载出来
  async function autoScrollToLoadAll(maxRounds = 10) {
    let lastCount = -1;
    for (let i = 0; i < maxRounds; i++) {
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(800);
      const count = document.querySelectorAll('a[href*="/marketplace/item/"]').length;
      if (count === lastCount) break;
      lastCount = count;
    }
    window.scrollTo(0, 0);
  }

  function scan() {
    const anchors = Array.from(document.querySelectorAll('a[href*="/marketplace/item/"]'));
    const seen = new Set();
    const items = [];
    for (const a of anchors) {
      const m = (a.getAttribute('href') || '').match(/\/marketplace\/item\/(\d+)/);
      if (!m) continue;
      const itemId = m[1];
      if (seen.has(itemId)) continue;
      seen.add(itemId);

      const card = a.closest('[role="article"]') || a;
      const text = (card.innerText || card.textContent || '').trim();
      const img = card.querySelector('img');
      items.push({
        itemId,
        title: text.split('\n')[0] || '',
        priceText: (text.match(/[$￥][0-9,.]+/) || [''])[0],
        thumbUrl: img ? img.src : '',
        sourceUrl: `https://www.facebook.com/marketplace/item/${itemId}/`,
      });
    }
    return items;
  }

  chrome.runtime.sendMessage({ type: 'CONTENT_READY' }).catch(() => {});

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'SCAN_MY_LISTINGS') {
      autoScrollToLoadAll().then(() => sendResponse({ ok: true, items: scan() }));
      return true;
    }
  });
})();
