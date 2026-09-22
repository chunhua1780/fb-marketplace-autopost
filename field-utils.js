// field-utils.js - 多个注入到 Facebook Marketplace 页面的脚本共用的 DOM 辅助方法
// (发布表单 content.js、导入/删除/扫描用的 content-item.js / content-my-listings.js
// 都依赖这里)。这些选择器都是根据 Facebook 常见的 DOM 写法(aria-label、role
// 属性)做的启发式匹配,不是官方接口,Facebook 改版可能会让它们失效——所以这里
// 尽量对每一种信息都准备了不止一种查找方式,找不到时也会收集诊断信息方便定位。

// 用 window.FB_LABELS 而不是顶层 const 来定义,是因为现在有几个 content_scripts
// 的 matches 范围会互相重叠(比如商品管理页的广泛匹配会盖到发布页/单品页),
// 同一个页面上 field-utils.js 可能被注入不止一次——顶层 const 被执行第二次会直接
// 报 "already been declared" 让整个内容脚本崩掉。用这种写法即使被注入多次也没事。
if (typeof globalThis.FB_LABELS === 'undefined') {
  globalThis.FB_LABELS = {
    title: ['Title', '标题', '標題'],
    price: ['Price', '价格', '價格'],
    description: ['Description', '描述'],
    category: ['Category', '类别', '分類', '類別'],
    condition: ['Condition', '状况', '狀況', '成色'],
    location: ['Location', '地点', '地點'],
    next: ['Next', '下一步'],
    publish: ['Publish', '发布', '發佈', '刊登'],
    editListing: ['Edit listing', 'Edit Listing', '编辑商品', '編輯商品', 'Edit'],
  };
}

function fbNormalize(text) {
  return (text || '').trim().toLowerCase();
}

function fbTextMatches(elText, candidates) {
  const t = fbNormalize(elText);
  if (!t) return false;
  return candidates.some((c) => t === fbNormalize(c) || t.includes(fbNormalize(c)));
}

// 依次尝试:input/textarea/select 的 aria-label → <label> 关联的控件 →
// 有 role="combobox"/aria-haspopup 的按钮(Facebook 很多下拉选择其实是按钮+弹层,
// 不是原生 <select>)。找到第一个匹配的就返回。
function findFieldByLabel(candidates, root = document) {
  const controls = Array.from(root.querySelectorAll('input, textarea, select'));
  for (const el of controls) {
    const aria = el.getAttribute('aria-label');
    if (aria && fbTextMatches(aria, candidates)) return el;
  }

  const labels = Array.from(root.querySelectorAll('label'));
  for (const label of labels) {
    if (fbTextMatches(label.textContent, candidates)) {
      if (label.htmlFor) {
        const byId = document.getElementById(label.htmlFor);
        if (byId) return byId;
      }
      const inner = label.querySelector('input, textarea, select');
      if (inner) return inner;
    }
  }

  const comboboxes = Array.from(
    root.querySelectorAll('[role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="menu"]')
  );
  for (const el of comboboxes) {
    const aria = el.getAttribute('aria-label') || el.textContent;
    if (aria && fbTextMatches(aria, candidates)) return el;
  }

  return null;
}

function findClickableByText(candidates, root = document) {
  const nodes = Array.from(
    root.querySelectorAll('div[role="button"], span[role="button"], button, a[role="button"], [role="menuitem"]')
  );
  for (const el of nodes) {
    const label = el.getAttribute('aria-label') || el.textContent;
    if (fbTextMatches(label, candidates)) return el;
  }
  return null;
}

// 读取一个字段控件「现在显示的值」——input/textarea 用 .value,<select> 用选中项
// 的文字(而不是可能是内部代码的 value 属性),其他(按钮/combobox 之类)就退回
// 读可见文字。
function readCurrentValue(el) {
  if (!el) return '';
  if (el.tagName === 'SELECT') {
    const opt = el.options[el.selectedIndex];
    return opt ? opt.text.trim() : '';
  }
  if ('value' in el && el.value) return el.value;
  return fbNormalize(el.textContent);
}

function setNativeValue(el, value) {
  if (el.tagName === 'SELECT') {
    const opt = Array.from(el.options).find((o) => fbTextMatches(o.text, [value]));
    if (opt) el.value = opt.value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
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

// 找到「真正会滚动加载更多内容」的元素。Facebook 的列表经常放在一个有自己
// overflow:auto 的内层容器里,而不是整个网页窗口本身,只滚 window 不会触发懒
// 加载。从传入的元素开始往上找第一个「内容比可视区域高、并且样式允许滚动」的
// 祖先节点;找不到就返回 null(调用方再退回滚 window)。
function findScrollableAncestor(el) {
  let node = el && el.parentElement;
  let hops = 0;
  while (node && hops < 12) {
    const style = window.getComputedStyle(node);
    const canScroll = /(auto|scroll)/.test(style.overflowY);
    if (canScroll && node.scrollHeight > node.clientHeight + 40) {
      return node;
    }
    node = node.parentElement;
    hops += 1;
  }
  return null;
}

// 确保编辑表单当前已经展开、标题输入框已经出现。有的情况下打开的不是直接可
// 编辑的表单(比如详情弹窗要再点一下「Edit Listing」才会展开成表单),这个函数
// 会自动尝试点一下再等一次。content-item.js 和 content-my-listings.js 共用。
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

// 找一个「刚好包住这几个已知表单字段」的容器,用来把图片搜索范围收窄到这条
// 商品自己的编辑区域——不这么做的话,图片搜索会跑到整个网页,把侧边栏「相关
// 商品推荐」、导航栏头像之类别的商品的图也一起当成这条商品的照片抓下来,导致
// 重新上架的商品带着不相关的图。已知字段有两个以上时,从其中一个往上爬,直到
// 找到同时包住所有已知字段的祖先节点;只有一个字段时没法这样定位,退而求其次
// 往上爬固定几层,大致等于整个表单区块的大小。
function findFormRoot(elements) {
  const els = elements.filter(Boolean);
  if (els.length >= 2) {
    let node = els[0].parentElement;
    while (node && node !== document.body) {
      if (els.every((el) => node.contains(el))) return node;
      node = node.parentElement;
    }
  } else if (els.length === 1) {
    let node = els[0];
    for (let i = 0; i < 6 && node.parentElement; i++) node = node.parentElement;
    return node;
  }
  return document;
}

// 读取「当前页面上正在显示的」商品编辑表单字段 + 图片。不管这个表单是整页的
// 编辑页,还是弹窗里临时展开的编辑区,只要标题输入框已经出现在页面上,这个
// 函数都能用——content-item.js(整页编辑)和 content-my-listings.js(弹窗内
// 编辑)共用同一套逻辑,不用各写一份。
async function scrapeVisibleListingForm() {
  const titleEl = findFieldByLabel(FB_LABELS.title);
  const priceEl = findFieldByLabel(FB_LABELS.price);
  const descEl = findFieldByLabel(FB_LABELS.description);
  const categoryEl = findFieldByLabel(FB_LABELS.category);
  const conditionEl = findFieldByLabel(FB_LABELS.condition);
  const locationEl = findFieldByLabel(FB_LABELS.location);

  const formRoot = findFormRoot([titleEl, priceEl, descEl, categoryEl, conditionEl, locationEl]);

  const photos = [];
  const imgs = Array.from(formRoot.querySelectorAll('img'))
    .filter((img) => img.naturalWidth > 80 && img.naturalHeight > 80 && /^https?:/.test(img.src))
    .slice(0, 20);
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

// 出问题时收集一点页面结构信息(不含用户输入的具体商品内容),方便反馈给开发者
// 定位是哪里的选择器失效了。
function collectDiagnostics() {
  const buttons = Array.from(document.querySelectorAll('div[role="button"], button, a[role="button"]'))
    .map((el) => (el.getAttribute('aria-label') || el.textContent || '').trim())
    .filter(Boolean)
    .slice(0, 20);
  const itemLinks = Array.from(document.querySelectorAll('a[href*="/marketplace/item/"]')).length;
  const allLinks = document.querySelectorAll('a').length;
  return {
    url: location.href,
    pageTitle: document.title,
    totalLinks: allLinks,
    marketplaceItemLinks: itemLinks,
    sampleButtonTexts: buttons,
  };
}
