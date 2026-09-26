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
  let graphqlSeenCount = 0;
  let graphqlSamples = [];
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== 'fbma-net-capture') return;
    if (msg.type === 'LISTING_DATA' && msg.id) {
      netCaptured[msg.id] = msg.data;
    } else if (msg.type === 'GRAPHQL_SEEN') {
      graphqlSeenCount = msg.count;
      graphqlSamples = msg.samples || [];
    }
  });

  // 网络抓取彻底没认出商品数据时,把拦到的原始样本存起来,让用户能在面板里
  // 点「导出调试数据」把这些样本导出成一个文件发过来——有了 Facebook 真实
  // 返回的数据长什么样,才能一次改对打分规则,不用再靠猜。
  async function saveDebugSamples(itemId) {
    if (!graphqlSamples.length) return;
    await chrome.storage.local.set({
      lastDebugCapture: {
        itemId,
        url: location.href,
        pageTitle: document.title,
        capturedAt: Date.now(),
        samples: graphqlSamples,
      },
    });
  }

  function currentItemId() {
    const m = location.href.match(/\/marketplace\/item\/(\d+)/);
    return m ? m[1] : null;
  }

  async function downloadNetPhotos(net) {
    if (!net || !net.photos || !net.photos.length) return [];
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
    return downloaded;
  }

  function titleFromPageTitle() {
    // 兜底用:网页标签页标题通常是"Marketplace - 商品标题 | Facebook"这个格式
    return (document.title || '').replace(/^Marketplace\s*-\s*/, '').replace(/\s*\|\s*Facebook\s*$/, '').trim();
  }

  async function scrapeListingOnPage() {
    // 网络抓取和页面渲染是并行发生的,打开页面时数据可能还没到——先等最多 4
    // 秒。之前的做法是先花好几秒去找/展开编辑表单,找不到就直接判定失败,
    // 网络抓到的数据压根没机会用上——实测下来好几个真实商品自己的详情页上根本
    // 没有"编辑"这个按钮(可能编辑功能本来就只在"你的商品"管理页里才有),
    // 死等一个不存在的编辑表单只会白白浪费时间、最后仍然失败。现在反过来:
    // 先看网络那边有没有抓到足够的数据,够用就直接用,不需要页面上真的展开
    // 什么表单;网络数据不够的时候,才把 DOM 表单当成补充/兜底手段去试。
    // network-capture.js 里 scanEmbeddedJsonScripts() 是分好几批扫的
    // (0.4/1.2/2.5/4.5/7秒各扫一次,因为 BigPipe 数据是陆续插进页面的,不是
    // 一次性到位),但这里之前只等 4 秒——比最后两次扫描(4.5秒、7秒)还早,
    // 等于那两次扫描扫到了也白扫,压根等不到。这是这几天反复失败的一个具体
    // 原因,不是"抓取规则又没认出来",是等的时间本身就不够长。这里改成等
    // 8 秒,覆盖完整个扫描时间表再多留一点余量。
    const itemId = currentItemId();
    let net = itemId && netCaptured[itemId];
    if (!net && itemId) {
      net = await waitFor(() => netCaptured[itemId], { timeout: 8000, interval: 300 });
    }

    // 只要求图片——类别/成色现在都是"尽力选一个"就行(content.js 里
    // selectCategoryBestEffort/selectConditionBestEffort),不再是必须先读到
    // 原文字才能重新上架。实测还发现成色这个字段经常压根就没有随着 Facebook
    // 这个页面一起传出来(不是漏抓,是页面本身就没带),死等它没有意义;图片
    // 不一样,没有真实原图是真的没法蒙混过去的。
    const netHasEnough = !!(net && net.photos && net.photos.length);

    let listing;
    if (netHasEnough) {
      listing = {
        title: net.title || titleFromPageTitle(),
        price: net.price || '',
        description: net.description || '',
        category: net.category || '',
        condition: net.condition || '',
        location: net.location || '',
        photos: [],
        categoryConditionDiag: null,
      };
    } else {
      const ready = await ensureEditFormVisible();
      if (!ready) {
        if (!net) {
          let netHint;
          if (graphqlSeenCount > 0) {
            netHint = `拦截到了 ${graphqlSeenCount} 次 GraphQL 响应,但没有一个长得像商品信息(可能是打分规则没认出来,不是拦截机制坏了)。已经把拦到的原始数据样本存起来了,去插件面板点一下「导出调试数据」,把导出的文件发给开发者,能一次性改对识别规则,不用再靠猜`;
            await saveDebugSamples(itemId);
          } else {
            netHint = '一次 GraphQL 响应都没拦截到(可能是这个 Chrome 版本不支持网络抓取这层机制,或者页面还没加载完就已经开始读取)';
          }
          throw new Error(`没能展开完整的编辑表单,网络那边也没抓到数据(${netHint}),读取详情彻底失败。诊断信息:${JSON.stringify(collectDiagnostics())}`);
        }
        // 编辑表单打不开,但网络那边好歹抓到了一部分,先用这部分凑合,总比
        // 完全失败、连基本信息都没有要好。
        listing = {
          title: net.title || titleFromPageTitle(),
          price: net.price || '',
          description: net.description || '',
          category: net.category || '',
          condition: net.condition || '',
          location: net.location || '',
          photos: [],
          categoryConditionDiag: null,
        };
      } else {
        listing = await scrapeVisibleListingForm();
      }
    }

    if (net) {
      // 图片：网络抓到的是 Facebook 自己存的原图直链,不用再从页面上的 <img>
      // 元素里按尺寸猜「这张是不是商品图」,直接下载这些直链就行,比 DOM 扫描
      // 更完整(不会漏掉懒加载还没渲染出来的图),也不会混进头像、图标这些无关图片。
      // (只有 listing.photos 还是空的时候才用网络这份去填——上面 DOM 表单那条
      // 分支自己已经读到图片时,不要用网络这份去覆盖。)
      if (net.photos && net.photos.length && !(listing.photos && listing.photos.length)) {
        const downloaded = await downloadNetPhotos(net);
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

    // 类别/成色现在都是"重新上架时尽力选一个"就行,读不到不再算失败——只是
    // 留个记录方便万一以后想深究,不影响这次导入本身算不算成功。真正会卡住
    // 重新上架的只有图片(见上面 netHasEnough 那段注释)。
    if (!listing.category || !listing.condition) {
      appendLog({
        level: 'info',
        text: `「${listing.title || '商品'}」没能读到类别或成色的原文字(类别:${listing.category || '(空)'} / 成色:${listing.condition || '(空)'}),不影响重新上架——填表时会尽力自动选一个,选得准不准不重要。`,
      });
    }
    if (net) {
      appendLog({
        level: 'info',
        text: `「${listing.title || '商品'}」这次用网络抓取的数据补全了详情(${net.photos && net.photos.length ? `${net.photos.length}张原图` : ''}${net.condition ? '、成色' : ''}${net.description ? '、完整描述' : ''})。`,
      });
    }

    // 探探这个账号的 Facebook 界面里,「更多选项」菜单里有没有一个原生的
    // 「Renew listing / 续期」选项——如果有,重新上架其实不需要"删掉重建"这么
    // 重,直接点这个原生按钮让 Facebook 自己处理就行,又快又不会有类别/图片
    // 这些字段读不全的风险。这里只是探测、记录一下有没有,先不改变实际的重新
    // 上架流程——等确认这个选项存在、并且摸清楚点了以后 Facebook 具体会怎么
    // 反应,再决定要不要真的用它替换掉现在这套"读取详情→删除→重建"的做法。
    try {
      const renewInfo = await checkForRenewOption();
      listing.renewOptionSeen = renewInfo.seen;
      if (renewInfo.seen) {
        appendLog({
          level: 'info',
          text: `「${listing.title || '商品'}」的「更多选项」菜单里发现了一个可能是原生续期的选项:「${renewInfo.text}」——记录下来,后面可以考虑直接用这个,不用整个删掉重建。`,
        });
      }
    } catch (err) {
      // 探测本身失败不影响主流程,忽略即可
    }

    return listing;
  }

  // 只探测、不点击——打开(如果还没开)「更多选项」菜单,看看里面的菜单项
  // 文字有没有哪个像是"续期/renew"。就算菜单本来就是因为上面 ensureEditFormVisible
  // 已经打开过而残留着,这里也只是再读一遍文字,不会因为多点一次而产生任何
  // 副作用。
  async function checkForRenewOption() {
    let menu = document.querySelector('[role="menu"]');
    let openedHere = false;
    if (!menu) {
      const moreBtn = await waitFor(() => findClickableByExactText(FB_LABELS.moreOptions), { timeout: 3000 });
      if (!moreBtn) return { seen: false };
      moreBtn.click();
      openedHere = true;
      await fbSleep(600);
      menu = document.querySelector('[role="menu"]');
    }
    if (!menu) return { seen: false };
    const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
    const renewItem = items.find((el) => /renew|续期|重新上架|更新商品|refresh listing/i.test((el.getAttribute('aria-label') || el.textContent || '').trim()));
    if (openedHere) {
      // 只是探测用,不是真的要进这个菜单操作——探测完把它关掉,不留一个开着
      // 的菜单在页面上,免得干扰后面 ensureEditFormVisible 自己的逻辑。
      document.body.click();
      await fbSleep(200);
    }
    return { seen: !!renewItem, text: renewItem ? (renewItem.getAttribute('aria-label') || renewItem.textContent || '').trim() : null };
  }

  async function deleteListingOnPage() {
    // 用精确匹配,不用宽松的包含匹配——"More"这种候选词太容易在无关按钮
    // (比如展开长文字用的"See more")上误命中,详见 field-utils.js 里
    // findClickableByExactText 的说明。
    const menuBtn = await waitFor(() => findClickableByExactText(FB_LABELS.moreOptions), { timeout: 8000 });
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
