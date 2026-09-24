// content.js - 注入到 Facebook Marketplace「发布商品」页面,自动找到表单并填写
// 依赖 field-utils.js 提供的 DOM 辅助方法(manifest.json 里已经一起注入)

(function () {
  async function attachPhotos(photos) {
    if (!photos || !photos.length) return;
    const input = await waitFor(() => document.querySelector('input[type="file"]'));
    if (!input) throw new Error('找不到上传照片的输入框,可能是页面结构已变化');

    const files = [];
    for (const p of photos) {
      const res = await fetch(p.dataUrl);
      const blob = await res.blob();
      files.push(new File([blob], p.name || 'photo.jpg', { type: blob.type || 'image/jpeg' }));
    }
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await fbSleep(1500);
  }

  async function selectFromDropdown(triggerCandidates, optionText) {
    if (!optionText) return;
    const trigger = await waitFor(
      () => findFieldByLabel(triggerCandidates) || findFieldByNearbyLabel(triggerCandidates) || findClickableByText(triggerCandidates)
    );
    if (!trigger) throw new Error(`找不到「${optionText}」对应的选择控件`);
    trigger.click();
    await fbSleep(400);

    const activeInput = document.activeElement;
    if (activeInput && activeInput.tagName === 'INPUT') {
      setNativeValue(activeInput, optionText);
      await fbSleep(500);
    }

    const option = await waitFor(() => {
      const options = Array.from(document.querySelectorAll('[role="option"], li'));
      return options.find((o) => fbNormalize(o.textContent).includes(fbNormalize(optionText))) || null;
    }, { timeout: 5000 });

    if (!option) {
      throw new Error(`在下拉列表里没找到「${optionText}」这个选项,请确认文字与 Facebook 页面上显示的完全一致`);
    }
    option.click();
    await fbSleep(300);
  }

  // 类别选得准不准不重要,重要的是必须选上——Facebook 要求这个字段非空才会
  // 解锁发布按钮。类别选择器大概率点开后弹出的是一整棵分类树(选大类→再选
  // 子类,可能还有第三层),不是一层列表,所以这里不要求精确匹配:能对上原来
  // 读到的类别文字就优先选那个,对不上就直接选当前弹出的这一层里第一个选项;
  // 选完如果又冒出下一层新的选项列表,就在新的这层里继续选第一个,最多试几层,
  // 保证类别这一项最终有值、不是空的。
  async function selectCategoryBestEffort(triggerCandidates, preferredText) {
    const trigger = await waitFor(
      () => findFieldByLabel(triggerCandidates) || findFieldByNearbyLabel(triggerCandidates) || findClickableByText(triggerCandidates)
    );
    if (!trigger) throw new Error('找不到「类别」对应的选择控件');
    trigger.click();
    await fbSleep(500);

    let remainingPreferred = preferredText;
    for (let level = 0; level < 4; level++) {
      const options = await waitFor(() => {
        const list = Array.from(document.querySelectorAll('[role="option"], [role="menuitem"], li')).filter(
          (el) => el.offsetParent !== null
        );
        return list.length ? list : null;
      }, { timeout: 2500 });
      if (!options) break; // 没有新的选项列表弹出来了,说明这一层已经选到头

      let pick = null;
      if (remainingPreferred) {
        pick = options.find((o) => fbNormalize(o.textContent).includes(fbNormalize(remainingPreferred)));
      }
      if (!pick) pick = options[0];
      remainingPreferred = null; // 只在第一层尝试匹配原来的类别文字,子分类直接选第一个

      pick.click();
      await fbSleep(600);
    }
  }

  // 发布成功后 Facebook 通常会跳到新商品自己的页面,尝试从网址里读出新商品的 id,
  // 这样背景脚本以后就能精确地找到「这一次发布出来的新商品」(比如用来在下次
  // 重新上架时删除它,而不是删错别的商品)。读不到就返回 null,不影响其他功能。
  function captureNewItemId() {
    const m = location.href.match(/\/marketplace\/item\/(\d+)/);
    if (!m) return { newItemId: null, newItemUrl: null };
    return { newItemId: m[1], newItemUrl: `https://www.facebook.com/marketplace/item/${m[1]}/` };
  }

  async function fillListing(listing) {
    const steps = [];
    try {
      steps.push('等待表单加载');
      const titleReady = await waitFor(() => findFieldByLabel(FB_LABELS.title), { timeout: 20000 });
      if (!titleReady) {
        throw new Error(
          `页面加载超时,没有找到标题输入框(可能未登录、要先手动选一个类目、或 Facebook 改版)。诊断信息:${JSON.stringify(collectDiagnostics())}`
        );
      }

      if (listing.photos && listing.photos.length) {
        steps.push('上传照片');
        await attachPhotos(listing.photos);
      }

      steps.push('填写标题');
      const titleEl = findFieldByLabel(FB_LABELS.title);
      if (titleEl) setNativeValue(titleEl, listing.title || '');

      steps.push('填写价格');
      const priceEl = findFieldByLabel(FB_LABELS.price);
      if (priceEl) setNativeValue(priceEl, String(listing.price ?? ''));

      // 类别用户明确说了选得准不准不重要,重要的是必须选上一个,不然 Facebook
      // 不会解锁发布按钮——所以这里不管有没有从旧商品读到具体类别文字,都会
      // 尝试把类别选择器点开、选一个选项(优先匹配读到的文字,匹配不到就选
      // 弹出来的第一个),真选不上也只是跳过、让用户自己补一下,不应该因为这个
      // 把标题/价格/描述/图片这些已经填好的内容也一起作废、整个判失败。
      steps.push('选择类别');
      try {
        await selectCategoryBestEffort(FB_LABELS.category, listing.category);
      } catch (err) {
        steps.push(`选择类别失败(已跳过,请手动选择类别): ${(err && err.message) || err}`);
      }

      // 成色跟类别不一样,选项通常就是一层(全新/二手-好/二手-一般这种),要求
      // 新表单里的选项文字跟旧商品读到的完全一致才能选中——版本、语言、Facebook
      // 改过措辞都可能对不上,选不中同样只是跳过、不影响其他字段。
      if (listing.condition) {
        steps.push('选择成色');
        try {
          await selectFromDropdown(FB_LABELS.condition, listing.condition);
        } catch (err) {
          steps.push(`选择成色失败(已跳过,请手动选择「${listing.condition}」): ${(err && err.message) || err}`);
        }
      }

      steps.push('填写描述');
      const descEl = findFieldByLabel(FB_LABELS.description);
      if (descEl) setNativeValue(descEl, listing.description || '');

      if (listing.location) {
        steps.push('填写地点');
        const locEl = findFieldByLabel(FB_LABELS.location);
        if (locEl) {
          setNativeValue(locEl, listing.location);
          await fbSleep(800);
          const suggestion = await waitFor(
            () => document.querySelector('[role="listbox"] [role="option"], ul[role="listbox"] li'),
            { timeout: 3000 }
          );
          if (suggestion) suggestion.click();
        }
      }

      if (listing.settingsAutoPublish) {
        steps.push('自动翻页并发布');
        let publishBtn = null;
        for (let i = 0; i < 8; i++) {
          publishBtn = findClickableByText(FB_LABELS.publish);
          if (publishBtn) break;
          const nextBtn = findClickableByText(FB_LABELS.next);
          if (!nextBtn) break;
          nextBtn.click();
          await fbSleep(1200);
        }
        if (!publishBtn) {
          // 之前这里的报错不带诊断信息,排查一次就要问用户要一次截图——现在跟
          // 「找不到标题输入框」那个报错一样,把当前页面上所有看起来像按钮的
          // 文字都列出来,下次再出这个错,日志里就直接有答案,不用再来回一轮。
          throw new Error(
            `已自动填好表单,但没找到「发布」按钮,请手动检查并点击发布。诊断信息:${JSON.stringify(collectDiagnostics())}`
          );
        }
        publishBtn.click();
        await fbSleep(2000);
        return { ok: true, published: true, steps, ...captureNewItemId() };
      }

      return { ok: true, published: false, steps };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err), steps };
    }
  }

  chrome.runtime.sendMessage({ type: 'CONTENT_READY' }).catch(() => {});

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'FILL_LISTING') {
      const listing = { ...message.listing, settingsAutoPublish: !!(message.settings && message.settings.autoPublish) };
      fillListing(listing).then(sendResponse);
      return true;
    }
  });
})();
