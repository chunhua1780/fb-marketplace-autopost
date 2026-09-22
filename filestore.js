// filestore.js - 可选的本地文件夹镜像。用户在面板里选一次保存文件夹并授权读写
// 之后,商品的信息(标题/价格/类别/成色/描述/地点)和图片会在后台自动同步写一份
// 到那个文件夹里,可以直接在电脑的文件管理器里打开看,每个商品一个子文件夹。
//
// 这是锦上添花的镜像,不是数据的唯一来源——真正驱动「点选/重新上架」这些核心
// 功能的数据始终存在 chrome.storage.local 里,文件夹写不写得进去(比如还没设置、
// 或者权限过期了)都不影响插件本身正常工作,只是少了一份本地可见的备份。
//
// FileSystemDirectoryHandle 可以通过结构化克隆存进 IndexedDB,之后不管是在面板
// 页面还是在 background 的 service worker 里都能重新取出来使用——这是 Chrome
// 扩展支持的标准做法。选文件夹、申请权限这一步必须在面板页面里由用户亲手点一次
// (浏览器安全限制,任何脚本都没法绕过、没法静默完成);权限一旦给了「允许」,
// 之后 service worker 里就能直接读写,不需要每次都再弹一次确认框。

const FBMA_DB_NAME = 'fbma-files';
const FBMA_STORE_NAME = 'handles';
const FBMA_DIR_KEY = 'saveDir';

function fbmaOpenDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(FBMA_DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(FBMA_STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getSavedDirHandle() {
  const db = await fbmaOpenDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FBMA_STORE_NAME, 'readonly');
    const req = tx.objectStore(FBMA_STORE_NAME).get(FBMA_DIR_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function setSavedDirHandle(handle) {
  const db = await fbmaOpenDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FBMA_STORE_NAME, 'readwrite');
    tx.objectStore(FBMA_STORE_NAME).put(handle, FBMA_DIR_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function clearSavedDirHandle() {
  const db = await fbmaOpenDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FBMA_STORE_NAME, 'readwrite');
    tx.objectStore(FBMA_STORE_NAME).delete(FBMA_DIR_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// 只读检查权限现在是不是「已授权」——不会弹任何东西,service worker 里也能用,
// 用来判断要不要真的去写文件。
async function hasWritableFolderAccess() {
  try {
    const handle = await getSavedDirHandle();
    if (!handle) return false;
    const perm = await handle.queryPermission({ mode: 'readwrite' });
    return perm === 'granted';
  } catch (err) {
    return false;
  }
}

// 只能从面板页面里调用(需要真实的用户点击)——弹出系统的文件夹选择框,选完
// 立刻申请读写权限并存起来。这一步必须由用户亲手点一次,没有办法从后台脚本
// 悄悄完成,这是浏览器本身的安全限制,不是插件的选择。
async function pickSaveFolder() {
  const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  const perm = await handle.requestPermission({ mode: 'readwrite' });
  if (perm !== 'granted') {
    throw new Error('没有获得读写权限');
  }
  await setSavedDirHandle(handle);
  return handle;
}

function fbmaSanitizeName(name) {
  return (
    String(name || 'item')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || 'item'
  );
}

function fbmaExtFromDataUrl(dataUrl) {
  const m = /^data:image\/(\w+)/.exec(dataUrl || '');
  const type = (m && m[1]) || 'jpg';
  return type === 'jpeg' ? 'jpg' : type;
}

async function fbmaDataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}

// 把一条商品的信息 + 图片写进「商品标题 - 短编号」这个子文件夹里:info.txt 存
// 标题/价格/类别/成色/描述/地点/Facebook 编号等,photo-1.jpg 开始存图片。全程
// best-effort——没设置文件夹、或者权限还没生效(比如换了台电脑、浏览器重装),
// 直接跳过不报错,不影响插件本身该干嘛干嘛,这只是锦上添花的本地镜像。
async function writeListingToFolder(listing) {
  try {
    const handle = await getSavedDirHandle();
    if (!handle) return { ok: false, skipped: true };
    const perm = await handle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') return { ok: false, skipped: true };

    const idSuffix = String(listing.id || '').slice(-8) || 'x';
    const folderName = `${fbmaSanitizeName(listing.title)} - ${idSuffix}`;
    const itemDir = await handle.getDirectoryHandle(folderName, { create: true });

    const info = [
      `Title / 标题: ${listing.title || ''}`,
      `Price / 价格: ${listing.price || ''}`,
      `Category / 类别: ${listing.category || ''}`,
      `Condition / 成色: ${listing.condition || ''}`,
      `Location / 地点: ${listing.location || ''}`,
      `Facebook item id / 商品编号: ${listing.sourceItemId || ''}`,
      `Facebook URL: ${listing.sourceUrl || ''}`,
      `Status / 状态: ${listing.status || ''}`,
      `Updated / 更新时间: ${new Date().toLocaleString()}`,
      '',
      'Description / 描述:',
      listing.description || '',
    ].join('\n');
    const infoFile = await itemDir.getFileHandle('info.txt', { create: true });
    const infoWritable = await infoFile.createWritable();
    await infoWritable.write(info);
    await infoWritable.close();

    const photos = listing.photos || [];
    for (let i = 0; i < photos.length; i++) {
      const dataUrl = photos[i] && photos[i].dataUrl;
      if (!dataUrl) continue;
      const ext = fbmaExtFromDataUrl(dataUrl);
      const blob = await fbmaDataUrlToBlob(dataUrl);
      const photoFile = await itemDir.getFileHandle(`photo-${i + 1}.${ext}`, { create: true });
      const photoWritable = await photoFile.createWritable();
      await photoWritable.write(blob);
      await photoWritable.close();
    }

    return { ok: true, folderName };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}
