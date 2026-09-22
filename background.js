// background.js - 发布队列调度 + 到期自动重新上架 + AI 回复代理(service worker)
// 说明:MV3 的 service worker 在空闲约 30 秒后会被 Chrome 回收,普通的
// `await sleep(...)` 在等待发布间隔的几十/上百秒里大概率会被中断,所以两次发布
// 之间的等待、以及自动续期检查,都用 chrome.alarms 实现——闹钟到点会重新唤醒
// worker,而不是让 worker 自己挂着计时。
//
// 「点选式导入」现有商品:content-my-listings.js 在商品管理页上点一下只读弹窗里
// 能立刻看到的标题/价格/编号,读完整表单(类别/成色/描述/图片)这一步比较慢,
// 挪到这里用后台标签页处理——打开该商品的独立页面,让 content-item.js 用真实的
// 页面导航读一遍完整详情,不依赖任何程序模拟点击(之前用合成点击在后台重新触发
// 弹窗,发现不可靠,Facebook 的 React 逻辑不一定认 isTrusted=false 的事件)。

importScripts('storage.js');

const ALARM_QUEUE_TICK = 'fb-marketplace-queue-tick';
const ALARM_REPOST_CHECK = 'fb-marketplace-repost-check';
const ALARM_DETAIL_READ_TICK = 'fb-marketplace-detail-read-tick';
const pendingReadyResolvers = new Map();
let detailReadTickRunning = false;

// 点插件图标打开的是侧边栏而不是会自动关闭的小弹窗——侧边栏会一直贴在浏览器
// 右侧,点 Facebook 页面本身不会把它关掉,方便一边点商品一边看进度。
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(async () => {
  await getFaqs(); // 首次安装时写入默认 FAQ
  chrome.alarms.create(ALARM_REPOST_CHECK, { periodInMinutes: 60 });
  detailReadTick(); // 万一有上次没处理完、还留在队列里的商品,接着处理
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM_REPOST_CHECK, { periodInMinutes: 60 });
  detailReadTick();
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
  if (alarm.name === ALARM_DETAIL_READ_TICK) detailReadTick();
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

    case 'QUEUE_DETAIL_READ':
      return queueDetailRead(message.itemId || null, message.quickInfo || {});

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

// 到期重新上架的时间点故意加一点随机浮动(±15%),不要每次都精确卡在「第 N 天
// 的同一分钟」——一个商品每隔一模一样的时长准时被删除重发,时间点越规律,
// 越像是脚本在自动操作,加上随机浮动更接近真人「过几天想起来了才弄一下」的
// 节奏。
function computeNextRepostAt(days) {
  const base = Math.max(1, Number(days) || 7) * 24 * 60 * 60 * 1000;
  const jitterRatio = 0.85 + Math.random() * 0.3; // 0.85x ~ 1.15x
  return Date.now() + Math.round(base * jitterRatio);
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
    // 开在后台(active: false)——用户明确要求不要一直弹出新页面打断当前正在
    // 看的东西。想看某一次到底填成什么样,去「发布队列」里看日志(会记录每一步
    // 和最后结果),不需要真的守着这个标签页看。
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
      fields.nextRepostAt = computeNextRepostAt(days);
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

// ---------- 点选式导入:后台读完整详情 ----------

// 商品管理页那边只读到了弹窗里能立刻看到的标题/价格,读完整表单(类别/成色/
// 描述/图片)这一步交给这里排队处理,避免用户连续点好几个商品时互相卡住。
async function queueDetailRead(itemId, quickInfo) {
  if (!itemId) {
    // 没读到 Facebook 的真实商品编号,没法再打开一个独立页面去读完整详情,
    // 先把秒选时看到的标题/价格存下来,不要什么都不存、白白浪费这次点选。
    await saveBasicListing(null, quickInfo);
    return { ok: true };
  }

  // 先立刻存一条「标题/价格已知,详情读取中」的占位记录——这样用户在面板里
  // 点了第 1、2、3 个商品,马上就能看到每一条对应的是什么商品(比如「笔记本
  // 电脑」「充电器」),不用等后台标签页把完整详情读完才第一次出现在列表里。
  const listings = await getListings();
  if (!listings.some((l) => l.sourceItemId === itemId)) {
    listings.push(
      genListing({
        title: quickInfo.title || '',
        price: quickInfo.priceText || '',
        sourceItemId: itemId,
        sourceUrl: `https://www.facebook.com/marketplace/item/${itemId}/`,
        status: 'reading_details',
        importedAt: Date.now(),
      })
    );
    await saveListings(listings);
  }

  const { detailReadQueue } = await chrome.storage.local.get('detailReadQueue');
  const queue = detailReadQueue || [];
  if (!queue.some((q) => q.itemId === itemId)) {
    queue.push({ itemId, quickInfo, queuedAt: Date.now() });
    await chrome.storage.local.set({ detailReadQueue: queue });
    await appendLog({ level: 'info', text: `已选中「${quickInfo.title || itemId}」,后台正在读取完整信息...` });
  }
  detailReadTick();
  return { ok: true };
}

async function detailReadTick() {
  if (detailReadTickRunning) return;
  detailReadTickRunning = true;
  try {
    const { detailReadQueue } = await chrome.storage.local.get('detailReadQueue');
    const queue = detailReadQueue || [];
    if (!queue.length) return;

    const next = queue[0];
    await processDetailRead(next);

    const { detailReadQueue: queueAfter } = await chrome.storage.local.get('detailReadQueue');
    const remaining = (queueAfter || []).filter((q) => q.itemId !== next.itemId);
    await chrome.storage.local.set({ detailReadQueue: remaining });

    if (remaining.length) {
      const waitSeconds = Math.max(30, randomInt(8, 20));
      chrome.alarms.create(ALARM_DETAIL_READ_TICK, { delayInMinutes: waitSeconds / 60 });
    }
  } finally {
    detailReadTickRunning = false;
  }
}

async function processDetailRead(item) {
  const { itemId, quickInfo } = item;
  let tab;
  try {
    tab = await chrome.tabs.create({ url: `https://www.facebook.com/marketplace/item/${itemId}/`, active: false });
    await waitForContentReady(tab.id, 20000);
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'SCRAPE_ITEM' });
    if (!res || !res.ok) throw new Error((res && res.error) || '读取详情失败');
    await saveScrapedListing(itemId, res.listing, quickInfo);
  } catch (err) {
    await appendLog({
      level: 'error',
      text: `读取「${quickInfo.title || itemId}」完整详情失败,已先用基本信息(标题/价格)保存,可以晚点重试: ${(err && err.message) || err}`,
    });
    await saveBasicListing(itemId, quickInfo);
  } finally {
    if (tab) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// 商品一旦导入完成(不管完整详情有没有读成功),就直接自动进入「到期自动重新
// 上架」的循环——这正是这个插件现在存在的核心目的,不需要用户再进每条商品自己
// 的设置里手动勾一次。要不要连 Facebook 上的旧版本一起自动删掉,跟着设置里的
// 全局总开关走(默认开启;不放心的话可以在「发布设置」里关掉这一个总开关,
// 关掉之后新导入的商品还是会自动重新上架,只是不会删旧版本,更保守一些)。
async function autoRepostFieldsFor(repostDays) {
  const settings = await getSettings();
  return {
    repostEnabled: true,
    repostIntervalDays: repostDays,
    deleteOldOnRepost: !!settings.autoDeleteOldListings,
    nextRepostAt: computeNextRepostAt(repostDays),
  };
}

// itemId 是 Facebook 那边的真实商品编号,只用在两个地方:导入去重、以及
// 「重新上架后自动删除旧版本」。读不到也完全不影响导入——标题/价格这些读到了
// 就先存下来,用插件自己的编号(genListing 里自动生成)管理。
//
// 队列里的商品在 queueDetailRead 那一步已经先存过一条「占位记录」(标题/价格
// 已知,状态是 reading_details),这里读完整详情之后不是再新插一条,而是把同一
// 条记录原地更新——不然面板列表里会看到同一个商品出现两次。
async function saveScrapedListing(itemId, scraped, quickInfo) {
  const listings = await getListings();
  const idx = itemId ? listings.findIndex((l) => l.sourceItemId === itemId) : -1;
  const title = scraped.title || quickInfo.title || (idx !== -1 ? listings[idx].title : '');
  const repostDays = (idx !== -1 && Number(listings[idx].repostIntervalDays) > 0) ? Number(listings[idx].repostIntervalDays) : 7;
  const fields = {
    title,
    price: scraped.price || quickInfo.priceText || (idx !== -1 ? listings[idx].price : ''),
    category: scraped.category || '',
    condition: scraped.condition || '',
    description: scraped.description || '',
    location: scraped.location || '',
    photos: scraped.photos || [],
    status: 'imported',
    ...(await autoRepostFieldsFor(repostDays)),
  };
  if (idx !== -1) {
    listings[idx] = { ...listings[idx], ...fields };
  } else {
    listings.push(
      genListing({
        ...fields,
        sourceItemId: itemId || null,
        sourceUrl: itemId ? `https://www.facebook.com/marketplace/item/${itemId}/` : null,
        importedAt: Date.now(),
      })
    );
  }
  await saveListings(listings);
  await appendLog({ level: 'success', text: `已读取完整信息:「${title || itemId}」` });
}

async function saveBasicListing(itemId, quickInfo) {
  const listings = await getListings();
  const idx = itemId ? listings.findIndex((l) => l.sourceItemId === itemId) : -1;
  if (idx !== -1) {
    // 占位记录已经在了(queueDetailRead 那一步存的),完整详情没读成功,
    // 把状态从「读取中」改回可用,标题/价格保留原样,不然会一直卡在「读取中」。
    const repostDays = Number(listings[idx].repostIntervalDays) > 0 ? Number(listings[idx].repostIntervalDays) : 7;
    listings[idx] = { ...listings[idx], status: 'imported', ...(await autoRepostFieldsFor(repostDays)) };
    await saveListings(listings);
    await appendLog({
      level: 'success',
      text: `「${listings[idx].title || itemId}」完整详情读取失败,已保留标题/价格,可以之后手动重试`,
    });
    return;
  }
  listings.push(
    genListing({
      title: quickInfo.title || '',
      price: quickInfo.priceText || '',
      sourceItemId: itemId || null,
      sourceUrl: itemId ? `https://www.facebook.com/marketplace/item/${itemId}/` : null,
      status: 'imported',
      importedAt: Date.now(),
      ...(await autoRepostFieldsFor(7)),
    })
  );
  await saveListings(listings);
  await appendLog({
    level: 'success',
    text: `已导入基本信息(标题/价格):「${quickInfo.title || itemId || '商品'}」`,
  });
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
