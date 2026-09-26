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

importScripts('storage.js', 'filestore.js');

const ALARM_QUEUE_TICK = 'fb-marketplace-queue-tick';
const ALARM_REPOST_CHECK = 'fb-marketplace-repost-check';
const ALARM_DETAIL_READ_TICK = 'fb-marketplace-detail-read-tick';
const pendingReadyResolvers = new Map();
let detailReadTickRunning = false;

// 点插件图标打开的是侧边栏而不是会自动关闭的小弹窗——侧边栏会一直贴在浏览器
// 右侧,点 Facebook 页面本身不会把它关掉,方便一边点商品一边看进度。
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// 早期版本 autoPublish 默认是关的,只要用户点过一次「保存发布设置」,这个 false
// 就会跟着当时的其他设置一起被写进 chrome.storage,之后哪怕代码里的默认值改成
// true 也没用——getSettings() 是拿存下来的值去覆盖默认值,不是反过来。这里做
// 一次性迁移,只跑一次,直接把这两个开关强制打开,不需要用户自己再去设置里点
// 一次「保存」。
async function migrateToFullAutoOnce() {
  const { migratedFullAutoV1 } = await chrome.storage.local.get('migratedFullAutoV1');
  if (migratedFullAutoV1) return;
  const settings = await getSettings();
  await saveSettings({ ...settings, autoPublish: true, autoDeleteOldListings: true });
  await chrome.storage.local.set({ migratedFullAutoV1: true });
  await appendLog({
    level: 'info',
    text: '已自动打开「自动点击发布」和「自动删除旧版本」这两个设置(全自动重新上架需要这两个都打开;可以在「发布设置」里再关掉)。',
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  await getFaqs(); // 首次安装时写入默认 FAQ
  chrome.alarms.create(ALARM_REPOST_CHECK, { periodInMinutes: 60 });
  detailReadTick(); // 万一有上次没处理完、还留在队列里的商品,接着处理
  await migrateToFullAutoOnce();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM_REPOST_CHECK, { periodInMinutes: 60 });
  detailReadTick();
  migrateToFullAutoOnce();
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

    case 'REPOST_ALL':
      return repostAll();

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

    case 'RECONCILE_LISTINGS':
      return reconcileListings(message.rows || []);

    default:
      return { ok: false, error: '未知消息类型: ' + message.type };
  }
}

function waitForContentReady(tabId, timeoutMs = 30000) {
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

// 一键把所有还没在排队/没在处理中的商品都丢进发布队列——队列本身已经有随机
// 间隔(每个商品之间等 60-150 秒),不会一次性全部挤在一起发,不需要用户一个
// 一个点「立即重新上架」。
async function repostAll() {
  const listings = await getListings();
  let count = 0;
  for (const l of listings) {
    if (l.status === 'pending' || l.status === 'running') continue;
    l.status = 'pending';
    l.lastError = null;
    count += 1;
  }
  if (!count) return { ok: true, count: 0 };
  await saveListings(listings);
  await appendLog({ level: 'info', text: `已把 ${count} 个商品放入队列,准备依次重新上架` });
  await chrome.storage.local.set({ queueRunning: true });
  tick();
  return { ok: true, count };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 类别/成色/图片这几项如果是老早之前(比如插件某个旧版本、或者那次读取本身就
// 失败)存下来的空值,单靠重新上架时手上这份旧数据肯定还是缺——不能指望用户
// 每次都先手动把这条商品删掉、重新点选导入一次才能用上最新的读取逻辑。这里在
// 真正开始填表发布之前,先检查一下这几项是不是不全,不全的话就用商品自己的
// Facebook 编号悄悄重新读一遍最新详情再继续,商品数据自己会在每次重新上架前
// 自动"体检"补全,不需要用户操心是不是"新导入的"。
// 返回 { listing, blockedReason }——blockedReason 不是 null 就说明已经确定
// 这次没法往下走,让 processListing 直接在这里就把清楚的原因写到这条商品自己
// 的失败提示上,不用再白跑一趟"打开发布页、填表、发现按钮点不动"才失败,面板
// 里看到的也是真正卡住的原因,不是"找不到发布按钮"这种隔了一层的下游症状。
async function refreshListingIfIncomplete(listing) {
  // 类别现在不用非得先知道具体是什么——重新上架填表的时候会尽力选一个类别
  // 出来(选得准不准不重要,只要 Facebook 不会因为类别空着而不让发布就行),
  // 所以这里不再因为类别读不到就判定「不全」,只看成色和图片。
  const incomplete = !listing.condition || !(listing.photos && listing.photos.length);
  if (!incomplete) return { listing, blockedReason: null };

  if (!listing.sourceItemId) {
    // 没有 Facebook 真实商品编号,压根不知道去哪个网址重新读——这种商品当初
    // 导入的时候大概率没弹出详情框、也没能从那一行本身拿到链接,只存下了标题/
    // 价格。没法自动补全,得用户自己把这条删掉、直接去 Facebook 页面上重新点
    // 一次这个商品(不是点"Re-post now"重试),才能重新抓到真实编号。
    const reason =
      '缺类别/成色/图片,这条记录没有关联到 Facebook 真实商品编号,没法自动重新读取——请把这条删掉,回到 Facebook 页面重新点一次这个商品(不是点"Re-post now"重试),让它重新抓一次真实编号和完整信息。';
    return { listing, blockedReason: reason };
  }

  let tab;
  try {
    tab = await chrome.tabs.create({ url: `https://www.facebook.com/marketplace/item/${listing.sourceItemId}/`, active: false });
    await waitForContentReady(tab.id, 30000);
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'SCRAPE_ITEM' });
    if (!res || !res.ok) {
      return {
        listing,
        blockedReason: `重新上架前重新读取详情失败,没能补全类别/成色/图片: ${(res && res.error) || '读取失败'}`,
      };
    }
    const scraped = res.listing;
    const updates = {
      category: scraped.category || listing.category,
      condition: scraped.condition || listing.condition,
      description: scraped.description || listing.description,
      photos: scraped.photos && scraped.photos.length ? scraped.photos : listing.photos,
      categoryConditionDiag: scraped.categoryConditionDiag || null,
    };
    await setListingFields(listing.id, updates);
    const refreshed = { ...listing, ...updates };
    const stillIncomplete = !refreshed.condition || !(refreshed.photos && refreshed.photos.length);
    if (stillIncomplete) {
      const missing = [!refreshed.condition && '成色', !(refreshed.photos && refreshed.photos.length) && '图片']
        .filter(Boolean)
        .join('、');
      const diagTrail = refreshed.categoryConditionDiag
        ? ` 页面上找到的候选按钮文字:${JSON.stringify(refreshed.categoryConditionDiag)}`
        : '';
      return {
        listing: refreshed,
        blockedReason: `重新读取了 Facebook 上的原始商品页面,但还是没能读到「${missing}」,Facebook 要求这些字段填好才会解锁发布按钮,需要手动检查一下这个商品在 Facebook 上的这几项。${diagTrail}`,
      };
    }
    await appendLog({ level: 'info', text: `重新上架前已刷新「${listing.title}」的详情` });
    return { listing: refreshed, blockedReason: null };
  } catch (err) {
    return {
      listing,
      blockedReason: `重新上架前刷新详情出错,没能补全类别/成色/图片: ${(err && err.message) || err}`,
    };
  } finally {
    // 之前这里没有 await,标签页可能还没真的关掉,处理下一步(打开发布页那个
    // 新标签页)就已经开始了——两个标签页短暂同时加载 Facebook,可能会让第二个
    // 标签页的加载被拖慢,导致它自己的等待页面加载超时。改成等真的关掉了再往
    // 下走,不会自己跟自己抢资源。
    if (tab) await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function processListing(listing) {
  await setListingFields(listing.id, { status: 'running' });
  const refreshResult = await refreshListingIfIncomplete(listing);
  listing = refreshResult.listing;
  if (refreshResult.blockedReason) {
    await setListingFields(listing.id, { status: 'failed', lastError: refreshResult.blockedReason, lastRunAt: Date.now() });
    await appendLog({ level: 'error', text: `「${listing.title}」处理失败: ${refreshResult.blockedReason}` });
    return;
  }
  const settings = await getSettings();
  const oldItemId = listing.sourceItemId || null;
  let tab;
  // 「只填表不发布」是用户自己在设置里关掉自动发布才会走到的路径,这种情况下
  // 故意不自动关标签页——留给用户自己找到这个页面手动确认发布。发布成功、或者
  // 中途出错这两种情况都会在下面的 finally 里自动关掉标签页,不会一直堆着
  // (以前失败的情况没有清理标签页,连续失败几次标签页就会越堆越多)。
  let keepTabOpen = false;
  try {
    // 开在后台(active: false)——用户明确要求不要一直弹出新页面打断当前正在
    // 看的东西。想看某一次到底填成什么样,去「发布队列」里看日志(会记录每一步
    // 和最后结果),不需要真的守着这个标签页看。
    tab = await chrome.tabs.create({ url: 'https://www.facebook.com/marketplace/create/item', active: false });
    await waitForContentReady(tab.id);

    const result = await chrome.tabs.sendMessage(tab.id, { type: 'FILL_LISTING', listing, settings });
    if (!result || !result.ok) {
      // steps 里记的是「走到哪一步了」的完整轨迹,包括类别/成色这种选不中会被
      // 跳过、但不会让整个流程失败的非致命提示——之前这里只把最后那一条错误
      // 原因往外抛,中间「其实类别没选上」这种关键线索就丢了,日志里看不出来。
      const stepsTrail = result && result.steps && result.steps.length ? ` | 步骤记录:${JSON.stringify(result.steps)}` : '';
      throw new Error(((result && result.error) || '内容脚本没有返回结果') + stepsTrail);
    }

    const published = !!result.published;
    keepTabOpen = !published;
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
      await wait(1500); // 给 Facebook 一点时间把发布这个请求处理完,再关标签页
      await writeListingToFolder({ ...listing, ...fields }).catch(() => {});
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
    // 类别/成色读不到这份诊断是导入(或者重新上架前的自动刷新)那一刻存到商品
    // 身上的——用户平时截图给我们看的都是这条「处理失败」日志的开头那一段,
    // 后面那一大串 collectDiagnostics() 的原始 JSON 太长,日志框里要横向/纵向
    // 滚动很久才能看到。把类别诊断挪到最前面、原始 JSON 挪到最后,这样只要
    // 截到日志开头就一定看得到最关键的那部分,不用非得截全。
    const categoryDiagTrail = listing.categoryConditionDiag
      ? `类别/成色候选:${JSON.stringify(listing.categoryConditionDiag)} | `
      : '';
    const fullError = categoryDiagTrail + String((err && err.message) || err);
    await setListingFields(listing.id, { status: 'failed', lastError: fullError, lastRunAt: Date.now() });
    await appendLog({ level: 'error', text: `「${listing.title}」处理失败: ${fullError}` });
  } finally {
    if (tab && !keepTabOpen) {
      chrome.tabs.remove(tab.id).catch(() => {});
    }
  }
}

async function deleteOldListing(itemId, titleForLog) {
  let tab;
  try {
    tab = await chrome.tabs.create({ url: `https://www.facebook.com/marketplace/item/${itemId}/`, active: false });
    await waitForContentReady(tab.id, 30000);
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
        thumbUrl: quickInfo.thumbUrl || '',
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
    await waitForContentReady(tab.id, 30000);
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
    // 类别/成色读不到的时候,把当时页面上的候选按钮文字跟着商品一起存下来——
    // 不然只有导入那一刻的日志里能看到这份诊断,过一阵子日志被冲掉、或者用户
    // 直接测「重新上架」失败发的是另一条日志,这份线索就没了。存在商品身上,
    // 之后不管哪次失败,日志里都能带上同一份诊断,不用非要抓准导入那一刻。
    categoryConditionDiag: scraped.categoryConditionDiag || null,
    ...(await autoRepostFieldsFor(repostDays)),
  };
  let saved;
  if (idx !== -1) {
    listings[idx] = { ...listings[idx], ...fields };
    saved = listings[idx];
  } else {
    saved = genListing({
      ...fields,
      sourceItemId: itemId || null,
      sourceUrl: itemId ? `https://www.facebook.com/marketplace/item/${itemId}/` : null,
      importedAt: Date.now(),
    });
    listings.push(saved);
  }
  await saveListings(listings);
  await appendLog({ level: 'success', text: `已读取完整信息:「${title || itemId}」` });
  writeListingToFolder(saved).catch(() => {});
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
    writeListingToFolder(listings[idx]).catch(() => {});
    return;
  }
  const saved = genListing({
    title: quickInfo.title || '',
    price: quickInfo.priceText || '',
    thumbUrl: quickInfo.thumbUrl || '',
    sourceItemId: itemId || null,
    sourceUrl: itemId ? `https://www.facebook.com/marketplace/item/${itemId}/` : null,
    status: 'imported',
    importedAt: Date.now(),
    ...(await autoRepostFieldsFor(7)),
  });
  listings.push(saved);
  await saveListings(listings);
  await appendLog({
    level: 'success',
    text: `已导入基本信息(标题/价格):「${quickInfo.title || itemId || '商品'}」`,
  });
  writeListingToFolder(saved).catch(() => {});
}

// ---------- 卡死记录自动修复:没有真实编号的记录,趁用户逛"你的商品"页面顺手补上 ----------

// 之前遇到过好几次:某条记录一开始选中的时候就没能读到 Facebook 真实商品
// 编号(不同卡片样式/商品状态下,页面结构不完全一样,提取编号不是每次都
// 管用),一旦发生,这条记录就永久卡死——"删掉重新选同一个商品"救不回来,
// 因为重新选会再踩一次同样的提取失败,死循环。用户来回试了很多次都卡在
// 这里,必须换个不依赖"用户手动操作对了"的办法。
//
// 现在的办法:content-my-listings.js 只要检测到用户正在浏览"你的商品"页面,
// 不需要用户点选任何东西,就会自动把页面上(以及网络请求里)能看到的所有
// 商品「标题 + 真实编号」扫一遍、发过来。这里收到以后,拿这份列表去比对
// 已经卡死(没有编号)的旧记录,标题对得上就自动把编号补上、状态从「失败」
// 改回「待处理」,让它重新进入正常的重新上架流程——用户不需要意识到、也不
// 需要做任何"删除再重新选"这种容易出错的操作,只要照常打开那个页面逛一逛,
// 卡死的记录就会自己好。
function normalizeTitleForMatch(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function titleOverlapScore(a, b) {
  const wa = new Set(normalizeTitleForMatch(a).split(' ').filter(Boolean));
  const wb = new Set(normalizeTitleForMatch(b).split(' ').filter(Boolean));
  if (!wa.size || !wb.size) return 0;
  let common = 0;
  wa.forEach((w) => {
    if (wb.has(w)) common += 1;
  });
  return common / Math.max(wa.size, wb.size);
}

async function reconcileListings(rows) {
  if (!rows || !rows.length) return { ok: true, fixed: 0 };
  const listings = await getListings();
  let fixedCount = 0;

  for (const listing of listings) {
    if (listing.sourceItemId) continue; // 已经有真实编号的不用管
    if (!listing.title) continue;

    let best = null;
    let bestScore = 0;
    for (const row of rows) {
      if (!row || !row.id || !row.title) continue;
      const score = titleOverlapScore(listing.title, row.title);
      if (score > bestScore) {
        bestScore = score;
        best = row;
      }
    }
    if (!best || bestScore < 0.4) continue;

    listing.sourceItemId = best.id;
    listing.sourceUrl = `https://www.facebook.com/marketplace/item/${best.id}/`;
    // 之前因为没编号被判定失败、卡在原地的,现在补上编号了,重新给它一次
    // 机会,让它自己回到正常的重新上架流程里去。
    if (listing.status === 'failed') {
      listing.status = 'pending';
      listing.lastError = null;
    }
    fixedCount += 1;
    await appendLog({
      level: 'success',
      text: `逛"你的商品"页面时,自动帮「${listing.title}」找到并关联上了真实 Facebook 编号(之前是卡死状态,现在已经可以正常重新上架了)。`,
    });
  }

  if (fixedCount > 0) await saveListings(listings);
  return { ok: true, fixed: fixedCount };
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
