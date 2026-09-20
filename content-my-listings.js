// content-my-listings.js - 注入到 Facebook Marketplace「我的商品/正在出售」管理页面
//
// 点一行商品,Facebook 会弹出一个「Your Listing」详情对话框。这里只做两件很快的
// 事:①从这个对话框里把标题/价格/缩略图和 Facebook 的真实商品编号读出来,
// ②把对话框关掉——不在这个页面上继续点「Edit Listing」展开完整表单、下载图片
// 了(那一套很慢,而且之前用「程序模拟点击」去后台补一次点击来触发它,结果发现
// 合成事件(dispatchEvent 出来的 isTrusted=false 事件)不可靠,Facebook 的 React
// 逻辑不一定认)。改成:秒选 + 真实点击自然弹窗读基本信息,读完立刻把编号交给
// background.js,由它在一个新的后台标签页里打开这个商品的独立页面、真正地把
// 完整表单(类别/成色/描述/图片)读一遍——这一步用的是真实的页面导航,不依赖任何
// 合成点击,足够可靠。

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
  // 就关了,只点一下就默认成功的话,对话框其实还开着,会把下一次选商品卡住。
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

  // 点击本身不拦截(不 preventDefault/stopPropagation),让 Facebook 自己的逻辑
  // 正常弹出详情对话框——这样就不需要之后再用程序模拟一次点击去补触发,合成事件
  // 不可靠的问题也就不存在了。我们只是在真实点击之后,等对话框出现、把能立刻看到
  // 的信息(标题/价格/缩略图/Facebook 商品编号)读出来、关掉对话框,然后把编号
  // 交给后台队列去慢慢读完整表单(类别/成色/描述/图片),不在这个页面上等那么久。
  async function processRowClick(row, quickInfo) {
    if (!row.isConnected) return;
    setRowBadge(row, '🔎 正在打开详情...', '#1877f2');

    try {
      const dialog = await waitFor(() => document.querySelector('[role="dialog"]'), { timeout: 4000 });

      if (!dialog) {
        // 没弹出对话框——退回看这一行本身有没有现成的商品链接。有的话照样能把
        // 编号交给后台队列去读完整详情;没有的话就只能先把秒选时看到的基本信息
        // (标题/价格)存下来,不要什么都不存、白白浪费这次点选。
        const itemId = extractItemId(row);
        chrome.runtime.sendMessage({ type: 'QUEUE_DETAIL_READ', itemId, quickInfo }).catch(() => {});
        finishRowBadge(
          row,
          itemId ? '📋 已排队,后台读取详情中...' : '✅ 已导入(基本信息,没弹出详情框)',
          itemId ? '#1877f2' : '#16794d'
        );
        return;
      }

      const dialogInfo = extractQuickInfo(dialog);
      const itemId = extractItemId(dialog);
      const mergedInfo = dialogInfo.title ? dialogInfo : quickInfo;

      const closed = await closeAnyOverlay();
      if (!closed) {
        await appendLog({
          level: 'error',
          text: `「${mergedInfo.title || '商品'}」的详情弹窗没能自动关掉,可能会挡住后续操作,请手动关一下。`,
        });
      }

      chrome.runtime.sendMessage({ type: 'QUEUE_DETAIL_READ', itemId, quickInfo: mergedInfo }).catch(() => {});
      finishRowBadge(
        row,
        itemId ? '📋 已排队,后台读取详情中...' : '✅ 已导入(基本信息,无 FB 编号)',
        itemId ? '#1877f2' : '#16794d'
      );
    } catch (err) {
      finishRowBadge(row, '⚠️ 出错了', '#c0362c');
      await appendLog({ level: 'error', text: `处理「${quickInfo.title || '商品'}」时出错: ${(err && err.message) || err}` });
      closeAnyOverlay();
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

  function handleClick(e) {
    if (!selectModeActive) return;
    if (isActionButtonClick(e.target)) return; // 让「标记为已售出」之类的正常按钮照常工作

    const row = findRowBoundary(e.target);
    if (!isPlausibleRow(row)) return;
    if (row.dataset.fbmaQueued === '1') return; // 已经选过/处理中了,别重复加

    // 只挡住浏览器的默认动作(这一行本身通常包在一个真实的 <a href="/marketplace/
    // item/..."> 链接里,不挡的话浏览器会直接跳转过去,整个页面(连同这段脚本)
    // 都会被换掉,后面什么都读不到),但不挡事件继续往下传——Facebook 自己的
    // React 点击逻辑要靠事件冒泡下去才会弹出详情框,挡住了传播它就收不到这次点击。
    e.preventDefault();

    row.dataset.fbmaQueued = '1';
    const quickInfo = extractQuickInfo(row);
    setRowBadge(row, '✅ 已选中', '#1877f2');

    processRowClick(row, quickInfo);
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
