// field-utils.js - 多个注入到 Facebook Marketplace 页面的脚本共用的 DOM 辅助方法
// (发布表单 content.js、导入/删除用的 content-item.js 都依赖这里)

const FB_LABELS = {
  title: ['Title', '标题', '標題'],
  price: ['Price', '价格', '價格'],
  description: ['Description', '描述'],
  category: ['Category', '类别', '分類', '類別'],
  condition: ['Condition', '状况', '狀況', '成色'],
  location: ['Location', '地点', '地點'],
  next: ['Next', '下一步'],
  publish: ['Publish', '发布', '發佈', '刊登'],
};

function fbNormalize(text) {
  return (text || '').trim().toLowerCase();
}

function fbTextMatches(elText, candidates) {
  const t = fbNormalize(elText);
  if (!t) return false;
  return candidates.some((c) => t === fbNormalize(c) || t.includes(fbNormalize(c)));
}

function findFieldByLabel(candidates) {
  const controls = Array.from(document.querySelectorAll('input, textarea'));
  for (const el of controls) {
    const aria = el.getAttribute('aria-label');
    if (aria && fbTextMatches(aria, candidates)) return el;
  }
  const labels = Array.from(document.querySelectorAll('label'));
  for (const label of labels) {
    if (fbTextMatches(label.textContent, candidates)) {
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
    if (fbTextMatches(label, candidates)) return el;
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

function fbSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, { timeout = 15000, interval = 300 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = fn();
    if (result) return result;
    await fbSleep(interval);
  }
  return null;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
