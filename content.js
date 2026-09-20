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
    const trigger = await waitFor(() => findFieldByLabel(triggerCandidates) || findClickableByText(triggerCandidates));
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

      // 类别/成色是下拉选择,要求新表单里的选项文字跟旧商品读到的完全一致才能
      // 选中——版本、语言、Facebook 改过选项措辞都可能对不上。这两个字段选不中
      // 只是让用户自己补选一下(几秒钟的事),不应该因为这个把标题/价格/描述/
      // 图片这些已经填好的内容也一起作废、整个重新上架直接判失败。
      if (listing.category) {
        steps.push('选择类别');
        try {
          await selectFromDropdown(FB_LABELS.category, listing.category);
        } catch (err) {
          steps.push(`选择类别失败(已跳过,请手动选择「${listing.category}」): ${(err && err.message) || err}`);
        }
      }

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
        for (let i = 0; i < 5; i++) {
          publishBtn = findClickableByText(FB_LABELS.publish);
          if (publishBtn) break;
          const nextBtn = findClickableByText(FB_LABELS.next);
          if (!nextBtn) break;
          nextBtn.click();
          await fbSleep(1200);
        }
        if (!publishBtn) {
          throw new Error('已自动填好表单,但没找到「发布」按钮,请手动检查并点击发布');
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
