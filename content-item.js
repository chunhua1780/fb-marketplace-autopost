// content-item.js - 注入到 Facebook Marketplace 单个商品页面,两个用途:
//
// 1) SCRAPE_ITEM:读取现有表单内容 + 下载图片,用于「导入我的商品」——把
//    Facebook 上已有的 listing 读进插件里。
// 2) DELETE_ITEM:在商品页执行删除操作。这一步是不可撤销的,background.js
//    只有在用户对某条商品**同时**打开了全局开关和单条开关(deleteOldOnRepost +
//    autoDeleteOldListings)时才会发这个指令,并且只在新的商品已经确认发布成功
//    之后才会执行,顺序上不会出现「删了旧的却没发出新的」的情况。

(function () {
  function isLikelyPhotoPreview(img) {
    return img.naturalWidth > 80 && img.naturalHeight > 80 && /^https?:/.test(img.src);
  }

  // 打开的网址不一定直接就是可编辑的表单(有的账号/版本需要先点一下「编辑」才会
  // 展开表单),这里先等标题输入框出现;等不到就找「编辑」按钮点一下再等一次。
  async function ensureEditFormVisible() {
    let ready = await waitFor(() => findFieldByLabel(FB_LABELS.title), { timeout: 8000 });
    if (ready) return true;

    const editBtn = await waitFor(() => findClickableByText(FB_LABELS.editListing), { timeout: 6000 });
    if (editBtn) {
      editBtn.click();
      await fbSleep(1200);
      ready = await waitFor(() => findFieldByLabel(FB_LABELS.title), { timeout: 15000 });
    }
    return !!ready;
  }

  async function scrapeCurrentForm() {
    const ready = await ensureEditFormVisible();
    if (!ready) {
      const diag = collectDiagnostics();
      throw new Error(
        `没有找到标题输入框,读取失败(可能不是编辑表单页,或 Facebook 改版)。诊断信息:${JSON.stringify(diag)}`
      );
    }

    const titleEl = findFieldByLabel(FB_LABELS.title);
    const priceEl = findFieldByLabel(FB_LABELS.price);
    const descEl = findFieldByLabel(FB_LABELS.description);
    const categoryEl = findFieldByLabel(FB_LABELS.category);
    const conditionEl = findFieldByLabel(FB_LABELS.condition);
    const locationEl = findFieldByLabel(FB_LABELS.location);

    const photos = [];
    const imgs = Array.from(document.querySelectorAll('img')).filter(isLikelyPhotoPreview).slice(0, 20);
    for (const img of imgs) {
      try {
        const res = await fetch(img.src);
        const blob = await res.blob();
        const dataUrl = await blobToDataUrl(blob);
        photos.push({ name: 'photo.jpg', dataUrl });
      } catch (err) {
        // 单张图片下载失败不影响其他字段,跳过即可
      }
    }

    return {
      title: readCurrentValue(titleEl),
      price: readCurrentValue(priceEl),
      description: readCurrentValue(descEl),
      category: readCurrentValue(categoryEl),
      condition: readCurrentValue(conditionEl),
      location: readCurrentValue(locationEl),
      photos,
    };
  }

  async function deleteListingOnPage() {
    const menuBtn = await waitFor(() => findClickableByText(['More', '更多选项', '更多']), { timeout: 8000 });
    if (menuBtn) {
      menuBtn.click();
      await fbSleep(600);
    }

    const deleteBtn = await waitFor(
      () => findClickableByText(['Delete listing', 'Delete Listing', '删除商品', '删除刊登', '刪除商品']),
      { timeout: 8000 }
    );
    if (!deleteBtn) {
      throw new Error(`找不到「删除商品」按钮,可能页面结构已变化,请手动删除旧商品。诊断信息:${JSON.stringify(collectDiagnostics())}`);
    }
    deleteBtn.click();
    await fbSleep(800);

    // 把确认按钮的查找范围限制在弹窗内,避免误点页面上其他带有类似文字的按钮
    const dialog = await waitFor(() => document.querySelector('[role="dialog"]'), { timeout: 5000 });
    if (!dialog) throw new Error('没有出现删除确认弹窗,为安全起见已停止,请手动确认删除旧商品');

    const confirmBtn = await waitFor(() => findClickableByText(['Delete', '删除', 'Confirm', '确认'], dialog), { timeout: 5000 });
    if (!confirmBtn) throw new Error('在确认弹窗里找不到「删除」按钮,请手动确认删除旧商品');
    confirmBtn.click();
    await fbSleep(1200);
    return { ok: true };
  }

  // 「点选式导入」的兜底路径:如果在商品列表页点选的那一行里没能直接找到商品
  // 链接,content-my-listings.js 会把当时抓到的标题/价格/缩略图先存进
  // pendingClickCapture,再放行那次点击、让 Facebook 自己跳过来。这里落地后
  // 检查有没有这个待处理的记录,有的话就从当前这个真实网址里读出 id,把信息
  // 拼成一条完整记录发给 background,再自动跳回原来的列表页,不用手动点后退。
  async function checkPendingClickCapture() {
    const { pendingClickCapture } = await chrome.storage.local.get('pendingClickCapture');
    if (!pendingClickCapture) return;
    await chrome.storage.local.remove('pendingClickCapture');

    const m = location.href.match(/\/marketplace\/item\/(\d+)/);
    if (!m) return; // 跳到的不是商品页,忽略

    const itemId = m[1];
    const { title, priceText, thumbUrl, returnUrl } = pendingClickCapture;
    chrome.runtime.sendMessage({
      type: 'PRODUCT_SELECTED',
      item: { itemId, title, priceText, thumbUrl, sourceUrl: `https://www.facebook.com/marketplace/item/${itemId}/` },
      returnUrl,
    });
  }
  checkPendingClickCapture();

  chrome.runtime.sendMessage({ type: 'CONTENT_READY' }).catch(() => {});

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'SCRAPE_ITEM') {
      scrapeCurrentForm()
        .then((listing) => sendResponse({ ok: true, listing }))
        .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
      return true;
    }
    if (message.type === 'DELETE_ITEM') {
      deleteListingOnPage()
        .then((r) => sendResponse(r))
        .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
      return true;
    }
  });
})();
