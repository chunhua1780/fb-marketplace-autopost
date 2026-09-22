// storage.js - 公共的本地存储读写方法(popup.js / background.js / content 脚本都会用到)
//
// 用 globalThis.X 而不是顶层 const 来定义这两个默认值,是因为这个文件现在会被
// 好几个 content_scripts 范围互相重叠的入口一起加载,同一个页面上可能被注入
// 不止一次——顶层 const 被执行第二次会直接报 "already been declared" 让整个
// 内容脚本崩掉。background.js 是通过 importScripts 加载的 service worker,没有
// window,所以这里必须用到处都有的 globalThis,不能用 window。

if (typeof globalThis.DEFAULT_SETTINGS === 'undefined') {
  globalThis.DEFAULT_SETTINGS = {
    // 发布队列节奏
    minDelaySeconds: 60,
    maxDelaySeconds: 150,
    // 默认开启——不然重新上架每次都只是把表单填好、停在发布前一步不点下去,
    // 等于还要你自己去找到那个后台标签页、手动点一次「发布」,跟纯手动发布没什么
    // 区别。开着才是真正意义上的「全自动重新上架」。不放心的话可以在「发布设置」
    // 里关掉,关掉后会在填完表单、发布前停住,由你自己确认。
    autoPublish: true,

    // 重新上架时是否自动删除 Facebook 上的旧商品——默认开启,因为「删旧发新、
    // 保持最新」本来就是这个插件存在的核心目的,不应该还要用户自己去每条商品
    // 设置里手动打开。不放心的话可以在「发布设置」里关掉这个总开关,关掉之后
    // 新导入的商品还是会自动重新上架,只是不会删除旧版本,更保守一些。
    autoDeleteOldListings: true,

    // 商家信息(用于自动回复里告知买家地址/购买方式)
    sellerAddress: '',
    purchaseMethods: '',

    // 自动回复(询盘机器人)
    autoReplyEnabled: false,
    // 试运行:只把「会怎么回复」写进日志,不真的发送消息。强烈建议先用试运行验证选择器有效
    autoReplyDryRun: true,
    maxAutoRepliesPerDay: 40,
    perThreadCooldownSeconds: 20,

    // 可选的 AI 智能回复(需要用户自己的 Anthropic API Key,规则库没匹配到时才会用到)
    aiModeEnabled: false,
    aiApiKey: '',
    aiModel: 'claude-haiku-4-5',
  };
}

if (typeof globalThis.DEFAULT_FAQS === 'undefined') {
  globalThis.DEFAULT_FAQS = [
    {
      keywords: '还在,还有,available,still have,still available',
      answer: '在的~「{{title}}」还没卖出,价格是 {{price}},随时可以约时间来看货!',
    },
    {
      keywords: '最低,能便宜,可以少,划价,底价,lowest,best price,discount',
      answer: '目前的价格是 {{price}},已经是比较实在的价格了,如果诚心要可以再聊聊~',
    },
    {
      keywords: '地址,哪里取,在哪,location,where,pick up,pickup',
      answer: '方便取货的地点是:{{address}}。可以提前约好时间过来拿哦!',
    },
    {
      keywords: '怎么买,如何购买,付款,支付,how to buy,payment,how do i pay',
      answer: '购买/付款方式:{{purchase}}。确定要的话可以直接约时间见面交易~',
    },
    {
      keywords: '成色,新旧,used,condition,新的吗',
      answer: '成色是:{{condition}}。{{description}}',
    },
  ];
}

function genId() {
  return 'l_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// 统一的商品对象结构。手动新增(popup.js)和从 Facebook 导入(background.js)
// 都通过这个函数生成,保证字段一致。
function genListing(data) {
  return {
    id: genId(),
    status: 'pending', // pending / running / filled_awaiting_review / posted / imported / failed
    lastError: null,
    lastRunAt: null,

    // 到期自动重新上架
    repostEnabled: false,
    repostIntervalDays: 7,
    nextRepostAt: null,

    // 关联到 Facebook 上真实商品的 id(手动新增的没有,导入/发布成功后才会有)
    sourceItemId: null,
    sourceUrl: null,
    importedAt: null,

    // 重新上架成功后,是否自动去删除 Facebook 上的旧版本(默认关闭,很危险,见 README)
    deleteOldOnRepost: false,

    ...data,
  };
}

async function getListings() {
  const { listings = [] } = await chrome.storage.local.get('listings');
  return listings;
}

async function saveListings(listings) {
  await chrome.storage.local.set({ listings });
}

async function getSettings() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}

async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
}

async function appendLog(entry) {
  const { runLog = [] } = await chrome.storage.local.get('runLog');
  runLog.push({ time: Date.now(), ...entry });
  await chrome.storage.local.set({ runLog: runLog.slice(-200) });
}

async function getFaqs() {
  const { faqs } = await chrome.storage.local.get('faqs');
  if (!faqs || !faqs.length) {
    const seeded = DEFAULT_FAQS.map((f) => ({ id: genId(), ...f }));
    await chrome.storage.local.set({ faqs: seeded });
    return seeded;
  }
  return faqs;
}

async function saveFaqs(faqs) {
  await chrome.storage.local.set({ faqs });
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function getAutoReplyState() {
  const { autoReplyState } = await chrome.storage.local.get('autoReplyState');
  const key = todayKey();
  if (!autoReplyState || autoReplyState.dateKey !== key) {
    const fresh = { dateKey: key, countToday: 0, threads: {} };
    await chrome.storage.local.set({ autoReplyState: fresh });
    return fresh;
  }
  return autoReplyState;
}

async function saveAutoReplyState(state) {
  await chrome.storage.local.set({ autoReplyState: state });
}
