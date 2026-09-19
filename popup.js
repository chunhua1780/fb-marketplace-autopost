const els = {
  title: document.getElementById('f-title'),
  price: document.getElementById('f-price'),
  category: document.getElementById('f-category'),
  condition: document.getElementById('f-condition'),
  location: document.getElementById('f-location'),
  description: document.getElementById('f-description'),
  photos: document.getElementById('f-photos'),
  photoPreview: document.getElementById('photo-preview'),
  editingId: document.getElementById('editing-id'),
  formTitle: document.getElementById('form-title'),
  saveBtn: document.getElementById('save-btn'),
  cancelEditBtn: document.getElementById('cancel-edit-btn'),
  list: document.getElementById('listing-list'),
  sMin: document.getElementById('s-min'),
  sMax: document.getElementById('s-max'),
  sAutoPublish: document.getElementById('s-autopublish'),
  saveSettingsBtn: document.getElementById('save-settings-btn'),
  startBtn: document.getElementById('start-btn'),
  stopBtn: document.getElementById('stop-btn'),
  log: document.getElementById('log'),
};

let currentPhotos = []; // { name, dataUrl }[]

const STATUS_LABEL = {
  pending: '待发布',
  running: '发布中...',
  filled_awaiting_review: '已填表,待你确认发布',
  posted: '已发布',
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

function genId() {
  return 'l_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

async function getListings() {
  const { listings = [] } = await chrome.storage.local.get('listings');
  return listings;
}

async function saveListings(listings) {
  await chrome.storage.local.set({ listings });
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

function resetForm() {
  els.editingId.value = '';
  els.formTitle.textContent = '新增商品';
  els.title.value = '';
  els.price.value = '';
  els.category.value = '';
  els.condition.value = '';
  els.location.value = '';
  els.description.value = '';
  els.photos.value = '';
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
  };
  if (editingId) {
    const idx = listings.findIndex((l) => l.id === editingId);
    if (idx !== -1) listings[idx] = { ...listings[idx], ...data };
  } else {
    listings.push({ id: genId(), status: 'pending', lastError: null, lastRunAt: null, ...data });
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
  currentPhotos = l.photos || [];
  renderPhotoPreview();
  els.cancelEditBtn.hidden = false;
}

async function deleteListing(id) {
  if (!confirm('确定删除这个商品吗?')) return;
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

async function renderList() {
  const listings = await getListings();
  els.list.innerHTML = '';
  if (!listings.length) {
    els.list.innerHTML = '<li class="empty">还没有商品,先在上面添加一个吧</li>';
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
      ${l.lastError ? `<div class="error">${escapeHtml(l.lastError)}</div>` : ''}
      <div class="actions">
        <button data-action="edit">编辑</button>
        <button data-action="retry">重设为待发布</button>
        <button data-action="delete" class="danger">删除</button>
      </div>
    `;
    li.querySelector('[data-action="edit"]').addEventListener('click', () => editListing(l.id));
    li.querySelector('[data-action="retry"]').addEventListener('click', () => resetStatus(l.id));
    li.querySelector('[data-action="delete"]').addEventListener('click', () => deleteListing(l.id));
    els.list.appendChild(li);
  });
}

async function loadSettings() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  els.sMin.value = settings.minDelaySeconds ?? 60;
  els.sMax.value = settings.maxDelaySeconds ?? 150;
  els.sAutoPublish.checked = !!settings.autoPublish;
}

els.saveSettingsBtn.addEventListener('click', async () => {
  const settings = {
    minDelaySeconds: Number(els.sMin.value) || 60,
    maxDelaySeconds: Number(els.sMax.value) || 150,
    autoPublish: els.sAutoPublish.checked,
  };
  await chrome.storage.local.set({ settings });
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
});

(async function init() {
  await renderList();
  await loadSettings();
  await renderLog();
})();
