// content-item.js - 注入到 Facebook Marketplace 单个商品页面,两个用途:
//
// 1) SCRAPE_ITEM:在编辑页(.../item/<id>/edit)读取现有表单内容 + 下载图片,
//    用于「导入我的商品」——把 Facebook 上已有的 listing 读进插件里。
// 2) DELETE_ITEM:在商品页(.../item/<id>/)执行删除操作。这一步是不可撤销的,
//    background.js 只有在用户对某条商品**同时**打开了全局开关和单条开关
//    (deleteOldOnRepost + autoDeleteOldListings)时才会发这个指令,并且只在
//    新的商品已经确认发布成功之后才会执行,顺序上不会出现「删了旧的却没发出
//    新的」的情况。

(function () {
  function isLikelyPhotoPreview(img) {
    return img.naturalWidth > 80 && img.naturalHeight > 80 && /^https?:/.test(img.src);
  }

  function readValue(el) {
    if (!el) return '';
    if ('value' in el && el.value) return el.value;
    return fbNormalize(el.textContent);
  }

  async function scrapeCurrentForm() {
    const titleReady = await waitFor(() => findFieldByLabel(FB_LABELS.title), { timeout: 20000 });
    if (!titleReady) throw new Error('页面加载超时,没有找到标题输入框(可能不是编辑表单页,或 Facebook 改版)');

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
      title: readValue(titleEl),
      price: readValue(priceEl),
      description: readValue(descEl),
      category: readValue(categoryEl),
      condition: readValue(conditionEl),
      location: readValue(locationEl),
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
    if (!deleteBtn) throw new Error('找不到「删除商品」按钮,可能页面结构已变化,请手动删除旧商品');
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
