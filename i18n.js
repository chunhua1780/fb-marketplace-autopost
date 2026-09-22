// i18n.js - 面板界面的中英文翻译。只管插件自己弹出的这个面板/侧边栏说什么语言,
// 不影响 Facebook 网页本身、也不影响重新上架时填进 Facebook 表单里的商品内容
// (那些原样保留从 Facebook 读到的文字,不做翻译)。默认英文,可以在面板顶部的
// 下拉框切换成中文,选择会记住,下次打开面板自动生效。

const I18N = {
  en: {
    appTitle: 'FB Marketplace Smart Seller Assistant',
    langLabel: 'Language',

    importH2: '① Select my existing listings',
    importHint:
      'First open your own Facebook "Marketplace → Your listings / Selling" page in the browser and keep it as ' +
      'your current tab. Click "Start selecting" then go back to that page — hovering over one of your listings ' +
      'shows a blue highlight; click it and it\'s selected instantly (nothing pops up, nothing blocks the screen), ' +
      'so you can click through many in a row. Each click shows up right away in the "Listing queue" below, and ' +
      'the full details (category/condition/description/photos) get filled in automatically in the background. ' +
      'You can close this panel — selection mode stays on and resumes automatically when you reopen it.',
    startSelectBtn: 'Start selecting',
    stopSelectBtn: 'Stop selecting',

    listH2: '② Listing queue (auto re-post)',
    listHint:
      'Imported listings automatically enter the "auto re-post when due" cycle — after a randomized delay, the ' +
      'old version gets deleted and a fresh one posted so it always looks newest, with no manual adjustment ' +
      'needed. Whether the old version also gets deleted is controlled by a master switch below in "Posting ' +
      'settings" (on by default).',
    listEmpty: 'No items yet — use "Start selecting" above to import some, or manually add one at the bottom of the panel.',

    filestoreH2: 'Local folder mirror',
    filestoreHint:
      "Optional: pick a folder on your computer once, and every imported item's info and photos will " +
      'automatically be mirrored there in the background (one subfolder per item) — you can browse it directly ' +
      "in your file manager. This is just a convenience copy; the extension itself keeps working from its own " +
      "storage even if this isn't set up or access lapses.",
    pickFolderBtn: 'Choose save folder',
    clearFolderBtn: 'Clear',
    filestoreNotSet: 'Not set up — imported items are only kept in the extension\'s own storage for now.',
    filestoreGranted: '✅ Folder access granted — items are automatically mirrored there.',
    filestoreNeedsReauth: '⚠️ A folder was chosen before, but access needs to be re-confirmed. Click "Choose save folder" again and pick the same folder.',
    filestoreUnsupported: '⚠️ Your browser does not support choosing a local folder (needs a recent Chrome). This feature is optional and the rest of the extension is unaffected.',
    filestorePickFailed: 'Could not set the folder: {error}',
    filestoreCleared: 'Folder mirror turned off.',

    settingsH2: 'Posting settings',
    sMinLabel: 'Minimum interval per item (seconds)',
    sMaxLabel: 'Maximum interval per item (seconds)',
    sAutopublishLabel: 'Auto-click "Publish" (unchecked = auto-fill only, you confirm publish manually — safer)',
    sAutoDeleteLabel:
      'Auto-delete the old version on Facebook when re-posting (⚠️ irreversible, on by default; turning it off ' +
      "still auto re-posts, it just won't delete the old version)",
    saveSettingsBtn: 'Save posting settings',

    sellerH2: 'Seller info (used for auto-replies)',
    sAddressLabel: 'Pickup / meetup address',
    sAddressPlaceholder: 'e.g. San Francisco, CA area, by appointment',
    sPurchaseLabel: 'Payment methods',
    sPurchasePlaceholder: 'e.g. Cash / Zelle / Venmo, in person',
    saveSellerBtn: 'Save seller info',

    autoreplyH2: 'Auto-reply (inquiry bot)',
    autoreplyHint:
      'Defaults to "dry run" mode: only shows what it would reply in the log below, without actually sending ' +
      'anything. Recommended to watch it for a while before turning dry run off.',
    arEnabledLabel: 'Enable auto-reply',
    arDryrunLabel: "Dry run (log only, don't actually send)",
    arMaxPerDayLabel: 'Max auto-replies per day',
    arCooldownLabel: 'Min seconds between replies in the same thread',
    arAiEnabledLabel: 'Use AI when no FAQ rule matches (requires your own Anthropic API key)',
    arAiKeyLabel: 'Anthropic API Key',
    arAiModelLabel: 'AI model',
    saveAutoreplyBtn: 'Save auto-reply settings',

    faqH2: 'FAQ scripts (matched by keyword)',
    faqKeywordsPlaceholder: 'Keywords, comma separated',
    faqAnswerPlaceholder: 'Reply script, can use the variables above',
    faqAddBtn: 'Add script',
    faqDeleteBtn: 'Delete',

    runH2: 'Publish queue',
    startBtn: 'Start publish queue',
    stopBtn: 'Stop',

    formTitleAdd: 'Manually add an item (rarely used, kept last)',
    formTitleEdit: 'Edit item',
    fTitleLabel: 'Title',
    fTitlePlaceholder: 'e.g. Solid wood dining table, seats 4',
    fPriceLabel: 'Price',
    fPricePlaceholder: 'e.g. 1200',
    fCategoryLabel: 'Category (must exactly match the name shown on Facebook)',
    fConditionLabel: 'Condition',
    fLocationLabel: 'Location',
    fDescriptionLabel: 'Description',
    fDescriptionPlaceholder: 'Item description...',
    fPhotosLabel: 'Photos',
    fRepostEnabledLabel: 'Auto re-post when due (keeps the listing ranked higher)',
    fRepostDaysLabel: 'Interval (days)',
    fDeleteOldLabel:
      'Auto-delete the old version on Facebook after a successful re-post (⚠️ irreversible, also needs the ' +
      'master switch above in "Posting settings" turned on)',
    saveBtn: 'Save item',
    cancelEditBtn: 'Cancel edit',

    statusPending: 'Pending',
    statusRunning: 'Posting...',
    statusFilledAwaitingReview: 'Filled in, awaiting your confirmation',
    statusPosted: 'Posted',
    statusImported: 'Imported from Facebook',
    statusReadingDetails: '⏳ Reading full details in the background...',
    statusFailed: 'Failed',

    badgeLinkedFb: '📥 Linked to a real Facebook listing (ID ...{id})',
    badgeRepost: '🔁 Auto re-post every {days} days',
    badgeDeleteOld: '⚠️ Re-posting will auto-delete the old version',

    actionRepost: 'Re-post now',
    actionEdit: 'Edit',
    actionRetry: 'Reset to pending',
    actionDelete: 'Delete',

    confirmDeleteListing: "Delete this item from the plugin? (won't affect whether it still exists on Facebook)",
    alertTitleRequired: 'Please fill in a title',
    alertRepostFail: 'Could not start re-posting: {error}',
    alertQueueFail: 'Could not start: {error}',
    alertFaqRequired: 'Please fill in both keywords and the reply script',

    importStatusNotFb:
      '⚠️ Current tab is not your Facebook "Your listings / Selling" page (facebook.com/marketplace/you/selling). ' +
      'Please switch to that page in the browser first, then come back and click the extension icon.',
    importStatusConnected: '✅ Connected to current page: {url}',
    importStatusNotConnected:
      "⚠️ The extension script hasn't connected to this page yet. The most common cause is this Facebook tab " +
      'was already open before installing/updating the extension — please refresh it (F5) and click the ' +
      'extension icon again.\nURL: {url}\nOriginal error: {error}',
    selectModeOn:
      'Selection mode is on — go back to the Facebook page, hover over your listings, and click to select. ' +
      'You can click through many in a row.',
    startSelectFailed: 'Failed to start: {error}',
  },

  zh: {
    appTitle: 'FB Marketplace 智能卖家助手',
    langLabel: '语言',

    importH2: '① 点选我已有的商品',
    importHint:
      '先在浏览器里打开你自己 Facebook 的「Marketplace → 我的商品/正在出售」页面,保持它是你当前正在看的这个标签' +
      '页。点「开始点选商品」后回到那个页面,把鼠标移到你自己的商品上会出现蓝色高亮框,点一下就会立刻选中(不会' +
      '弹出任何东西、不挡屏幕),可以连续点很多个;每点一个,下面的「商品队列」里会马上出现这一条,后台会自动把' +
      '完整信息(类别/成色/描述/图片)读完补上。这个面板可以关掉没关系,点选状态会保留,重开面板会自动恢复。',
    startSelectBtn: '开始点选商品',
    stopSelectBtn: '停止点选',

    listH2: '② 商品队列(自动重新上架)',
    listHint:
      '点选导入的商品会自动进入「到期自动重新上架」循环——过一段随机的时间就会自动把这条商品删掉旧的、发一个新' +
      '的上去,保持它显示成最新,不用再手动调节。要不要连旧版本一起自动删除,在下面「发布设置」里有一个总开关' +
      '(默认开启)。',
    listEmpty: '还没有商品——可以在上面「开始点选商品」导入,或者在面板最下面手动新增一个',

    filestoreH2: '本地文件夹镜像',
    filestoreHint:
      '可选功能:在电脑上选一个文件夹,选一次之后,每个导入的商品的信息和图片都会自动在后台同步写一份到那个' +
      '文件夹里(每个商品一个子文件夹),可以直接在文件管理器里打开看。这只是锦上添花的备份,就算没设置或者' +
      '权限过期了,插件本身照样能正常工作。',
    pickFolderBtn: '选择保存文件夹',
    clearFolderBtn: '清除',
    filestoreNotSet: '还没设置——导入的商品目前只保存在插件自己的存储里。',
    filestoreGranted: '✅ 已获得文件夹读写权限,商品会自动同步保存到这里。',
    filestoreNeedsReauth: '⚠️ 之前选过一个文件夹,但权限需要重新确认。请再点一次「选择保存文件夹」,选同一个文件夹就行。',
    filestoreUnsupported: '⚠️ 你的浏览器不支持选择本地文件夹(需要较新版本的 Chrome)。这是可选功能,不影响插件其他部分正常使用。',
    filestorePickFailed: '设置文件夹失败:{error}',
    filestoreCleared: '已关闭文件夹镜像。',

    settingsH2: '发布设置',
    sMinLabel: '每个商品间隔最短(秒)',
    sMaxLabel: '每个商品间隔最长(秒)',
    sAutopublishLabel: '自动点击「发布」(不勾选则只自动填表,由你手动确认发布,更安全)',
    sAutoDeleteLabel: '重新上架时自动删除 Facebook 上的旧商品(⚠️ 不可撤销,默认开启;关掉后新导入的商品还是会自动重新上架,只是不删旧版本)',
    saveSettingsBtn: '保存发布设置',

    sellerH2: '商家信息(自动回复时会用到)',
    sAddressLabel: '取货 / 交易地址',
    sAddressPlaceholder: '例如:San Francisco, CA 一带,约好时间见面',
    sPurchaseLabel: '购买 / 付款方式',
    sPurchasePlaceholder: '例如:现金 / Zelle / Venmo,面交',
    saveSellerBtn: '保存商家信息',

    autoreplyH2: '自动回复(询盘机器人)',
    autoreplyHint: '默认「试运行」模式:只在下方日志里显示会怎么回复,不会真的发送消息。建议先观察一段时间,确认识别没问题后再关闭试运行。',
    arEnabledLabel: '开启自动回复',
    arDryrunLabel: '试运行(只记录日志,不真的发送)',
    arMaxPerDayLabel: '每天最多自动回复次数',
    arCooldownLabel: '同一对话两次自动回复的最短间隔(秒)',
    arAiEnabledLabel: '规则库没命中时,用 AI 智能生成回复(需要你自己的 Anthropic API Key)',
    arAiKeyLabel: 'Anthropic API Key',
    arAiModelLabel: 'AI 模型',
    saveAutoreplyBtn: '保存自动回复设置',

    faqH2: '常见问题话术(按关键词匹配)',
    faqKeywordsPlaceholder: '关键词,用逗号分隔',
    faqAnswerPlaceholder: '回答话术,可用上面的变量',
    faqAddBtn: '添加话术',
    faqDeleteBtn: '删除',

    runH2: '发布队列',
    startBtn: '开始发布队列',
    stopBtn: '停止',

    formTitleAdd: '手动新增商品(不常用,放在最后)',
    formTitleEdit: '编辑商品',
    fTitleLabel: '标题',
    fTitlePlaceholder: '例如:实木餐桌 四人座',
    fPriceLabel: '价格',
    fPricePlaceholder: '例如:1200',
    fCategoryLabel: '类别(需与 Facebook 页面上显示的名称完全一致)',
    fConditionLabel: '成色',
    fLocationLabel: '地点',
    fDescriptionLabel: '描述',
    fDescriptionPlaceholder: '商品描述...',
    fPhotosLabel: '照片',
    fRepostEnabledLabel: '到期后自动重新上架(保持商品排名靠前)',
    fRepostDaysLabel: '间隔天数',
    fDeleteOldLabel: '重新上架成功后,自动删除 Facebook 上的旧版本(⚠️ 不可撤销,还需要在上面「发布设置」里打开总开关才会生效)',
    saveBtn: '保存商品',
    cancelEditBtn: '取消编辑',

    statusPending: '待发布',
    statusRunning: '发布中...',
    statusFilledAwaitingReview: '已填表,待你确认发布',
    statusPosted: '已发布',
    statusImported: '已从 Facebook 导入',
    statusReadingDetails: '⏳ 正在后台读取完整信息...',
    statusFailed: '失败',

    badgeLinkedFb: '📥 已关联 Facebook 真实商品(编号 ...{id})',
    badgeRepost: '🔁 每 {days} 天自动重新上架',
    badgeDeleteOld: '⚠️ 重新上架会自动删旧版本',

    actionRepost: '立即重新上架',
    actionEdit: '编辑',
    actionRetry: '重设为待发布',
    actionDelete: '删除',

    confirmDeleteListing: '确定从插件里删除这个商品吗?(不会影响它在 Facebook 上是否存在)',
    alertTitleRequired: '请填写标题',
    alertRepostFail: '无法开始重新上架: {error}',
    alertQueueFail: '无法开始: {error}',
    alertFaqRequired: '关键词和话术都要填写',

    importStatusNotFb: '⚠️ 当前标签页不是你的「我的商品/正在出售」页面(facebook.com/marketplace/you/selling)。请先在浏览器里切换到那个页面,再回来点插件图标。',
    importStatusConnected: '✅ 已连接到当前页面:{url}',
    importStatusNotConnected:
      '⚠️ 插件脚本还没连上这个页面。最常见的原因是这个 Facebook 标签页是插件安装/更新之前就开着的——请刷新一下' +
      '这个标签页(F5),再重新点插件图标。\n网址:{url}\n原始错误:{error}',
    selectModeOn: '点选模式已开启——回到 Facebook 页面,把鼠标移到你的商品上,点一下就会自动选中并读取,可以连续点多个。',
    startSelectFailed: '开启失败:{error}',
  },
};

let currentLang = 'en';

function t(key, vars) {
  const dict = I18N[currentLang] || I18N.en;
  let str = (dict && dict[key]) || (I18N.en && I18N.en[key]) || key;
  if (vars) {
    Object.keys(vars).forEach((k) => {
      str = str.split('{' + k + '}').join(vars[k]);
    });
  }
  return str;
}

function applyStaticTranslations() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
  });
  document.title = t('appTitle');
}

async function loadLang() {
  const { uiLang } = await chrome.storage.local.get('uiLang');
  currentLang = uiLang === 'zh' ? 'zh' : 'en';
  return currentLang;
}

async function setLang(lang) {
  currentLang = lang === 'zh' ? 'zh' : 'en';
  await chrome.storage.local.set({ uiLang: currentLang });
}
