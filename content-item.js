// content-item.js - 注入到 Facebook Marketplace 单个商品页面,两个用途:
//
// 1) 「点选式导入」在极少数情况下的兜底路径——商品管理页点一行商品时,大多数
//    情况 Facebook 会弹出详情对话框(那种情况由 content-my-listings.js 直接
//    处理,不会用到这个文件);如果那次点击是真的跳转过来的,这里落地后自动
//    把完整信息读出来存好,再自动跳回原来的列表页,不用手动点后退。
// 2) DELETE_ITEM:重新上架成功后,可选自动删除 Facebook 上的旧版本。这一步是
//    不可撤销的,background.js 只有在用户对某条商品**同时**打开了全局开关和
//    单条开关(deleteOldOnRepost + autoDeleteOldListings)时才会发这个指令,
//    并且只在新的商品已经确认发布成功之后才会执行,顺序上不会出现「删了旧的
//    却没发出新的」的情况。

(function () {
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

  // 「点选式导入」的兜底路径:如果在商品列表页点选的那一行既没有弹出详情对话
  // 框、也没能直接从行内拿到商品链接,content-my-listings.js 会把当时抓到的
  // 标题/价格/缩略图先存进 pendingClickCapture,再放行那次点击、让 Facebook
  // 自己决定怎么跳。这里落地后检查有没有这个待处理的记录,有的话就把完整信息
  // (标题/价格/类别/成色/描述/图片)读出来直接存进插件,再自动跳回原来的列表
  // 页,不用手动点后退。
  async function checkPendingClickCapture() {
    const { pendingClickCapture } = await chrome.storage.local.get('pendingClickCapture');
    if (!pendingClickCapture) return;
    await chrome.storage.local.remove('pendingClickCapture');

    // 记录超过 30 秒还没被消费,大概率是当时那次点击哪里出了岔子(比如卡在别的
    // 页面了),不要拿一条过期的记录去匹配现在这个可能完全不相关的页面。
    if (pendingClickCapture.capturedAt && Date.now() - pendingClickCapture.capturedAt > 30000) return;

    const m = location.href.match(/\/marketplace\/item\/(\d+)/);
    if (!m) return; // 跳到的不是商品页,忽略
    const itemId = m[1];
    const { title, priceText, thumbUrl, returnUrl } = pendingClickCapture;

    let full = null;
    const ready = await ensureEditFormVisible();
    if (ready) {
      full = await scrapeVisibleListingForm();
    }

    const listings = await getListings();
    if (!listings.some((l) => l.sourceItemId === itemId)) {
      listings.push(
        genListing({
          title: (full && full.title) || title || '',
          price: (full && full.price) || priceText || '',
          category: (full && full.category) || '',
          condition: (full && full.condition) || '',
          description: (full && full.description) || '',
          location: (full && full.location) || '',
          photos: (full && full.photos) || [],
          sourceItemId: itemId,
          sourceUrl: `https://www.facebook.com/marketplace/item/${itemId}/`,
          status: 'imported',
          importedAt: Date.now(),
        })
      );
      await saveListings(listings);
    }
    await appendLog({ level: 'success', text: `已导入:「${(full && full.title) || title || itemId}」` });

    if (returnUrl) {
      window.location.href = returnUrl;
    }
  }
  checkPendingClickCapture();

  chrome.runtime.sendMessage({ type: 'CONTENT_READY' }).catch(() => {});

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'DELETE_ITEM') {
      deleteListingOnPage()
        .then((r) => sendResponse(r))
        .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
      return true;
    }
  });
})();
