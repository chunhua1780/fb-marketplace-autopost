// background.js - 队列调度 + AI 回复代理(service worker)
// 说明:MV3 的 service worker 在空闲约 30 秒后会被 Chrome 回收,普通的
// `await sleep(...)` 在等待发布间隔的几十/上百秒里大概率会被中断。
// 所以两次发布之间的等待、以及自动续期检查,都用 chrome.alarms 实现——
// 闹钟到点会重新唤醒 worker,而不是让 worker 自己挂着计时。

importScripts('storage.js');

const ALARM_QUEUE_TICK = 'fb-marketplace-queue-tick';
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
  chrome.alarms.create(ALARM_QUEUE_TICK, { delayInMinutes: waitSeconds / 60 });
}

async function processListing(listing) {
  await setListingFields(listing.id, { status: 'running' });
  let tab;
  try {
    tab = await chrome.tabs.create({ url: 'https://www.facebook.com/marketplace/create/item', active: false });
    await waitForContentReady(tab.id);

    const settings = await getSettings();
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'FILL_LISTING', listing, settings });
    if (!result || !result.ok) {
      throw new Error((result && result.error) || '内容脚本没有返回结果');
    }

    const published = !!result.published;
    const fields = {
      status: published ? 'posted' : 'filled_awaiting_review',
      lastError: null,
      lastRunAt: Date.now(),
    };
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
  } catch (err) {
    await setListingFields(listing.id, { status: 'failed', lastError: String((err && err.message) || err), lastRunAt: Date.now() });
    await appendLog({ level: 'error', text: `「${listing.title}」处理失败: ${(err && err.message) || err}` });
  }
}

async function setListingFields(id, fields) {
  const listings = await getListings();
  const idx = listings.findIndex((l) => l.id === id);
  if (idx === -1) return;
  listings[idx] = { ...listings[idx], ...fields };
  await saveListings(listings);
}

// 定期检查哪些「到期自动重新上架」的商品该重新排队了
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
