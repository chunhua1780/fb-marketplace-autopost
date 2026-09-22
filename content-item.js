// content-item.js - 注入到 Facebook Marketplace 单个商品页面,两个用途:
//
// 1) SCRAPE_ITEM:background.js 在后台标签页里打开某个商品的独立页面后,发这个
//    指令过来,把完整信息(类别/成色/描述/所有图片)读一遍并返回。这是「点选式
//    导入」真正读完整详情的地方——商品管理页那边(content-my-listings.js)点一
//    下只读弹窗里能立刻看到的标题/价格/编号,读完整表单这个比较慢的步骤挪到这
//    里,用真实的页面导航打开,不依赖任何程序模拟点击。
// 2) DELETE_ITEM:重新上架成功后,可选自动删除 Facebook 上的旧版本。这一步是
//    不可撤销的,background.js 只有在用户对某条商品**同时**打开了全局开关和
//    单条开关(deleteOldOnRepost + autoDeleteOldListings)时才会发这个指令,
//    并且只在新的商品已经确认发布成功之后才会执行,顺序上不会出现「删了旧的
//    却没发出新的」的情况。

(function () {
  async function scrapeListingOnPage() {
    const ready = await ensureEditFormVisible();
    if (!ready) {
      throw new Error(`没能展开完整的编辑表单,读取详情失败。诊断信息:${JSON.stringify(collectDiagnostics())}`);
    }
    const listing = await scrapeVisibleListingForm();
    // 类别/成色读不到,会导致重新上架时新表单也没法选这两个必填项,Facebook
    // 的「下一步/发布」按钮永远是灰的——把当时页面上看起来像下拉/按钮的候选
    // 元素记进日志,方便确认到底是哪个控件没识别出来。
    if (!listing.category || !listing.condition) {
      appendLog({
        level: 'error',
        text: `「${listing.title || '商品'}」没能读到类别或成色(类别:${listing.category || '(空)'} / 成色:${listing.condition || '(空)'}),重新上架时 Facebook 会因为缺必填项发不出去。这个页面上找到的候选按钮/下拉文字:${JSON.stringify(listing.categoryConditionDiag)}`,
      });
    }
    return listing;
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

  chrome.runtime.sendMessage({ type: 'CONTENT_READY' }).catch(() => {});

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'SCRAPE_ITEM') {
      scrapeListingOnPage()
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
