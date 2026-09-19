// background.js - 队列调度 + 导入现有商品 + AI 回复代理(service worker)
// 说明:MV3 的 service worker 在空闲约 30 秒后会被 Chrome 回收,普通的
// `await sleep(...)` 在等待发布间隔的几十/上百秒里大概率会被中断。
// 所以两次发布之间的等待、导入下一件商品的等待、以及自动续期检查,都用
// chrome.alarms 实现——闹钟到点会重新唤醒 worker,而不是让 worker 自己挂着计时。

importScripts('storage.js');

const ALARM_QUEUE_TICK = 'fb-marketplace-queue-tick';
const ALARM_IMPORT_TICK = 'fb-marketplace-import-tick';
const ALARM_REPOST_CHECK = 'fb-marketplace-repost-check';
const pendingReadyResolvers = new Map();

chrome.runtime.onInstalled.addListener(async () => {
  await getFaqs(); // 首次安装时写入默认 FAQ
  chrome.alarms.create(ALARM_REPOST_CHECK, { periodInMinutes: 60 });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM_REPOST_CHECK, { periodInMinutes: 60 });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true; // 保持消息通道打开,等待异步响应
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_QUEUE_TICK) tick();
  if (alarm.name === ALARM_IMPORT_TICK) importTick();
  if (alarm.name === ALARM_REPOST_CHECK) checkReposts();
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
      await chrome.alarms.clear(ALARM_QUEUE_TICK);
      chrome.action.setBadgeText({ text: '' });
      await appendLog({ level: 'info', text: '已停止队列(当前正在处理的商品不会中断)' });
      return { ok: true };

    case 'REPOST_NOW':
      return repostNow(message.id);

    case 'IMPORT_SELECTED':
      startImportSelected(message.items).catch((err) =>
        appendLog({ level: 'error', text: '导入失败: ' + ((err && err.message) || err) })
      );
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

    case 'GENERATE_AI_REPLY':
      return generateAiReply(message);

    default:
      return { ok: false, error: '未知消息类型: ' + message.type };
  }
}

function waitForContentReady(tabId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingReadyResolvers.delete(tabId);
      reject(new Error('等待页面加载超时,可能是网络较慢或页面结构变化'));
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

// ---------- 发布队列 ----------

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
  chrome.alarms.create(ALARM_QUEUE_TICK, { delayInMinutes: waitSeconds / 60 });
}

async function repostNow(id) {
  const listings = await getListings();
  const idx = listings.findIndex((l) => l.id === id);
  if (idx === -1) return { ok: false, error: '找不到该商品' };
  listings[idx].status = 'pending';
  listings[idx].lastError = null;
  await saveListings(listings);
  await appendLog({ level: 'info', text: `「${listings[idx].title}」已放入队列,准备重新上架` });
  await chrome.storage.local.set({ queueRunning: true });
  tick();
  return { ok: true };
}

async function processListing(listing) {
  await setListingFields(listing.id, { status: 'running' });
  const settings = await getSettings();
  const oldItemId = listing.sourceItemId || null;
  let tab;
  try {
    tab = await chrome.tabs.create({ url: 'https://www.facebook.com/marketplace/create/item', active: false });
    await waitForContentReady(tab.id);

    const result = await chrome.tabs.sendMessage(tab.id, { type: 'FILL_LISTING', listing, settings });
    if (!result || !result.ok) {
      throw new Error((result && result.error) || '内容脚本没有返回结果');
    }

    const published = !!result.published;
    const fields = { status: published ? 'posted' : 'filled_awaiting_review', lastError: null, lastRunAt: Date.now() };
    if (published && result.newItemId) {
      fields.sourceItemId = result.newItemId;
      fields.sourceUrl = result.newItemUrl || null;
    }
    if (published && listing.repostEnabled) {
      const days = Number(listing.repostIntervalDays) > 0 ? Number(listing.repostIntervalDays) : 7;
      fields.nextRepostAt = Date.now() + days * 24 * 60 * 60 * 1000;
    }
    await setListingFields(listing.id, fields);
    await appendLog({
      level: 'success',
      text: `「${listing.title}」${published ? '已自动发布' : '已自动填好表单,请在浏览器里确认后手动点击发布'}`,
    });

    if (published) {
      setTimeout(() => chrome.tabs.remove(tab.id).catch(() => {}), 3000);
    }

    // 只有「新的确认发布成功」+ 单条商品开了 deleteOldOnRepost + 全局总开关也开着,
    // 才会去删除 Facebook 上的旧版本;顺序上永远是先确认新的发出去了才删旧的。
    if (
      published &&
      listing.deleteOldOnRepost &&
      settings.autoDeleteOldListings &&
      oldItemId &&
      oldItemId !== result.newItemId
    ) {
      await deleteOldListing(oldItemId, listing.title);
    }
  } catch (err) {
    await setListingFields(listing.id, { status: 'failed', lastError: String((err && err.message) || err), lastRunAt: Date.now() });
    await appendLog({ level: 'error', text: `「${listing.title}」处理失败: ${(err && err.message) || err}` });
  }
}

async function deleteOldListing(itemId, titleForLog) {
  let tab;
  try {
    tab = await chrome.tabs.create({ url: `https://www.facebook.com/marketplace/item/${itemId}/`, active: false });
    await waitForContentReady(tab.id, 20000);
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'DELETE_ITEM' });
    if (!res || !res.ok) throw new Error((res && res.error) || '删除失败');
    await appendLog({ level: 'success', text: `已自动删除「${titleForLog}」在 Facebook 上的旧版本` });
  } catch (err) {
    await appendLog({
      level: 'error',
      text: `自动删除「${titleForLog}」的旧版本失败,请自行去 Facebook 检查并手动删除: ${(err && err.message) || err}`,
    });
  } finally {
    if (tab) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function setListingFields(id, fields) {
  const listings = await getListings();
  const idx = listings.findIndex((l) => l.id === id);
  if (idx === -1) return;
  listings[idx] = { ...listings[idx], ...fields };
  await saveListings(listings);
}

// ---------- 到期自动重新上架 ----------

async function checkReposts() {
  const listings = await getListings();
  const now = Date.now();
  let changed = false;
  for (const l of listings) {
    if (l.status === 'posted' && l.repostEnabled && l.nextRepostAt && now >= l.nextRepostAt) {
      l.status = 'pending';
      l.nextRepostAt = null;
      l.lastError = null;
      changed = true;
      appendLog({ level: 'info', text: `「${l.title}」已到重新上架时间,已放回发布队列` });
    }
  }
  if (changed) {
    await saveListings(listings);
    const { queueRunning } = await chrome.storage.local.get('queueRunning');
    if (!queueRunning) {
      await chrome.storage.local.set({ queueRunning: true });
      tick();
    }
  }
}

// ---------- 导入 Facebook 上已有的商品 ----------
// 扫描这一步现在由 popup.js 直接对着用户当前打开的那个 Facebook 标签页做
// (content-my-listings.js 已经注入在那个页面里),不再由背景脚本去猜网址、
// 另外开一个标签页——这样才不会出现「找不到/乱跳」的问题。
// 这里只负责「把选中的商品逐个打开编辑页读取详情」这一步,并汇报进度。

async function startImportSelected(items) {
  if (!items || !items.length) return;
  const listings = await getListings();
  const known = new Set(listings.map((l) => l.sourceItemId).filter(Boolean));
  const queue = items.filter((it) => !known.has(it.itemId));

  if (!queue.length) {
    await appendLog({ level: 'info', text: '选中的商品都已经导入过了,没有新的要导入' });
    return;
  }

  await chrome.storage.local.set({ importQueue: queue, importProgress: { done: 0, total: queue.length } });
  await appendLog({ level: 'info', text: `开始导入 ${queue.length} 件商品的详情(会依次打开每件商品的编辑页读取)...` });
  importTick();
}

async function importTick() {
  const { importQueue = [] } = await chrome.storage.local.get('importQueue');
  const { importProgress = { done: 0, total: 0 } } = await chrome.storage.local.get('importProgress');

  if (!importQueue.length) {
    if (importProgress.total) {
      await appendLog({ level: 'info', text: `导入完成,共导入 ${importProgress.done} 件商品` });
    }
    await chrome.storage.local.set({ importProgress: { done: 0, total: 0 } });
    return;
  }

  const [next, ...rest] = importQueue;
  await chrome.storage.local.set({ importQueue: rest });

  let tab;
  try {
    tab = await chrome.tabs.create({ url: `https://www.facebook.com/marketplace/item/${next.itemId}/edit`, active: false });
    await waitForContentReady(tab.id, 20000);
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'SCRAPE_ITEM' });
    if (!res || !res.ok) throw new Error((res && res.error) || '读取商品详情失败');

    const listings = await getListings();
    if (!listings.some((l) => l.sourceItemId === next.itemId)) {
      listings.push(
        genListing({
          ...res.listing,
          sourceItemId: next.itemId,
          sourceUrl: next.sourceUrl,
          status: 'imported',
          importedAt: Date.now(),
        })
      );
      await saveListings(listings);
    }
    await appendLog({ level: 'success', text: `已导入:「${res.listing.title || next.title}」` });
  } catch (err) {
    await appendLog({ level: 'error', text: `导入「${next.title}」失败: ${(err && err.message) || err}` });
  } finally {
    if (tab) chrome.tabs.remove(tab.id).catch(() => {});
  }

  await chrome.storage.local.set({
    importProgress: { done: importProgress.total - rest.length, total: importProgress.total },
  });

  chrome.alarms.create(ALARM_IMPORT_TICK, { delayInMinutes: (5 + Math.random() * 5) / 60 });
}

// ---------- AI 智能回复 ----------

function buildAiSystemPrompt(listing, sellerInfo) {
  const lines = [
    '你是卖家在 Facebook Marketplace 上的客服助理,用简洁、友好、真诚的语气直接回答买家的问题。',
    '只使用下面提供的真实商品信息作答,绝不编造库存紧张、限时优惠、还有别人在抢购等不存在的信息。',
    '回答要简短(1-3 句话)、自然口语化,并在合适的时候提醒买家取货地点和购买/付款方式,鼓励对方尽快联系约时间看货或交易。',
    '用买家提问所用的语言回复(中文提问用中文回,英文提问用英文回)。',
  ];
  if (listing) {
    lines.push(`商品标题:${listing.title || ''}`);
    if (listing.price) lines.push(`价格:${listing.price}`);
    if (listing.condition) lines.push(`成色:${listing.condition}`);
    if (listing.description) lines.push(`商品描述:${listing.description}`);
  } else {
    lines.push('目前无法确定这条对话具体对应哪个商品,请用比较通用但礼貌的方式回复,不要瞎编商品细节。');
  }
  if (sellerInfo && sellerInfo.address) lines.push(`取货地点:${sellerInfo.address}`);
  if (sellerInfo && sellerInfo.purchase) lines.push(`购买/付款方式:${sellerInfo.purchase}`);
  return lines.join('\n');
}

async function generateAiReply(message) {
  try {
    const settings = await getSettings();
    if (!settings.aiApiKey) return { ok: false, error: '未设置 AI API Key' };

    const { buyerMessage, listing, sellerInfo } = message;
    const systemPrompt = buildAiSystemPrompt(listing, sellerInfo);

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': settings.aiApiKey,
        'anthropic-version': '2023-06-01',
        // 允许直接从浏览器端(这里是插件的后台脚本)调用 Anthropic API
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: settings.aiModel || 'claude-haiku-4-5',
        max_tokens: 400,
        system: systemPrompt,
        messages: [{ role: 'user', content: String(buyerMessage || '').slice(0, 2000) }],
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      return { ok: false, error: `AI 接口返回错误 ${resp.status}: ${errText.slice(0, 200)}` };
    }

    const data = await resp.json();
    const text = (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}
