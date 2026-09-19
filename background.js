// background.js - 队列调度(service worker)
// 说明:MV3 的 service worker 在空闲约 30 秒后会被 Chrome 回收,普通的
// `await sleep(...)` 在等待发布间隔的几十/上百秒里大概率会被中断。
// 所以两次发布之间的等待用 chrome.alarms 来实现——闹钟到点会重新唤醒
// worker 并继续处理下一条,而不是让 worker 自己挂着计时。

importScripts('storage.js');

const ALARM_NAME = 'fb-marketplace-queue-tick';
const pendingReadyResolvers = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true; // 保持消息通道打开,等待异步响应
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) tick();
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'START_QUEUE':
      await chrome.storage.local.set({ queueRunning: true });
      await appendLog({ level: 'info', text: '开始处理发布队列' });
      tick();
      return { ok: true };

    case 'STOP_QUEUE':
      await chrome.storage.local.set({ queueRunning: false });
      await chrome.alarms.clear(ALARM_NAME);
      chrome.action.setBadgeText({ text: '' });
      await appendLog({ level: 'info', text: '已停止队列(当前正在处理的商品不会中断)' });
      return { ok: true };

    case 'CONTENT_READY': {
      const tabId = sender.tab && sender.tab.id;
      const resolver = tabId != null && pendingReadyResolvers.get(tabId);
      if (resolver) {
        resolver();
        pendingReadyResolvers.delete(tabId);
      }
      return { ok: true };
    }

    default:
      return { ok: false, error: '未知消息类型: ' + message.type };
  }
}

function waitForContentReady(tabId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingReadyResolvers.delete(tabId);
      reject(new Error('等待商品发布页面加载超时,可能是网络较慢或页面结构变化'));
    }, timeoutMs);
    pendingReadyResolvers.set(tabId, () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function randomInt(a, b) {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

async function tick() {
  const { queueRunning } = await chrome.storage.local.get('queueRunning');
  if (!queueRunning) return;

  const listings = await getListings();
  const next = listings.find((l) => l.status === 'pending');
  if (!next) {
    await chrome.storage.local.set({ queueRunning: false });
    chrome.action.setBadgeText({ text: '' });
    await appendLog({ level: 'info', text: '队列已清空,没有待发布的商品了' });
    return;
  }

  chrome.action.setBadgeText({ text: '...' });
  await processListing(next);
  chrome.action.setBadgeText({ text: '' });

  const { queueRunning: stillRunning } = await chrome.storage.local.get('queueRunning');
  if (!stillRunning) return;

  const settings = await getSettings();
  const waitSeconds = Math.max(30, randomInt(settings.minDelaySeconds, settings.maxDelaySeconds));
  await appendLog({ level: 'info', text: `等待约 ${waitSeconds} 秒后处理下一个商品(避免发布过于频繁)` });
  chrome.alarms.create(ALARM_NAME, { delayInMinutes: waitSeconds / 60 });
}

async function processListing(listing) {
  await setListingStatus(listing.id, 'running');
  let tab;
  try {
    tab = await chrome.tabs.create({ url: 'https://www.facebook.com/marketplace/create/item', active: false });
    await waitForContentReady(tab.id);

    const settings = await getSettings();
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'FILL_LISTING', listing, settings });
    if (!result || !result.ok) {
      throw new Error((result && result.error) || '内容脚本没有返回结果');
    }

    await setListingStatus(listing.id, result.published ? 'posted' : 'filled_awaiting_review', null, Date.now());
    await appendLog({
      level: 'success',
      text: `「${listing.title}」${result.published ? '已自动发布' : '已自动填好表单,请在浏览器里确认后手动点击发布'}`,
    });

    if (result.published) {
      setTimeout(() => chrome.tabs.remove(tab.id).catch(() => {}), 3000);
    }
  } catch (err) {
    await setListingStatus(listing.id, 'failed', String((err && err.message) || err), Date.now());
    await appendLog({ level: 'error', text: `「${listing.title}」处理失败: ${(err && err.message) || err}` });
  }
}

async function setListingStatus(id, status, lastError = null, lastRunAt = null) {
  const listings = await getListings();
  const idx = listings.findIndex((l) => l.id === id);
  if (idx === -1) return;
  listings[idx] = {
    ...listings[idx],
    status,
    lastError,
    lastRunAt: lastRunAt ?? listings[idx].lastRunAt,
  };
  await saveListings(listings);
}
