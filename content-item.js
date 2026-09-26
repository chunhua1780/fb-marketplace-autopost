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
  // network-capture.js 跑在页面自己的 JS 环境(MAIN world),拦下 Facebook 自己
  // 请求 GraphQL 接口拿到的原始数据,通过 postMessage 转过来——比读页面上渲染出来
  // 的文字/图片更完整、更可靠(描述不会被截断、图片是原图直链、成色是 Facebook
  // 自己用的原始文字,不是靠 DOM 猜的)。这里存一份按商品编号分类的缓存,
  // scrapeListingOnPage 读表单的同时,把这份网络抓到的数据也合并进去。
  const netCaptured = {};
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== 'fbma-net-capture' || msg.type !== 'LISTING_DATA' || !msg.id) return;
    netCaptured[msg.id] = msg.data;
  });

  function currentItemId() {
    const m = location.href.match(/\/marketplace\/item\/(\d+)/);
    return m ? m[1] : null;
  }

  async function scrapeListingOnPage() {
    const ready = await ensureEditFormVisible();
    if (!ready) {
      throw new Error(`没能展开完整的编辑表单,读取详情失败。诊断信息:${JSON.stringify(collectDiagnostics())}`);
    }
    const listing = await scrapeVisibleListingForm();

    // 网络抓取和页面渲染是并行发生的,打开页面时数据可能还没到——这里再等最多
    // 2 秒,大多数情况下页面加载时已经发生过了,不会真的等满。
    const itemId = currentItemId();
    let net = itemId && netCaptured[itemId];
    if (!net && itemId) {
      net = await waitFor(() => netCaptured[itemId], { timeout: 2000, interval: 200 });
    }

    if (net) {
      // 图片：网络抓到的是 Facebook 自己存的原图直链,不用再从页面上的 <img>
      // 元素里按尺寸猜「这张是不是商品图」,直接下载这些直链就行,比 DOM 扫描
      // 更完整(不会漏掉懒加载还没渲染出来的图),也不会混进头像、图标这些无关图片。
      if (net.photos && net.photos.length) {
        const downloaded = [];
        for (const url of net.photos.slice(0, 20)) {
          try {
            const res = await fetch(url);
            const blob = await res.blob();
            const dataUrl = await blobToDataUrl(blob);
            downloaded.push({ name: 'photo.jpg', dataUrl });
          } catch (err) {
            // 单张图片下载失败不影响其他图片,跳过即可
          }
        }
        if (downloaded.length) listing.photos = downloaded;
      }
      // 成色是必填项,Facebook 表单里显示的文字必须跟重新上架时要选的选项完全
      // 一致才能选中——网络抓到的是 Facebook 自己原始用的文字,比从按钮上读到的
      // 显示文字更准,DOM 没读到时优先用它补上。
      if (net.condition && !listing.condition) listing.condition = net.condition;
      // 描述在页面上经常被"...查看更多"截断,网络抓到的是完整原文,只有比 DOM
      // 读到的更长时才替换,不会让本来完整的内容变短。
      if (net.description && net.description.length > (listing.description || '').length) {
        listing.description = net.description;
      }
      if (net.category && !listing.category) listing.category = net.category;
      listing.netCaptured = true;
    }

    // 类别/成色读不到,会导致重新上架时新表单也没法选这两个必填项,Facebook
    // 的「下一步/发布」按钮永远是灰的——把当时页面上看起来像下拉/按钮的候选
    // 元素记进日志,方便确认到底是哪个控件没识别出来。
    if (!listing.category || !listing.condition) {
      appendLog({
        level: 'error',
        text: `「${listing.title || '商品'}」没能读到类别或成色(类别:${listing.category || '(空)'} / 成色:${listing.condition || '(空)'}${net ? ',已尝试用网络抓取的数据补,仍然缺' : ',网络抓取也没抓到数据'}),重新上架时 Facebook 会因为缺必填项发不出去。这个页面上找到的候选按钮/下拉文字:${JSON.stringify(listing.categoryConditionDiag)}`,
      });
    } else if (net) {
      appendLog({
        level: 'info',
        text: `「${listing.title || '商品'}」这次用网络抓取的数据补全了详情(${net.photos && net.photos.length ? `${net.photos.length}张原图` : ''}${net.condition ? '、成色' : ''}${net.description ? '、完整描述' : ''}),类别和成色都读到了。`,
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
