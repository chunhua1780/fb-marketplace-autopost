// content-my-listings.js - 注入到 Facebook Marketplace「我的商品/正在出售」管理页面
//
// 根据真实截图确认:在这个页面点一行商品,Facebook 会弹出一个「Your Listing」
// 详情对话框(不是跳转到新页面),对话框里有 Edit Listing / Delete listing 这些
// 按钮。之前的版本想拦截这次点击、自己去拼网址,结果对话框还是弹出来了,把整个
// 页面挡住,用户点不了别的,插件却毫无反应,体验很差。
//
// 现在换个思路:不再拦截点击,直接顺着 Facebook 弹出的这个对话框走——从对话框
// 里读基本信息,点它自带的「Edit Listing」展开完整表单,把标题/价格/类别/成色/
// 描述/图片一次性读完,然后自动把对话框关掉,页面回到列表、可以继续点下一个。
// 一次点击就能拿到完整信息,不再需要「先选,最后再统一导入」这种两阶段流程。

(function () {
  let selectModeActive = false;
  let processing = false; // 防止上一个还没处理完,又点了下一个导致相互干扰

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

  function showBadge(row, text, color) {
    const badge = document.createElement('div');
    badge.textContent = text;
    badge.style.cssText =
      `position:absolute;background:${color};color:#fff;padding:2px 10px;border-radius:10px;` +
      'font-size:12px;z-index:2147483647;pointer-events:none;font-family:sans-serif;transition:opacity .3s;';
    const rect = row.getBoundingClientRect();
    badge.style.left = rect.left + window.scrollX + 8 + 'px';
    badge.style.top = rect.top + window.scrollY + 8 + 'px';
    document.body.appendChild(badge);
    return badge;
  }

  function closeAnyOverlay() {
    const dialog = document.querySelector('[role="dialog"]');
    if (dialog) {
      const closeBtn =
        dialog.querySelector('[aria-label="Close" i]') || findClickableByText(['Close', '关闭', '關閉'], dialog);
      if (closeBtn) {
        closeBtn.click();
        return;
      }
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
  }

  async function saveImportedListing(itemId, data) {
    const listings = await getListings();
    if (!listings.some((l) => l.sourceItemId === itemId)) {
      listings.push(
        genListing({
          title: data.title || '',
          price: data.price || data.priceText || '',
          category: data.category || '',
          condition: data.condition || '',
          description: data.description || '',
          location: data.location || '',
          photos: data.photos || [],
          sourceItemId: itemId,
          sourceUrl: `https://www.facebook.com/marketplace/item/${itemId}/`,
          status: 'imported',
          importedAt: Date.now(),
        })
      );
      await saveListings(listings);
    }
    await appendLog({ level: 'success', text: `已导入:「${data.title || itemId}」` });
  }

  // 点一行商品之后:顺着 Facebook 自己弹出的详情对话框走——读基本信息,点它的
  // 「Edit Listing」展开完整表单读全部字段,再把对话框关掉。对话框没弹出来的
  // 极少数情况,退回旧办法:能直接从这一行拿到商品链接就直接存,拿不到就记下
  // 「回来的网址」放行这次点击,让 Facebook 自己决定怎么跳,content-item.js 落地
  // 后会接着处理。
  async function captureFromClick(row) {
    const rowInfo = extractQuickInfo(row);
    const badge = showBadge(row, '⏳ 正在读取...', '#1877f2');

    try {
      const dialog = await waitFor(() => document.querySelector('[role="dialog"]'), { timeout: 4000 });

      if (!dialog) {
        const link = row.querySelector('a[href*="/marketplace/item/"]');
        const m = link && (link.getAttribute('href') || '').match(/\/marketplace\/item\/(\d+)/);
        if (m) {
          await saveImportedListing(m[1], rowInfo);
          badge.textContent = '✅ 已导入';
          badge.style.background = '#16794d';
        } else {
          chrome.storage.local.set({ pendingClickCapture: { ...rowInfo, returnUrl: location.href } });
          badge.textContent = '↪️ 正在跳转确认...';
        }
        setTimeout(() => badge.remove(), 1500);
        return;
      }

      const dialogInfo = extractQuickInfo(dialog);
      const dialogLink = dialog.querySelector('a[href*="/marketplace/item/"]');
      let itemId = null;
      const dm = dialogLink && (dialogLink.getAttribute('href') || '').match(/\/marketplace\/item\/(\d+)/);
      if (dm) itemId = dm[1];

      const editBtn = findClickableByText(FB_LABELS.editListing, dialog);
      let full = null;
      if (editBtn) {
        editBtn.click();
        await fbSleep(1000);
        const ready = await waitFor(() => findFieldByLabel(FB_LABELS.title), { timeout: 8000 });
        if (ready) {
          full = await scrapeVisibleListingForm();
          if (!itemId) {
            const urlMatch = location.href.match(/\/marketplace\/item\/(\d+)/);
            if (urlMatch) itemId = urlMatch[1];
          }
        }
      }

      closeAnyOverlay();
      await fbSleep(400);

      const data = full || dialogInfo || rowInfo;
      if (!itemId) {
        badge.textContent = '⚠️ 没识别到商品编号';
        badge.style.background = '#c0362c';
        await appendLog({
          level: 'error',
          text: `「${data.title || '商品'}」没能确认到商品编号,已跳过,请手动处理。`,
        });
      } else {
        await saveImportedListing(itemId, data);
        badge.textContent = '✅ 已导入';
        badge.style.background = '#16794d';
      }
      setTimeout(() => badge.remove(), 1500);
    } catch (err) {
      badge.textContent = '⚠️ 出错了';
      badge.style.background = '#c0362c';
      setTimeout(() => badge.remove(), 1500);
      await appendLog({ level: 'error', text: `导入「${rowInfo.title || '商品'}」时出错: ${(err && err.message) || err}` });
      closeAnyOverlay();
    }
  }

  function handleMouseMove(e) {
    if (!selectModeActive || processing) return;
    if (isActionButtonClick(e.target)) {
      clearHighlight();
      return;
    }
    const row = findRowBoundary(e.target);
    if (isPlausibleRow(row)) highlightRow(row);
  }

  async function handleClick(e) {
    if (!selectModeActive || processing) return;
    if (isActionButtonClick(e.target)) return; // 让「标记为已售出」之类的正常按钮照常工作

    const row = findRowBoundary(e.target);
    if (!isPlausibleRow(row)) return;

    processing = true;
    try {
      await captureFromClick(row);
    } finally {
      processing = false;
    }
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
