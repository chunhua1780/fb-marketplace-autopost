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

  // 在对话框里找「关闭」按钮:有文字/aria-label 的最好找;很多关闭按钮其实只是
  // 一个没有文字的小图标,这种就退回按位置猜——对话框右上角那个巴掌大的按钮,
  // 十有八九就是它。
  function findDialogCloseButton(dialog) {
    const byLabel =
      dialog.querySelector('[aria-label="Close" i]') ||
      dialog.querySelector('[aria-label*="close" i]') ||
      findClickableByText(['Close', '关闭', '關閉'], dialog);
    if (byLabel) return byLabel;

    const dialogRect = dialog.getBoundingClientRect();
    const candidates = Array.from(dialog.querySelectorAll('div[role="button"], span[role="button"]'))
      .map((el) => ({ el, rect: el.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 4 && rect.width < 44 && rect.height > 4 && rect.height < 44)
      .filter(({ rect }) => rect.top - dialogRect.top < 60 && dialogRect.right - rect.right < 60);
    return candidates.length ? candidates[0].el : null;
  }

  // 关掉当前弹出的对话框,并且真的等它消失了再返回——点了关闭按钮不代表立刻
  // 就关了,之前只点一下就默认成功,导致对话框其实还开着、把下一次点选卡住。
  async function closeAnyOverlay() {
    for (let attempt = 0; attempt < 2; attempt++) {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return true;

      const closeBtn = findDialogCloseButton(dialog);
      if (closeBtn) {
        closeBtn.click();
      } else {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
      }
      const gone = await waitFor(() => !document.querySelector('[role="dialog"]'), { timeout: 2500 });
      if (gone) return true;
    }
    return !document.querySelector('[role="dialog"]');
  }

  // itemId 是 Facebook 那边的真实商品编号,只用在两个地方:导入去重、以及
  // 「重新上架后自动删除旧版本」。读不到也完全不影响导入——标题/价格/图片这些
  // 读到了就先存下来,用插件自己的编号(genListing 里自动生成)管理,后面
  // 「重新上架」照样能用,只是少了「自动删除 Facebook 上那条旧的」这一个可选
  // 功能而已。之前的版本读不到 itemId 就整条数据都不存,才是「读一个丢一个」
  // 的真正原因。
  async function saveImportedListing(itemId, data) {
    const listings = await getListings();
    if (itemId && listings.some((l) => l.sourceItemId === itemId)) {
      return; // 这个 Facebook 商品已经导入过了,不用重复存
    }
    listings.push(
      genListing({
        title: data.title || '',
        price: data.price || data.priceText || '',
        category: data.category || '',
        condition: data.condition || '',
        description: data.description || '',
        location: data.location || '',
        photos: data.photos || [],
        sourceItemId: itemId || null,
        sourceUrl: itemId ? `https://www.facebook.com/marketplace/item/${itemId}/` : null,
        status: 'imported',
        importedAt: Date.now(),
      })
    );
    await saveListings(listings);
    await appendLog({
      level: 'success',
      text: `已导入:「${data.title || itemId || '商品'}」${itemId ? '' : '(没能确认到 Facebook 原始编号,重新上架后不能自动删除旧版本,其他功能不受影响)'}`,
    });
  }

  // 点一行商品之后:顺着 Facebook 自己弹出的详情对话框走——读基本信息,点它的
  // 「Edit Listing」展开完整表单读全部字段,再把对话框关掉。不管每一步能读到
  // 多完整,最后都会存下来(存不到 Facebook 真实编号就用插件自己的编号),不会
  // 因为某一项信息缺失就把整条数据丢掉。
  async function captureFromClick(row) {
    const rowInfo = extractQuickInfo(row);
    const badge = showBadge(row, '⏳ 正在读取...', '#1877f2');

    try {
      const dialog = await waitFor(() => document.querySelector('[role="dialog"]'), { timeout: 4000 });

      if (!dialog) {
        // 没弹出详情对话框(少见情况):能从这一行直接拿到商品链接就用真实编号,
        // 拿不到就直接用插件自己的编号存——标题/价格/缩略图这些能读到多少算多少,
        // 不再为了等一个可能压根不会发生的跳转而把这条数据一直悬着不存。
        const link = row.querySelector('a[href*="/marketplace/item/"]');
        const m = link && (link.getAttribute('href') || '').match(/\/marketplace\/item\/(\d+)/);
        await saveImportedListing(m ? m[1] : null, rowInfo);
        badge.textContent = m ? '✅ 已导入' : '✅ 已导入(无 FB 编号)';
        badge.style.background = '#16794d';
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
        // 点「Edit Listing」这一下,有的账号/版本是原地展开表单,有的可能会
        // 整页跳转到别的编辑页——跳转的话这个页面的 JS 会被直接终止,后面的代码
        // 根本不会执行到。所以点之前先把已知信息存一份;真的跳走了,
        // content-item.js 落地后能接手继续读完、再自动跳回来;原地展开成功的话,
        // 下面会把这份记录清掉,不会重复处理。
        await chrome.storage.local.set({
          pendingClickCapture: {
            ...(dialogInfo.title ? dialogInfo : rowInfo),
            returnUrl: location.href,
            capturedAt: Date.now(),
          },
        });

        editBtn.click();
        await fbSleep(1000);
        const ready = await waitFor(() => findFieldByLabel(FB_LABELS.title), { timeout: 8000 });
        if (ready) {
          full = await scrapeVisibleListingForm();
          if (!itemId) {
            const urlMatch = location.href.match(/\/marketplace\/item\/(\d+)/);
            if (urlMatch) itemId = urlMatch[1];
          }
          await chrome.storage.local.remove('pendingClickCapture'); // 原地搞定了,不需要兜底记录了
        }
      }

      const closed = await closeAnyOverlay();
      if (!closed) {
        await appendLog({ level: 'error', text: `「${dialogInfo.title || rowInfo.title || '商品'}」的详情弹窗没能自动关掉,可能会挡住后续点选,请手动关一下。` });
      }
      await fbSleep(300);

      const data = full || dialogInfo || rowInfo;
      await saveImportedListing(itemId, data);
      badge.textContent = itemId ? '✅ 已导入' : '✅ 已导入(无 FB 编号)';
      badge.style.background = '#16794d';
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
    if (!selectModeActive) return;
    if (isActionButtonClick(e.target)) return; // 让「标记为已售出」之类的正常按钮照常工作

    const row = findRowBoundary(e.target);
    if (!isPlausibleRow(row)) return;

    if (processing) {
      // 上一个还没处理完——不是没反应,是让它先跑完,给个提示别让用户以为坏了
      const waitBadge = showBadge(row, '⏳ 上一个还没处理完,请稍等...', '#8a6d00');
      setTimeout(() => waitBadge.remove(), 1200);
      return;
    }

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
