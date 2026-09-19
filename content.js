// content.js - 注入到 Facebook Marketplace 发布页面,实际找到表单元素并填写
// 注意:Facebook 的页面结构经常调整,这里用「按可见文字/aria-label匹配」的
// 方式尽量兼容改版,如果匹配不到某个字段,会在返回结果里报告具体是哪一步失败。

(function () {
  const LABELS = {
    title: ['Title', '标题', '標題'],
    price: ['Price', '价格', '價格'],
    description: ['Description', '描述'],
    category: ['Category', '类别', '分類', '類別'],
    condition: ['Condition', '状况', '狀況', '成色'],
    location: ['Location', '地点', '地點'],
    next: ['Next', '下一步'],
    publish: ['Publish', '发布', '發佈', '刊登'],
  };

  function normalize(text) {
    return (text || '').trim().toLowerCase();
  }

  function textMatches(elText, candidates) {
    const t = normalize(elText);
    if (!t) return false;
    return candidates.some((c) => t === normalize(c) || t.includes(normalize(c)));
  }

  function findFieldByLabel(candidates) {
    const controls = Array.from(document.querySelectorAll('input, textarea'));
    for (const el of controls) {
      const aria = el.getAttribute('aria-label');
      if (aria && textMatches(aria, candidates)) return el;
    }
    const labels = Array.from(document.querySelectorAll('label'));
    for (const label of labels) {
      if (textMatches(label.textContent, candidates)) {
        if (label.htmlFor) {
          const byId = document.getElementById(label.htmlFor);
          if (byId) return byId;
        }
        const inner = label.querySelector('input, textarea');
        if (inner) return inner;
      }
    }
    return null;
  }

  function findClickableByText(candidates, root = document) {
    const nodes = Array.from(root.querySelectorAll('div[role="button"], span[role="button"], button, a[role="button"]'));
    for (const el of nodes) {
      const label = el.getAttribute('aria-label') || el.textContent;
      if (textMatches(label, candidates)) return el;
    }
    return null;
  }

  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitFor(fn, { timeout = 15000, interval = 300 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const result = fn();
      if (result) return result;
      await sleep(interval);
    }
    return null;
  }

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
    await sleep(1500);
  }

  async function selectFromDropdown(triggerCandidates, optionText) {
    if (!optionText) return;
    const trigger = await waitFor(() => findFieldByLabel(triggerCandidates) || findClickableByText(triggerCandidates));
    if (!trigger) throw new Error(`找不到「${optionText}」对应的选择控件`);
    trigger.click();
    await sleep(400);

    const activeInput = document.activeElement;
    if (activeInput && activeInput.tagName === 'INPUT') {
      setNativeValue(activeInput, optionText);
      await sleep(500);
    }

    const option = await waitFor(() => {
      const options = Array.from(document.querySelectorAll('[role="option"], li'));
      return options.find((o) => normalize(o.textContent).includes(normalize(optionText))) || null;
    }, { timeout: 5000 });

    if (!option) {
      throw new Error(`在下拉列表里没找到「${optionText}」这个选项,请确认文字与 Facebook 页面上显示的完全一致`);
    }
    option.click();
    await sleep(300);
  }

  async function fillListing(listing) {
    const steps = [];
    try {
      steps.push('等待表单加载');
      const titleReady = await waitFor(() => findFieldByLabel(LABELS.title), { timeout: 20000 });
      if (!titleReady) throw new Error('页面加载超时,没有找到标题输入框(可能未登录,或 Facebook 改版)');

      if (listing.photos && listing.photos.length) {
        steps.push('上传照片');
        await attachPhotos(listing.photos);
      }

      steps.push('填写标题');
      const titleEl = findFieldByLabel(LABELS.title);
      if (titleEl) setNativeValue(titleEl, listing.title || '');

      steps.push('填写价格');
      const priceEl = findFieldByLabel(LABELS.price);
      if (priceEl) setNativeValue(priceEl, String(listing.price ?? ''));

      if (listing.category) {
        steps.push('选择类别');
        await selectFromDropdown(LABELS.category, listing.category);
      }

      if (listing.condition) {
        steps.push('选择成色');
        await selectFromDropdown(LABELS.condition, listing.condition);
      }

      steps.push('填写描述');
      const descEl = findFieldByLabel(LABELS.description);
      if (descEl) setNativeValue(descEl, listing.description || '');

      if (listing.location) {
        steps.push('填写地点');
        const locEl = findFieldByLabel(LABELS.location);
        if (locEl) {
          setNativeValue(locEl, listing.location);
          await sleep(800);
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
          publishBtn = findClickableByText(LABELS.publish);
          if (publishBtn) break;
          const nextBtn = findClickableByText(LABELS.next);
          if (!nextBtn) break;
          nextBtn.click();
          await sleep(1200);
        }
        if (!publishBtn) {
          throw new Error('已自动填好表单,但没找到「发布」按钮,请手动检查并点击发布');
        }
        publishBtn.click();
        await sleep(1500);
        return { ok: true, published: true, steps };
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
