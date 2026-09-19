// storage.js - 公共的本地存储读写方法(popup.js 和 background.js 都会用到)

const DEFAULT_SETTINGS = {
  minDelaySeconds: 60,
  maxDelaySeconds: 150,
  // false = 只自动填表,停在发布前一步,由你本人手动点击「发布」确认(默认更安全)
  // true  = 填完表后自动点击「发布」
  autoPublish: false,
};

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
