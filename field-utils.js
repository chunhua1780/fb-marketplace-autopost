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

// findFieldByLabel 那一套全都是「控件自己的文字/aria-label 里带着字段名」这个
// 假设——类别、成色这种字段在 Facebook 表单里经常不是这样:页面上有一个单独的
// 小标题写着"Category",挨着它的是一个按钮,但按钮上显示的是「当前选中的值」
// 本身(比如"Electronics & Computers"),不会带着"Category"这几个字,前面那
// 一套自然什么都找不到。这里换一个思路:先找一个文字精确等于候选词、自己没有
// 子元素的「纯标题节点」,再从它开始一层层往上爬,每层都找一下里面有没有可
// 点击的控件(排除标题节点自己),找到的第一个就当作是这个标题对应的字段。
function findFieldByNearbyLabel(candidates, root = document) {
  const leafNodes = Array.from(root.querySelectorAll('span, div, label')).filter((el) => el.children.length === 0);
  for (const labelEl of leafNodes) {
    const text = fbNormalize(labelEl.textContent);
    if (!text || !candidates.some((c) => text === fbNormalize(c))) continue;

    let container = labelEl.parentElement;
    for (let hop = 0; hop < 4 && container; hop++) {
      const clickable = Array.from(
        container.querySelectorAll('[role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="menu"], div[role="button"], span[role="button"], button')
      ).find((el) => el !== labelEl);
      if (clickable) return clickable;
      container = container.parentElement;
    }
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
  // 类别/成色先按老办法找,找不到再退回「附近标题」这个办法——这两个字段在
  // Facebook 表单里经常是「独立小标题 + 显示当前值的按钮」这种结构,按钮本身的
  // 文字不带字段名,标准的按标签找字段这一套天生找不到。
  const categoryEl = findFieldByLabel(FB_LABELS.category) || findFieldByNearbyLabel(FB_LABELS.category);
  const conditionEl = findFieldByLabel(FB_LABELS.condition) || findFieldByNearbyLabel(FB_LABELS.condition);
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

  const category = readCurrentValue(categoryEl);
  const condition = readCurrentValue(conditionEl);

  // 类别/成色在 Facebook 的编辑表单里经常不是普通的下拉框,而是一个「点了会
  // 弹出一整棵分类树」的按钮,按钮上显示的文字往往就是当前选中的类别本身(比如
  // "Electronics & Computers"),不会带着「Category」这几个字——我们靠标签文字
  // 找字段这一套(findFieldByLabel)就完全找不到它,读出来就是空的。读不到的话
  // 顺手把表单区域里所有「看起来像下拉/按钮」的元素文字都列一份,方便定位到底
  // 类别控件长什么样、该怎么改。
  let categoryConditionDiag = null;
  if (!category || !condition) {
    categoryConditionDiag = Array.from(
      formRoot.querySelectorAll('[role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="menu"], div[role="button"], span[role="button"]')
    )
      .map((el) => (el.getAttribute('aria-label') || el.textContent || '').trim())
      .filter(Boolean)
      .slice(0, 20);
  }

  return {
    title: readCurrentValue(titleEl),
    price: readCurrentValue(priceEl),
    description: readCurrentValue(descEl),
    category,
    condition,
    location: readCurrentValue(locationEl),
    photos,
    categoryConditionDiag,
  };
}

// 出问题时收集一点页面结构信息(不含用户输入的具体商品内容),方便反馈给开发者
// 定位是哪里的选择器失效了。
//
// 之前这里是不分青红皂白地取页面上前 20 个按钮——Facebook 顶部导航栏(返回、
// 通知、头像菜单……)在 DOM 里排在最前面,20 个名额经常被这些完全无关的按钮
// 占满,真正想看的表单/发布按钮反而一个都拿不到。现在把明显是顶部导航栏/页头
// 里的按钮排除掉,并且额外单独找一遍文字里带「发布/下一步/continue/publish/
// next」这些关键词的元素——不管它在不在前 20 个里,只要页面上存在,都会被
// 列出来,包括是不是被禁用(aria-disabled),这是排查"找不到发布按钮"这类问题
// 最直接有用的信息。
function collectDiagnostics() {
  const isChrome = (el) => !!el.closest('header, nav, [role="navigation"], [role="banner"]');
  const clickableSelector = 'div[role="button"], span[role="button"], button, a[role="button"], [role="menuitem"], [role="tab"]';
  const allClickables = Array.from(document.querySelectorAll(clickableSelector));
  const textOf = (el) => (el.getAttribute('aria-label') || el.textContent || '').trim();
  const isDisabled = (el) => el.getAttribute('aria-disabled') === 'true' || el.disabled === true;

  const contentButtons = allClickables
    .filter((el) => !isChrome(el))
    .map(textOf)
    .filter(Boolean)
    .slice(0, 30);

  const publishLikeButtons = allClickables
    .map((el) => ({ text: textOf(el), disabled: isDisabled(el), inChrome: isChrome(el) }))
    .filter((b) => b.text && /publish|next|continue|发布|下一步|继续|刊登/i.test(b.text));

  const itemLinks = Array.from(document.querySelectorAll('a[href*="/marketplace/item/"]')).length;
  const allLinks = document.querySelectorAll('a').length;
  return {
    url: location.href,
    pageTitle: document.title,
    totalLinks: allLinks,
    marketplaceItemLinks: itemLinks,
    totalClickables: allClickables.length,
    sampleButtonTexts: contentButtons,
    publishLikeButtons,
  };
}
