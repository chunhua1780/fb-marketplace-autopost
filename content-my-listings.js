// content-my-listings.js - 注入到 Facebook Marketplace「我的商品/正在出售」管理页面
//
// 点一行商品,Facebook 会弹出一个「Your Listing」详情对话框,里面有 Edit Listing
// 按钮,点开才能读到完整的类别/成色/描述/图片——这一套「开对话框 → 点编辑 →
// 等表单出现 → 下载图片 → 关掉对话框」做完通常要好几秒。如果每点一下就原地等
// 这一整套跑完,连续点第二个、第三个商品时都要排队等前一个跑完,体验就是「点
// 第一个卡半天」。
//
// 所以拆成两半:点击本身只做「秒选」——立刻记下这一行看得到的标题/价格/缩略图,
// 打个「已选中」的标记,不等任何东西,可以马上点下一个;真正慢的那部分(开对话
// 框、读完整字段、下图片)扔进一个后台队列,排队慢慢跑,跑到哪个商品就把哪个
// 商品的标记从「排队中」换成「已导入」,不会挡住继续选下一个。

(function () {
  let selectModeActive = false;
  const queue = []; // { row, quickInfo }[]
  let queueRunning = false;

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

  // 每一行自己的状态小标签(已选中/排队中/正在读取/已导入),跟着这一行走,
  // 状态变化时原地更新文字和颜色,而不是每次都重新弹一个新的。
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

  function finishRowBadge(row, text, color, ms = 1800) {
    setRowBadge(row, text, color);
    setTimeout(() => {
      const badge = rowBadges.get(row);
      if (badge) {
        badge.remove();
        rowBadges.delete(row);
      }
      delete row.dataset.fbmaQueued; // 处理完了,允许以后需要的话重新点选(比如失败想重试)
    }, ms);
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
  // 就关了,只点一下就默认成功的话,对话框其实还开着,会把下一个排队的商品卡住。
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
  // 读到了就先存下来,用插件自己的编号(genListing 里自动生成)管理。
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

  // 后台队列真正干活的地方:对某一行「补点一次」(用程序模拟点击,因为秒选那一下
  // 已经被拦下来、没有真的触发 Facebook 弹窗),让 Facebook 弹出详情对话框,读
  // 基本信息,点它自带的「Edit Listing」展开完整表单,把类别/成色/描述/图片一次
  // 读完,再关掉对话框、存起来。
  async function captureDetails(row, quickInfo) {
    if (!row.isConnected) {
      await appendLog({ level: 'error', text: `「${quickInfo.title || '商品'}」这一行已经从页面上消失了(可能是列表刷新/滚动导致),已跳过,请重新点选一次。` });
      return;
    }

    setRowBadge(row, '⏳ 正在读取详情...', '#1877f2');

    try {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));

      const dialog = await waitFor(() => document.querySelector('[role="dialog"]'), { timeout: 4000 });

      if (!dialog) {
        const link = row.querySelector('a[href*="/marketplace/item/"]');
        const m = link && (link.getAttribute('href') || '').match(/\/marketplace\/item\/(\d+)/);
        await saveImportedListing(m ? m[1] : null, quickInfo);
        finishRowBadge(row, m ? '✅ 已导入' : '✅ 已导入(无 FB 编号)', '#16794d');
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
            ...(dialogInfo.title ? dialogInfo : quickInfo),
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
        await appendLog({ level: 'error', text: `「${dialogInfo.title || quickInfo.title || '商品'}」的详情弹窗没能自动关掉,可能会挡住后续处理,请手动关一下。` });
      }
      await fbSleep(300);

      const data = full || dialogInfo || quickInfo;
      await saveImportedListing(itemId, data);
      finishRowBadge(row, itemId ? '✅ 已导入' : '✅ 已导入(无 FB 编号)', '#16794d');
    } catch (err) {
      finishRowBadge(row, '⚠️ 出错了', '#c0362c');
      await appendLog({ level: 'error', text: `导入「${quickInfo.title || '商品'}」时出错: ${(err && err.message) || err}` });
      closeAnyOverlay();
    }
  }

  async function runQueue() {
    if (queueRunning) return; // 已经有一个在跑了,新加进队列的会被它接着处理
    queueRunning = true;
    try {
      while (queue.length) {
        const next = queue.shift();
        await captureDetails(next.row, next.quickInfo);
      }
    } finally {
      queueRunning = false;
    }
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

  // 点击本身只做「秒选」:立刻记下这一行的基本信息、打个排队标记,不等任何东西。
  // 拦下这次点击(不让 Facebook 弹详情框),真正需要弹窗读详情的时候,由后台
  // 队列对这一行重新模拟点击一次。
  function handleClick(e) {
    if (!selectModeActive) return;
    if (isActionButtonClick(e.target)) return; // 让「标记为已售出」之类的正常按钮照常工作

    const row = findRowBoundary(e.target);
    if (!isPlausibleRow(row)) return;
    if (row.dataset.fbmaQueued === '1') return; // 已经选过/排过队了,别重复加

    e.preventDefault();
    e.stopPropagation();

    row.dataset.fbmaQueued = '1';
    const quickInfo = extractQuickInfo(row);
    queue.push({ row, quickInfo });
    setRowBadge(row, `✅ 已选中(排队第 ${queue.length} 位)`, '#1877f2');

    runQueue();
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
  // 排队中的任务本身是页面内存里的数组,跳转会清空它,但这种情况本来就少见
  // (大部分商品走原地弹窗,不会真的跳转)。
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
