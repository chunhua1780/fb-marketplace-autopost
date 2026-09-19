// popup.js - 依赖 storage.js 提供的 genId / genListing / getListings / saveListings /
// getSettings / getFaqs / saveFaqs 等公共方法(popup.html 里已经先加载了 storage.js)

const els = {
  importStatus: document.getElementById('import-status'),
  scanCurrentBtn: document.getElementById('scan-current-btn'),
  copyDiagnosticsBtn: document.getElementById('copy-diagnostics-btn'),
  scanResults: document.getElementById('scan-results'),
  scanList: document.getElementById('scan-list'),
  selectAllBtn: document.getElementById('select-all-btn'),
  selectNoneBtn: document.getElementById('select-none-btn'),
  importSelectedBtn: document.getElementById('import-selected-btn'),
  importProgress: document.getElementById('import-progress'),

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
};

let currentPhotos = []; // { name, dataUrl }[]
let scannedItems = []; // 最近一次「扫描当前页面」的结果
let scanTabId = null; // 被扫描的那个标签页 id
let lastDiagnostics = null; // 最近一次扫描的页面诊断信息,出问题时可以复制给开发者

const STATUS_LABEL = {
  pending: '待发布',
  running: '发布中...',
  filled_awaiting_review: '已填表,待你确认发布',
  posted: '已发布',
  imported: '已从 Facebook 导入(未在队列中)',
  failed: '失败',
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
  els.formTitle.textContent = '手动新增商品';
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
    alert('请填写标题');
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
  els.formTitle.textContent = '编辑商品';
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
  if (!confirm('确定从插件里删除这个商品吗?(不会影响它在 Facebook 上是否存在)')) return;
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
  if (!res || !res.ok) alert('无法开始重新上架: ' + (res && res.error));
}

async function renderList() {
  const listings = await getListings();
  els.list.innerHTML = '';
  if (!listings.length) {
    els.list.innerHTML = '<li class="empty">还没有商品——可以在上面「扫描当前页面」导入,或者手动新增一个</li>';
    return;
  }
  listings.forEach((l) => {
    const li = document.createElement('li');
    li.className = 'listing-item status-' + l.status;
    li.innerHTML = `
      <div class="listing-main">
        <strong>${escapeHtml(l.title)}</strong>
        <span class="price">${escapeHtml(l.price || '')}</span>
        <span class="status">${STATUS_LABEL[l.status] || l.status}</span>
      </div>
      ${l.sourceItemId ? '<div class="badge">📥 已关联 Facebook 上的商品</div>' : ''}
      ${l.repostEnabled ? `<div class="badge">🔁 每 ${l.repostIntervalDays || 7} 天自动重新上架</div>` : ''}
      ${l.deleteOldOnRepost ? '<div class="badge">⚠️ 重新上架会自动删旧版本</div>' : ''}
      ${l.lastError ? `<div class="error">${escapeHtml(l.lastError)}</div>` : ''}
      <div class="actions">
        <button data-action="repost">立即重新上架</button>
        <button data-action="edit">编辑</button>
        <button data-action="retry">重设为待发布</button>
        <button data-action="delete" class="danger">删除</button>
      </div>
    `;
    li.querySelector('[data-action="repost"]').addEventListener('click', () => repostNow(l.id));
    li.querySelector('[data-action="edit"]').addEventListener('click', () => editListing(l.id));
    li.querySelector('[data-action="retry"]').addEventListener('click', () => resetStatus(l.id));
    li.querySelector('[data-action="delete"]').addEventListener('click', () => deleteListing(l.id));
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

// ---------- 从当前标签页扫描/导入商品 ----------

async function detectCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.includes('facebook.com/marketplace')) {
    els.importStatus.textContent = '⚠️ 当前标签页不是 Facebook Marketplace 页面。请先在浏览器里切换到你的「我的商品/正在出售」页面,再回来点插件图标。';
    els.scanCurrentBtn.disabled = true;
    scanTabId = null;
    return;
  }
  scanTabId = tab.id;
  // 光看网址不够——先实际连一下插件脚本,确认它真的已经注入到这个页面里了
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'PING' });
    els.importStatus.textContent = `✅ 已连接到当前页面:${tab.url}`;
    els.scanCurrentBtn.disabled = false;
  } catch (err) {
    els.importStatus.textContent =
      `⚠️ 插件脚本还没连上这个页面(${tab.url})。最常见的原因是这个 Facebook 标签页是插件安装/更新之前就开着的——请刷新一下这个标签页(F5),再重新点插件图标。`;
    els.scanCurrentBtn.disabled = true;
  }
}

els.scanCurrentBtn.addEventListener('click', async () => {
  if (!scanTabId) return;
  els.importStatus.textContent = '正在扫描当前页面...';
  try {
    const res = await chrome.tabs.sendMessage(scanTabId, { type: 'SCAN_MY_LISTINGS' });
    if (!res || !res.ok) throw new Error((res && res.error) || '扫描失败');
    scannedItems = res.items;
    lastDiagnostics = res.diagnostics || null;
    els.copyDiagnosticsBtn.disabled = !lastDiagnostics;
    if (!scannedItems.length) {
      const d = lastDiagnostics;
      const counts = d
        ? `诊断:页面共 ${d.totalLinks} 个链接(${d.marketplaceItemLinks} 个是商品链接)、按链接识别到 ${d.foundByItemLinks} 件、按"Mark as sold"按钮识别到 ${d.foundByActionButtons} 件、有没有定位到"正在出售"区块:${d.foundBySection ? '有' : '没有'}。`
        : '';
      const hint =
        d && d.marketplaceItemLinks === 0
          ? '这个页面本身就没有商品卡片的链接——请确认你现在停在的是「我的商品/正在出售」这个具体页面(不是搜索结果页、不是首页)。'
          : '页面上有商品链接,但没能从里面提取出标题/价格——大概率是这个账号的页面结构和预期不一样。';
      els.importStatus.textContent = `没有扫描到商品。${counts}${hint} 点下面「复制诊断信息」把结果发给开发者可以帮忙精确定位。`;
      els.scanResults.hidden = true;
      return;
    }
    els.importStatus.textContent = `扫描到 ${scannedItems.length} 件商品,勾选你要导入的,然后点「导入选中的商品」。`;
    renderScanList();
    els.scanResults.hidden = false;
  } catch (err) {
    els.importStatus.textContent =
      '扫描失败:' + ((err && err.message) || err) + '。如果插件是刚安装/刚更新的,请先刷新一下那个 Facebook 标签页,再重新点扫描(插件脚本需要页面重新加载一次才会生效)。';
  }
});

els.copyDiagnosticsBtn.addEventListener('click', async () => {
  if (!lastDiagnostics) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(lastDiagnostics, null, 2));
    els.importStatus.textContent = '诊断信息已复制到剪贴板,粘贴发给开发者就行。';
  } catch (err) {
    alert('复制失败,你也可以直接看这里:\n' + JSON.stringify(lastDiagnostics, null, 2));
  }
});

function renderScanList() {
  els.scanList.innerHTML = '';
  scannedItems.forEach((it, idx) => {
    const li = document.createElement('li');
    li.className = 'scan-item';
    li.innerHTML = `
      <label class="scan-item-label">
        <input type="checkbox" data-idx="${idx}" checked />
        ${it.thumbUrl ? `<img src="${escapeHtml(it.thumbUrl)}" class="thumb" />` : ''}
        <span class="scan-item-text">${escapeHtml(it.title)}${it.priceText ? ` · ${escapeHtml(it.priceText)}` : ''}</span>
      </label>
    `;
    els.scanList.appendChild(li);
  });
}

els.selectAllBtn.addEventListener('click', () => {
  els.scanList.querySelectorAll('input[type="checkbox"]').forEach((cb) => (cb.checked = true));
});

els.selectNoneBtn.addEventListener('click', () => {
  els.scanList.querySelectorAll('input[type="checkbox"]').forEach((cb) => (cb.checked = false));
});

els.importSelectedBtn.addEventListener('click', async () => {
  const checkedIdx = Array.from(els.scanList.querySelectorAll('input[type="checkbox"]:checked')).map((cb) => Number(cb.dataset.idx));
  const selected = checkedIdx.map((i) => scannedItems[i]);
  if (!selected.length) {
    alert('先勾选至少一个商品');
    return;
  }
  const res = await chrome.runtime.sendMessage({ type: 'IMPORT_SELECTED', items: selected });
  if (!res || !res.ok) alert('无法开始导入: ' + (res && res.error));
});

async function renderImportProgress() {
  const { importProgress } = await chrome.storage.local.get('importProgress');
  if (!importProgress || !importProgress.total) {
    els.importProgress.textContent = '';
    return;
  }
  const done = Math.min(importProgress.done, importProgress.total);
  els.importProgress.textContent = `导入进度:${done} / ${importProgress.total}${done >= importProgress.total ? '(完成)' : ''}`;
}

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
      <button data-action="delete-faq" class="danger">删除</button>
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
    alert('关键词和话术都要填写');
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
  if (!res || !res.ok) alert('无法开始: ' + (res && res.error));
});

els.stopBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'STOP_QUEUE' });
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
  if (changes.importProgress) renderImportProgress();
});

(async function init() {
  await detectCurrentTab();
  await renderList();
  await loadSettings();
  await renderLog();
  await renderFaqs();
  await renderImportProgress();
})();
