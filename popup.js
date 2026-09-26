// popup.js - 依赖 storage.js 提供的 genId / genListing / getListings / saveListings /
// getSettings / getFaqs / saveFaqs 等公共方法(popup.html 里已经先加载了 storage.js)

// 任何没被 try/catch 接住的报错(包括异步的),都直接显示在面板最上面,方便
// 用户截图反馈——不然出错时面板可能看起来"整个打不开",但其实只是某一小块坏了。
function showFatalError(text) {
  const div = document.createElement('div');
  div.style.cssText = 'background:#fde2e1;color:#c0362c;padding:8px;margin-bottom:8px;border-radius:6px;font-size:12px;font-weight:bold;white-space:pre-wrap;';
  div.textContent = '[插件出错] ' + text;
  document.body.insertBefore(div, document.body.firstChild);
}
window.addEventListener('error', (e) => showFatalError(e.message));
window.addEventListener('unhandledrejection', (e) => showFatalError((e.reason && e.reason.message) || String(e.reason)));

const els = {
  uiLang: document.getElementById('ui-lang'),
  filestoreStatus: document.getElementById('filestore-status'),
  pickFolderBtn: document.getElementById('pick-folder-btn'),
  clearFolderBtn: document.getElementById('clear-folder-btn'),
  importStatus: document.getElementById('import-status'),
  startSelectBtn: document.getElementById('start-select-btn'),
  stopSelectBtn: document.getElementById('stop-select-btn'),
  selectProgress: document.getElementById('select-progress'),

  title: document.getElementById('f-title'),
  price: document.getElementById('f-price'),
  category: document.getElementById('f-category'),
  condition: document.getElementById('f-condition'),
  location: document.getElementById('f-location'),
  description: document.getElementById('f-description'),
  photos: document.getElementById('f-photos'),
  photoPreview: document.getElementById('photo-preview'),
  repostEnabled: document.getElementById('f-repost-enabled'),
  repostDaysWrap: document.getElementById('f-repost-days-wrap'),
  repostDays: document.getElementById('f-repost-days'),
  deleteOldWrap: document.getElementById('f-delete-old-wrap'),
  deleteOld: document.getElementById('f-delete-old'),
  editingId: document.getElementById('editing-id'),
  formTitle: document.getElementById('form-title'),
  saveBtn: document.getElementById('save-btn'),
  cancelEditBtn: document.getElementById('cancel-edit-btn'),
  list: document.getElementById('listing-list'),
  repostAllBtn: document.getElementById('repost-all-btn'),

  sMin: document.getElementById('s-min'),
  sMax: document.getElementById('s-max'),
  sAutoPublish: document.getElementById('s-autopublish'),
  sAutoDeleteOld: document.getElementById('s-auto-delete-old'),
  saveSettingsBtn: document.getElementById('save-settings-btn'),

  sAddress: document.getElementById('s-address'),
  sPurchase: document.getElementById('s-purchase'),
  saveSellerBtn: document.getElementById('save-seller-btn'),

  arEnabled: document.getElementById('ar-enabled'),
  arDryrun: document.getElementById('ar-dryrun'),
  arMaxPerDay: document.getElementById('ar-max-per-day'),
  arCooldown: document.getElementById('ar-cooldown'),
  arAiEnabled: document.getElementById('ar-ai-enabled'),
  arAiKey: document.getElementById('ar-ai-key'),
  arAiModel: document.getElementById('ar-ai-model'),
  saveAutoReplyBtn: document.getElementById('save-autoreply-btn'),

  faqList: document.getElementById('faq-list'),
  faqKeywords: document.getElementById('faq-keywords'),
  faqAnswer: document.getElementById('faq-answer'),
  faqAddBtn: document.getElementById('faq-add-btn'),

  startBtn: document.getElementById('start-btn'),
  stopBtn: document.getElementById('stop-btn'),
  log: document.getElementById('log'),
  debugSection: document.getElementById('debug-section'),
  debugDataDisplay: document.getElementById('debug-data-display'),
  clearDebugBtn: document.getElementById('clear-debug-btn'),
};

let currentPhotos = []; // { name, dataUrl }[]
let scanTabId = null; // 当前 Facebook 标签页 id

const STATUS_KEY = {
  pending: 'statusPending',
  running: 'statusRunning',
  filled_awaiting_review: 'statusFilledAwaitingReview',
  posted: 'statusPosted',
  imported: 'statusImported',
  reading_details: 'statusReadingDetails',
  failed: 'statusFailed',
};

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderPhotoPreview() {
  els.photoPreview.innerHTML = '';
  currentPhotos.forEach((p) => {
    const img = document.createElement('img');
    img.src = p.dataUrl;
    img.className = 'thumb';
    els.photoPreview.appendChild(img);
  });
}

els.repostEnabled.addEventListener('change', () => {
  els.repostDaysWrap.hidden = !els.repostEnabled.checked;
});

function resetForm() {
  els.editingId.value = '';
  els.formTitle.textContent = t('formTitleAdd');
  els.title.value = '';
  els.price.value = '';
  els.category.value = '';
  els.condition.value = '';
  els.location.value = '';
  els.description.value = '';
  els.photos.value = '';
  els.repostEnabled.checked = false;
  els.repostDays.value = 7;
  els.repostDaysWrap.hidden = true;
  els.deleteOld.checked = false;
  els.deleteOldWrap.hidden = true;
  currentPhotos = [];
  renderPhotoPreview();
  els.cancelEditBtn.hidden = true;
}

els.photos.addEventListener('change', async () => {
  const files = Array.from(els.photos.files || []);
  currentPhotos = await Promise.all(files.map(async (f) => ({ name: f.name, dataUrl: await fileToDataUrl(f) })));
  renderPhotoPreview();
});

els.saveBtn.addEventListener('click', async () => {
  const title = els.title.value.trim();
  if (!title) {
    alert(t('alertTitleRequired'));
    return;
  }
  const listings = await getListings();
  const editingId = els.editingId.value;
  const data = {
    title,
    price: els.price.value.trim(),
    category: els.category.value.trim(),
    condition: els.condition.value.trim(),
    location: els.location.value.trim(),
    description: els.description.value.trim(),
    photos: currentPhotos,
    repostEnabled: els.repostEnabled.checked,
    repostIntervalDays: Number(els.repostDays.value) || 7,
    deleteOldOnRepost: els.deleteOld.checked,
  };
  if (editingId) {
    const idx = listings.findIndex((l) => l.id === editingId);
    if (idx !== -1) listings[idx] = { ...listings[idx], ...data };
  } else {
    listings.push(genListing(data));
  }
  await saveListings(listings);
  resetForm();
  await renderList();
});

els.cancelEditBtn.addEventListener('click', resetForm);

async function editListing(id) {
  const listings = await getListings();
  const l = listings.find((x) => x.id === id);
  if (!l) return;
  els.editingId.value = l.id;
  els.formTitle.textContent = t('formTitleEdit');
  els.title.value = l.title || '';
  els.price.value = l.price || '';
  els.category.value = l.category || '';
  els.condition.value = l.condition || '';
  els.location.value = l.location || '';
  els.description.value = l.description || '';
  els.repostEnabled.checked = !!l.repostEnabled;
  els.repostDays.value = l.repostIntervalDays || 7;
  els.repostDaysWrap.hidden = !l.repostEnabled;
  // 只有关联着真实 Facebook 商品(导入过,或已经自动发布过一次)才需要「删除旧版本」这个选项
  els.deleteOldWrap.hidden = !l.sourceItemId;
  els.deleteOld.checked = !!l.deleteOldOnRepost;
  currentPhotos = l.photos || [];
  renderPhotoPreview();
  els.cancelEditBtn.hidden = false;
}

async function deleteListing(id) {
  if (!confirm(t('confirmDeleteListing'))) return;
  const listings = await getListings();
  await saveListings(listings.filter((l) => l.id !== id));
  await renderList();
}

async function resetStatus(id) {
  const listings = await getListings();
  const idx = listings.findIndex((l) => l.id === id);
  if (idx !== -1) {
    listings[idx].status = 'pending';
    listings[idx].lastError = null;
    await saveListings(listings);
  }
  await renderList();
}

async function repostNow(id) {
  const res = await chrome.runtime.sendMessage({ type: 'REPOST_NOW', id });
  if (!res || !res.ok) alert(t('alertRepostFail', { error: res && res.error }));
}

els.repostAllBtn.addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'REPOST_ALL' });
  if (!res || !res.ok) alert(t('alertRepostFail', { error: res && res.error }));
});

async function renderList() {
  const listings = await getListings();
  els.list.innerHTML = '';
  if (!listings.length) {
    els.list.innerHTML = `<li class="empty">${escapeHtml(t('listEmpty'))}</li>`;
    return;
  }
  listings.forEach((l, i) => {
    const li = document.createElement('li');
    li.className = 'listing-item status-' + l.status;
    // 缩略图优先用已经下载好的第一张图(数据在本地,不会因为图挂了就空着);
    // 还没下载完的话,先用秒选那一刻从 Facebook 页面上抓到的缩略图链接顶一下,
    // 让用户点了 1、2、3、4 个商品之后马上就能在列表里看到分别是哪个东西。
    const thumbSrc = (l.photos && l.photos[0] && l.photos[0].dataUrl) || l.thumbUrl || '';
    li.innerHTML = `
      <div class="listing-main">
        ${thumbSrc ? `<img class="thumb" src="${escapeHtml(thumbSrc)}" alt="" />` : '<div class="thumb thumb-empty"></div>'}
        <div class="listing-text">
          <strong>#${i + 1} ${escapeHtml(l.title)}</strong>
          <span class="price">${escapeHtml(l.price || '')}</span>
          <span class="status">${t(STATUS_KEY[l.status] || l.status)}</span>
        </div>
      </div>
      ${
        l.sourceItemId
          ? `<div class="badge">${escapeHtml(t('badgeLinkedFb', { id: l.sourceItemId.slice(-6) }))}</div>`
          : ''
      }
      ${l.repostEnabled ? `<div class="badge">${escapeHtml(t('badgeRepost', { days: l.repostIntervalDays || 7 }))}</div>` : ''}
      ${l.deleteOldOnRepost ? `<div class="badge">${escapeHtml(t('badgeDeleteOld'))}</div>` : ''}
      ${l.lastError ? `<div class="error">${escapeHtml(l.lastError)}</div>` : ''}
      <div class="actions">
        <button data-action="repost">${escapeHtml(t('actionRepost'))}</button>
        <button data-action="edit">${escapeHtml(t('actionEdit'))}</button>
        <button data-action="retry">${escapeHtml(t('actionRetry'))}</button>
        <button data-action="delete" class="danger">${escapeHtml(t('actionDelete'))}</button>
      </div>
    `;
    li.querySelector('[data-action="repost"]').addEventListener('click', () => repostNow(l.id));
    li.querySelector('[data-action="edit"]').addEventListener('click', () => editListing(l.id));
    li.querySelector('[data-action="retry"]').addEventListener('click', () => resetStatus(l.id));
    li.querySelector('[data-action="delete"]').addEventListener('click', () => deleteListing(l.id));
    const thumbImg = li.querySelector('img.thumb');
    if (thumbImg) thumbImg.addEventListener('error', () => thumbImg.remove(), { once: true });
    els.list.appendChild(li);
  });
}

async function loadSettings() {
  const settings = await getSettings();

  els.sMin.value = settings.minDelaySeconds;
  els.sMax.value = settings.maxDelaySeconds;
  els.sAutoPublish.checked = !!settings.autoPublish;
  els.sAutoDeleteOld.checked = !!settings.autoDeleteOldListings;

  els.sAddress.value = settings.sellerAddress;
  els.sPurchase.value = settings.purchaseMethods;

  els.arEnabled.checked = !!settings.autoReplyEnabled;
  els.arDryrun.checked = settings.autoReplyDryRun !== false;
  els.arMaxPerDay.value = settings.maxAutoRepliesPerDay;
  els.arCooldown.value = settings.perThreadCooldownSeconds;
  els.arAiEnabled.checked = !!settings.aiModeEnabled;
  els.arAiKey.value = settings.aiApiKey;
  els.arAiModel.value = settings.aiModel;
}

// ---------- 点选式导入 ----------
// 不再靠代码去猜页面结构,而是让用户自己在 Facebook 页面上点要导入的商品,
// 插件只负责在点击发生时把信息接住(见 content-my-listings.js)。点一下就会
// 立刻读完完整信息存进商品队列,这里只管面板上的开关按钮和进度提示。

async function detectCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.includes('facebook.com/marketplace/you/')) {
    els.importStatus.textContent = t('importStatusNotFb');
    els.startSelectBtn.disabled = true;
    scanTabId = null;
    return;
  }
  scanTabId = tab.id;
  // 光看网址不够——先实际连一下插件脚本,确认它真的已经注入到这个页面里了
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'PING' });
    els.importStatus.textContent = t('importStatusConnected', { url: tab.url });
    els.startSelectBtn.disabled = false;
  } catch (err) {
    els.importStatus.textContent = t('importStatusNotConnected', { url: tab.url, error: (err && err.message) || err });
    els.startSelectBtn.disabled = true;
  }
}

async function refreshSelectModeUi() {
  const { selectModeActive } = await chrome.storage.local.get('selectModeActive');
  els.startSelectBtn.hidden = !!selectModeActive;
  els.stopSelectBtn.hidden = !selectModeActive;
  els.selectProgress.textContent = selectModeActive ? t('selectModeOn') : '';
}

els.startSelectBtn.addEventListener('click', async () => {
  if (!scanTabId) return;
  const res = await chrome.tabs.sendMessage(scanTabId, { type: 'START_SELECT_MODE' }).catch((err) => ({ ok: false, error: err.message }));
  if (!res || !res.ok) {
    els.importStatus.textContent = t('startSelectFailed', { error: res && res.error });
    return;
  }
  await refreshSelectModeUi();
});

els.stopSelectBtn.addEventListener('click', async () => {
  if (scanTabId) {
    await chrome.tabs.sendMessage(scanTabId, { type: 'STOP_SELECT_MODE' }).catch(() => {});
  } else {
    await chrome.storage.local.set({ selectModeActive: false });
  }
  await refreshSelectModeUi();
});

// ---------- 本地文件夹镜像 ----------

async function refreshFilestoreStatus() {
  if (typeof window.showDirectoryPicker !== 'function') {
    els.filestoreStatus.textContent = t('filestoreUnsupported');
    els.pickFolderBtn.disabled = true;
    return;
  }
  const handle = await getSavedDirHandle();
  if (!handle) {
    els.filestoreStatus.textContent = t('filestoreNotSet');
    return;
  }
  const granted = await hasWritableFolderAccess();
  els.filestoreStatus.textContent = granted ? t('filestoreGranted') : t('filestoreNeedsReauth');
}

els.pickFolderBtn.addEventListener('click', async () => {
  try {
    await pickSaveFolder();
  } catch (err) {
    // 用户自己点了取消(AbortError)不算错误,不用提示
    if (err && err.name !== 'AbortError') {
      els.filestoreStatus.textContent = t('filestorePickFailed', { error: (err && err.message) || err });
    }
  }
  await refreshFilestoreStatus();
});

els.clearFolderBtn.addEventListener('click', async () => {
  await clearSavedDirHandle();
  els.filestoreStatus.textContent = t('filestoreCleared');
});

els.saveSettingsBtn.addEventListener('click', async () => {
  const settings = await getSettings();
  await saveSettings({
    ...settings,
    minDelaySeconds: Number(els.sMin.value) || 60,
    maxDelaySeconds: Number(els.sMax.value) || 150,
    autoPublish: els.sAutoPublish.checked,
    autoDeleteOldListings: els.sAutoDeleteOld.checked,
  });
});

els.saveSellerBtn.addEventListener('click', async () => {
  const settings = await getSettings();
  await saveSettings({
    ...settings,
    sellerAddress: els.sAddress.value.trim(),
    purchaseMethods: els.sPurchase.value.trim(),
  });
});

els.saveAutoReplyBtn.addEventListener('click', async () => {
  const settings = await getSettings();
  await saveSettings({
    ...settings,
    autoReplyEnabled: els.arEnabled.checked,
    autoReplyDryRun: els.arDryrun.checked,
    maxAutoRepliesPerDay: Number(els.arMaxPerDay.value) || 40,
    perThreadCooldownSeconds: Number(els.arCooldown.value) || 20,
    aiModeEnabled: els.arAiEnabled.checked,
    aiApiKey: els.arAiKey.value.trim(),
    aiModel: els.arAiModel.value.trim() || 'claude-haiku-4-5',
  });
});

async function renderFaqs() {
  const faqs = await getFaqs();
  els.faqList.innerHTML = '';
  faqs.forEach((f) => {
    const li = document.createElement('li');
    li.className = 'faq-item';
    li.innerHTML = `
      <div class="faq-keywords">${escapeHtml(f.keywords)}</div>
      <div class="faq-answer">${escapeHtml(f.answer)}</div>
      <button data-action="delete-faq" class="danger">${escapeHtml(t('faqDeleteBtn'))}</button>
    `;
    li.querySelector('[data-action="delete-faq"]').addEventListener('click', async () => {
      const rest = (await getFaqs()).filter((x) => x.id !== f.id);
      await saveFaqs(rest);
      await renderFaqs();
    });
    els.faqList.appendChild(li);
  });
}

els.faqAddBtn.addEventListener('click', async () => {
  const keywords = els.faqKeywords.value.trim();
  const answer = els.faqAnswer.value.trim();
  if (!keywords || !answer) {
    alert(t('alertFaqRequired'));
    return;
  }
  const faqs = await getFaqs();
  faqs.push({ id: genId(), keywords, answer });
  await saveFaqs(faqs);
  els.faqKeywords.value = '';
  els.faqAnswer.value = '';
  await renderFaqs();
});

els.startBtn.addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'START_QUEUE' });
  if (!res || !res.ok) alert(t('alertQueueFail', { error: res && res.error }));
});

els.stopBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'STOP_QUEUE' });
});

// 「读取详情彻底失败」且网络那边拦到了响应、但认不出商品数据时,content-item.js
// 会把拦到的原始数据样本存进 chrome.storage.local——之前做法是要用户点按钮导出
// 成一个文件再自己去下载文件夹里找,实测下来用户找不到下载的文件、也分不清
// "复制文字"和"发送文件"的区别。现在改成最简单直接的办法:数据一存进
// storage,面板里这块区域就自动出现、内容直接摆在一个文本框里,用户只要点
// 一下、全选、复制粘贴发过来就行,不需要去理解"下载文件"这件事。
async function renderDebugData() {
  const { lastDebugCapture } = await chrome.storage.local.get('lastDebugCapture');
  if (!lastDebugCapture) {
    els.debugSection.style.display = 'none';
    return;
  }
  els.debugSection.style.display = '';
  els.debugDataDisplay.value = JSON.stringify(lastDebugCapture, null, 2);
}

els.clearDebugBtn.addEventListener('click', async () => {
  await chrome.storage.local.remove('lastDebugCapture');
  await renderDebugData();
});

async function renderLog() {
  const { runLog = [] } = await chrome.storage.local.get('runLog');
  els.log.innerHTML = '';
  runLog.slice().reverse().forEach((entry) => {
    const div = document.createElement('div');
    div.className = 'log-' + (entry.level || 'info');
    div.textContent = `[${new Date(entry.time).toLocaleTimeString()}] ${entry.text}`;
    els.log.appendChild(div);
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.listings) renderList();
  if (changes.runLog) renderLog();
  if (changes.faqs) renderFaqs();
  if (changes.selectModeActive) refreshSelectModeUi();
  if (changes.lastDebugCapture) renderDebugData();
});

// 用这个包一层,是为了防止某一步(比如检测当前标签页)出问题时把整个初始化
// 流程卡死,导致面板剩下的部分(商品列表、设置等)全都出不来、看起来像是
// "插件完全打不开"。出错时会直接把错误文字写在面板最上面,方便截图反馈。
async function safeRun(label, fn) {
  try {
    await fn();
  } catch (err) {
    showFatalError(`初始化「${label}」时: ${(err && err.message) || err}`);
  }
}

function renderVersionBadge() {
  const badge = document.getElementById('version-badge');
  if (badge) badge.textContent = 'v' + chrome.runtime.getManifest().version;
}

// 面板本身的界面语言(不影响 Facebook 网页、也不影响重新上架时填进表单的商品
// 内容本身)。默认英文,选一次会记住,下次打开面板直接生效。
async function renderAllDynamic() {
  await safeRun('current tab', detectCurrentTab);
  await safeRun('select mode', refreshSelectModeUi);
  await safeRun('folder mirror', refreshFilestoreStatus);
  await safeRun('listings', renderList);
  await safeRun('settings', loadSettings);
  await safeRun('log', renderLog);
  await safeRun('faqs', renderFaqs);
  await safeRun('debug data', renderDebugData);
}

els.uiLang.addEventListener('change', async () => {
  await setLang(els.uiLang.value);
  applyStaticTranslations();
  await renderAllDynamic();
});

// 侧边栏不会自己跟着"当前标签页切换了"这件事重新判断连接状态——之前只在
// 面板刚打开那一刻检测一次,用户如果是先开着面板、再切到/刷新 Facebook 那个
// 标签页,面板显示的还是刚打开时的旧状态,必须关掉面板重开才会刷新,体验上
// 就像是"必须关闭网页/插件重新打开才能选产品"。这里监听标签页切换/刷新/网址
// 变化,自动重新检测,不需要用户手动关开面板。
chrome.tabs.onActivated.addListener(() => {
  safeRun('current tab', detectCurrentTab);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete' || changeInfo.url) {
    safeRun('current tab', detectCurrentTab);
  }
});

(async function init() {
  await loadLang();
  els.uiLang.value = currentLang;
  applyStaticTranslations();
  renderVersionBadge();
  await renderAllDynamic();
})();
