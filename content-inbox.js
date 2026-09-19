// content-inbox.js - 注入到 Facebook 的 Marketplace 收件箱 / Messenger 页面,
// 监听新消息并按 FAQ 规则(或可选 AI)自动回复。
//
// 重要:这部分是整个插件里最「脆弱」的部分——Facebook 的消息列表 DOM
// 结构经常变化,下面这些选择器都是启发式的,不保证长期有效。默认开启
// 「试运行」模式(见 storage.js 的 autoReplyDryRun),回复只会写进日志、
// 不会真的发送,请先用试运行观察一段时间、确认识别没问题后再关闭试运行。

(function () {
  const URL_CHECK_MS = 1500;
  const RENDER_SETTLE_MS = 1200;

  let lastUrl = location.href;
  let observer = null;
  const seenRows = new WeakSet();

  function normalize(t) {
    return (t || '').trim().toLowerCase();
  }

  function threadKeyFromUrl(url) {
    return url.split('?')[0];
  }

  function findListingTitleOnPage() {
    // 尝试从会话页面顶部找到关联的商品标题(启发式,Facebook 改版可能失效)
    const link = document.querySelector('a[href*="/marketplace/item/"]');
    return link ? normalize(link.textContent) : '';
  }

  function findComposeBox() {
    return document.querySelector(
      '[contenteditable="true"][aria-label*="Message" i], ' +
        '[contenteditable="true"][aria-label*="讯息" i], ' +
        '[contenteditable="true"][aria-label*="消息" i], ' +
        '[role="textbox"][contenteditable="true"]'
    );
  }

  function getMessageRows() {
    return Array.from(document.querySelectorAll('[role="row"]'));
  }

  function isOutgoingRow(row) {
    const candidates = [row, ...row.querySelectorAll('[aria-label]')];
    for (const el of candidates) {
      const label = el.getAttribute && el.getAttribute('aria-label');
      if (label && /you sent|you:|你发送|您发送|自己发送/i.test(label)) return true;
    }
    return false;
  }

  function rowText(row) {
    return (row.innerText || row.textContent || '').trim();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function fillTemplate(tpl, vars) {
    return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''));
  }

  function matchFaq(faqs, message) {
    const m = normalize(message);
    for (const faq of faqs) {
      const keywords = (faq.keywords || '')
        .split(',')
        .map((k) => normalize(k))
        .filter(Boolean);
      if (keywords.some((k) => m.includes(k))) return faq;
    }
    return null;
  }

  async function buildReply(buyerMessage) {
    const settings = await getSettings();
    const listings = await getListings();
    const faqs = await getFaqs();

    const titleOnPage = findListingTitleOnPage();
    const listing =
      listings.find((l) => titleOnPage && normalize(l.title) && titleOnPage.includes(normalize(l.title))) || null;

    const vars = {
      title: listing ? listing.title : '',
      price: listing ? listing.price : '',
      condition: listing ? listing.condition : '',
      description: listing ? listing.description : '',
      address: settings.sellerAddress || '',
      purchase: settings.purchaseMethods || '',
    };

    const faq = matchFaq(faqs, buyerMessage);
    if (faq) return fillTemplate(faq.answer, vars);

    if (settings.aiModeEnabled && settings.aiApiKey) {
      const res = await chrome.runtime.sendMessage({
        type: 'GENERATE_AI_REPLY',
        buyerMessage,
        listing,
        sellerInfo: { address: vars.address, purchase: vars.purchase },
      });
      if (res && res.ok && res.text) return res.text;
    }

    // 规则和 AI 都没命中时的兜底通用回复
    const parts = [];
    if (listing) {
      parts.push(
        `你好,「${vars.title}」目前${vars.price ? `价格是 ${vars.price}` : '仍在出售'}${
          vars.condition ? `,成色:${vars.condition}` : ''
        }。`
      );
    } else {
      parts.push('你好,谢谢关注~');
    }
    if (vars.address) parts.push(`取货地点:${vars.address}。`);
    if (vars.purchase) parts.push(`购买/付款方式:${vars.purchase}。`);
    parts.push('有兴趣的话可以直接约时间哦!');
    return parts.join(' ');
  }

  async function sendReply(text) {
    const box = findComposeBox();
    if (!box) throw new Error('找不到消息输入框');
    box.focus();
    document.execCommand('insertText', false, text);
    await sleep(300);
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    box.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
  }

  async function handleNewIncomingMessage(text) {
    const settings = await getSettings();
    if (!settings.autoReplyEnabled) return;

    const state = await getAutoReplyState();
    const cap = settings.maxAutoRepliesPerDay || 40;
    if (state.countToday >= cap) return;

    const threadKey = threadKeyFromUrl(location.href);
    const threadState = state.threads[threadKey] || {};
    if (threadState.humanTakeover) return;

    const cooldown = (settings.perThreadCooldownSeconds || 20) * 1000;
    if (threadState.lastAutoReplyAt && Date.now() - threadState.lastAutoReplyAt < cooldown) return;

    let reply;
    try {
      reply = await buildReply(text);
    } catch (err) {
      await appendLog({ level: 'error', text: `生成自动回复失败: ${(err && err.message) || err}` });
      return;
    }
    if (!reply) return;

    if (settings.autoReplyDryRun) {
      await appendLog({ level: 'info', text: `[试运行] 收到:「${text.slice(0, 60)}」→ 若正式开启会回复:「${reply}」` });
      state.threads[threadKey] = { ...threadState, lastAutoReplyAt: Date.now(), lastAutoReplyText: null };
      state.countToday += 1;
      await saveAutoReplyState(state);
      return;
    }

    await sleep(1500 + Math.random() * 2000); // 模拟打字延迟,避免显得过于机械
    try {
      await sendReply(reply);
    } catch (err) {
      await appendLog({ level: 'error', text: `自动回复发送失败: ${(err && err.message) || err}` });
      return;
    }

    state.threads[threadKey] = { lastAutoReplyAt: Date.now(), lastAutoReplyText: reply, humanTakeover: false };
    state.countToday += 1;
    await saveAutoReplyState(state);
    await appendLog({ level: 'success', text: `已自动回复:「${reply}」` });
  }

  function markHumanTakeoverIfNeeded(outgoingText) {
    getAutoReplyState().then(async (state) => {
      const threadKey = threadKeyFromUrl(location.href);
      const threadState = state.threads[threadKey];
      if (threadState && threadState.lastAutoReplyText && normalize(outgoingText) === normalize(threadState.lastAutoReplyText)) {
        return; // 这是插件自己发的回复,不算人工接管
      }
      state.threads[threadKey] = { ...(threadState || {}), humanTakeover: true };
      await saveAutoReplyState(state);
    });
  }

  function processRows() {
    const rows = getMessageRows();
    for (const row of rows) {
      if (seenRows.has(row)) continue;
      seenRows.add(row);
      const text = rowText(row);
      if (!text) continue;
      if (isOutgoingRow(row)) {
        markHumanTakeoverIfNeeded(text);
      } else {
        handleNewIncomingMessage(text);
      }
    }
  }

  function primeSeenRows() {
    getMessageRows().forEach((row) => seenRows.add(row));
  }

  function attachObserver() {
    if (observer) observer.disconnect();
    const container = document.querySelector('[role="main"]') || document.body;
    observer = new MutationObserver(() => processRows());
    observer.observe(container, { childList: true, subtree: true });
  }

  function checkUrlChange() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    if (observer) observer.disconnect();
    // 切换会话后,先等页面把历史消息渲染出来,再把它们标记为「已读」,
    // 避免把整段历史消息误判成新消息而触发一连串自动回复
    setTimeout(() => {
      primeSeenRows();
      attachObserver();
    }, RENDER_SETTLE_MS);
  }

  primeSeenRows();
  attachObserver();
  setInterval(checkUrlChange, URL_CHECK_MS);
})();
