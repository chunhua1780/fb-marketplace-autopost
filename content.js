// content.js - 注入到 Facebook Marketplace「发布商品」页面,自动找到表单并填写
// 依赖 field-utils.js 提供的 DOM 辅助方法(manifest.json 里已经一起注入)

(function () {
  // 之前这里是"设好 input.files、触发一次 change 事件、傻等 1.5 秒就假设
  // 成功了"——从来没有真正确认过 Facebook 是不是真的收到、真的处理完了这些
  // 图片。这几天所有的排查都停在"读取旧商品详情"这一步,还从来没有机会验证
  // 过"上传新图片"这一步本身到底行不行——万一真正卡住重新上架的其实是这里,
  // 之前的做法完全没办法发现,报错永远只会是后面"找不到发布按钮"这种隔了
  // 好几步的下游症状,看不出真正死在哪一步。
  //
  // 现在把这一步拆成几个能分别确认的阶段,每一步都要验证"确实发生了"才往下
  // 走,哪一步卡住,报错信息就直接说是哪一步,不用再靠猜。
  async function attachPhotos(photos) {
    if (!photos || !photos.length) return;

    const input = await waitFor(() => document.querySelector('input[type="file"]'));
    if (!input) throw new Error('[FILE_INPUT_NOT_FOUND] 找不到上传照片的输入框,可能是页面结构已变化');

    const files = [];
    for (const p of photos) {
      const res = await fetch(p.dataUrl);
      const blob = await res.blob();
      files.push(new File([blob], p.name || 'photo.jpg', { type: blob.type || 'image/jpeg' }));
    }
    if (files.length !== photos.length) {
      throw new Error(`[FILE_OBJECT_INCOMPLETE] 只成功把 ${files.length}/${photos.length} 张图片转换成了可上传的文件,中间某几张失败了`);
    }

    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    input.files = dt.files;
    if (input.files.length !== files.length) {
      throw new Error(`[FILE_LIST_ASSIGN_FAILED] 浏览器没能把这 ${files.length} 个文件真正赋给上传控件,控件上实际只看到 ${input.files.length} 个——这一步是纯浏览器层面的操作,失败大概率是 Facebook 改了这个控件的写法`);
    }

    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    // 这才是真正能确认"Facebook 收到并且在处理"的信号——不是傻等几秒钟就
    // 假设成功,而是真的等页面上新出现预览缩略图。页面上其他地方也可能同时
    // 有别的图片在加载(头像、图标之类),所以看的是"新增了多少张",不是
    // "总共有多少张"。
    const beforeCount = document.querySelectorAll('img').length;
    const newCount = await waitFor(() => {
      const delta = document.querySelectorAll('img').length - beforeCount;
      return delta > 0 ? delta : null;
    }, { timeout: 8000, interval: 300 });

    if (!newCount) {
      throw new Error(
        `[UPLOAD_PREVIEW_NOT_DETECTED] 已经把 ${files.length} 张图片交给了上传控件、也触发了变化事件,但等了 8 秒页面上完全没有新出现的图片预览——文件本身交过去了,但 Facebook 那边好像没收到或者没处理这次上传,不是插件这边卡住不动`
      );
    }
    // 新增数量没有精确匹配到预期张数不算失败——缩略图渲染方式不一定是一张
    // 图对应一个 <img>,数不准很正常,重要的是确认了"确实有新内容出现",不是
    // 完全没反应。
    await fbSleep(1000);
  }

  // 类别选得准不准不重要,重要的是必须选上——Facebook 要求这个字段非空才会
  // 解锁发布按钮。类别选择器大概率点开后弹出的是一整棵分类树(选大类→再选
  // 子类,可能还有第三层),不是一层列表,所以这里不要求精确匹配:能对上原来
  // 读到的类别文字就优先选那个,对不上就直接选当前弹出的这一层里第一个选项;
  // 选完如果又冒出下一层新的选项列表,就在新的这层里继续选第一个,最多试几层,
  // 保证类别这一项最终有值、不是空的。
  async function selectCategoryBestEffort(triggerCandidates, preferredText) {
    const trigger = await waitFor(
      () => findFieldByLabel(triggerCandidates) || findFieldByNearbyLabel(triggerCandidates) || findClickableByText(triggerCandidates)
    );
    if (!trigger) throw new Error('找不到「类别」对应的选择控件');
    trigger.click();
    await fbSleep(500);

    let remainingPreferred = preferredText;
    for (let level = 0; level < 4; level++) {
      const options = await waitFor(() => {
        const list = Array.from(document.querySelectorAll('[role="option"], [role="menuitem"], li')).filter(
          (el) => el.offsetParent !== null
        );
        return list.length ? list : null;
      }, { timeout: 2500 });
      if (!options) break; // 没有新的选项列表弹出来了,说明这一层已经选到头

      let pick = null;
      if (remainingPreferred) {
        pick = options.find((o) => fbNormalize(o.textContent).includes(fbNormalize(remainingPreferred)));
      }
      if (!pick) pick = options[0];
      remainingPreferred = null; // 只在第一层尝试匹配原来的类别文字,子分类直接选第一个

      pick.click();
      await fbSleep(600);
    }
  }

  // 成色也一样改成"选得准不准不重要,重要的是必须选上"——实测下来,不少商品
  // 压根就没能读到成色文字(不是插件哪里没写对,是 Facebook 商品详情页本身
  // 就没把这个信息带出来,读不到不代表以后就一定能读到)。之前的做法是:读到
  // 了就试着精确匹配、读不到就完全跳过这个字段,导致这些商品的成色永远是空
  // 的,Facebook 很可能因为这个必填项没填而不让发布。现在换成跟类别一样的
  // 思路:不管有没有读到原来的成色文字,都尝试把这个下拉框点开、选一个选项
  // (读到过文字的话优先选对得上的,没有就选第一个),保证这个字段最终有值。
  async function selectConditionBestEffort(triggerCandidates, preferredText) {
    const trigger = await waitFor(
      () => findFieldByLabel(triggerCandidates) || findFieldByNearbyLabel(triggerCandidates) || findClickableByText(triggerCandidates)
    );
    if (!trigger) throw new Error('找不到「成色」对应的选择控件');
    trigger.click();
    await fbSleep(400);

    const options = await waitFor(() => {
      const list = Array.from(document.querySelectorAll('[role="option"], li')).filter((el) => el.offsetParent !== null);
      return list.length ? list : null;
    }, { timeout: 3000 });
    if (!options) throw new Error('成色下拉列表没有弹出任何选项');

    let pick = null;
    if (preferredText) pick = options.find((o) => fbNormalize(o.textContent).includes(fbNormalize(preferredText)));
    if (!pick) pick = options[0];
    pick.click();
    await fbSleep(300);
  }

  // 发布成功后 Facebook 通常会跳到新商品自己的页面,尝试从网址里读出新商品的 id,
  // 这样背景脚本以后就能精确地找到「这一次发布出来的新商品」(比如用来在下次
  // 重新上架时删除它,而不是删错别的商品)。读不到就返回 null,不影响其他功能。
  function captureNewItemId() {
    const m = location.href.match(/\/marketplace\/item\/(\d+)/);
    if (!m) return { newItemId: null, newItemUrl: null };
    return { newItemId: m[1], newItemUrl: `https://www.facebook.com/marketplace/item/${m[1]}/` };
  }

  async function fillListing(listing) {
    const steps = [];
    try {
      steps.push('等待表单加载');
      const titleReady = await waitFor(() => findFieldByLabel(FB_LABELS.title), { timeout: 20000 });
      if (!titleReady) {
        throw new Error(
          `页面加载超时,没有找到标题输入框(可能未登录、要先手动选一个类目、或 Facebook 改版)。诊断信息:${JSON.stringify(collectDiagnostics())}`
        );
      }

      if (listing.photos && listing.photos.length) {
        steps.push('上传照片');
        await attachPhotos(listing.photos);
      }

      steps.push('填写标题');
      const titleEl = findFieldByLabel(FB_LABELS.title);
      if (titleEl) setNativeValue(titleEl, listing.title || '');

      steps.push('填写价格');
      const priceEl = findFieldByLabel(FB_LABELS.price);
      if (priceEl) setNativeValue(priceEl, String(listing.price ?? ''));

      // 类别用户明确说了选得准不准不重要,重要的是必须选上一个,不然 Facebook
      // 不会解锁发布按钮——所以这里不管有没有从旧商品读到具体类别文字,都会
      // 尝试把类别选择器点开、选一个选项(优先匹配读到的文字,匹配不到就选
      // 弹出来的第一个),真选不上也只是跳过、让用户自己补一下,不应该因为这个
      // 把标题/价格/描述/图片这些已经填好的内容也一起作废、整个判失败。
      steps.push('选择类别');
      try {
        await selectCategoryBestEffort(FB_LABELS.category, listing.category);
      } catch (err) {
        steps.push(`选择类别失败(已跳过,请手动选择类别): ${(err && err.message) || err}`);
      }

      // 成色跟类别一样,不管有没有从旧商品读到具体成色文字,都尝试把下拉框
      // 点开选一个(优先匹配读到的文字,匹配不到就选第一个),保证这个必填项
      // 有值——选不上也只是跳过,不影响标题/价格/描述/图片这些已经填好的内容。
      steps.push('选择成色');
      try {
        await selectConditionBestEffort(FB_LABELS.condition, listing.condition);
      } catch (err) {
        steps.push(`选择成色失败(已跳过,请手动选择成色${listing.condition ? `「${listing.condition}」` : ''}): ${(err && err.message) || err}`);
      }

      steps.push('填写描述');
      const descEl = findFieldByLabel(FB_LABELS.description);
      if (descEl) setNativeValue(descEl, listing.description || '');

      if (listing.location) {
        steps.push('填写地点');
        const locEl = findFieldByLabel(FB_LABELS.location);
        if (locEl) {
          setNativeValue(locEl, listing.location);
          await fbSleep(800);
          const suggestion = await waitFor(
            () => document.querySelector('[role="listbox"] [role="option"], ul[role="listbox"] li'),
            { timeout: 3000 }
          );
          if (suggestion) suggestion.click();
        }
      }

      if (listing.settingsAutoPublish) {
        steps.push('自动翻页并发布');
        let publishBtn = null;
        for (let i = 0; i < 8; i++) {
          publishBtn = findClickableByText(FB_LABELS.publish);
          if (publishBtn) break;
          const nextBtn = findClickableByText(FB_LABELS.next);
          if (!nextBtn) break;
          nextBtn.click();
          await fbSleep(1200);
        }
        if (!publishBtn) {
          // 之前这里的报错不带诊断信息,排查一次就要问用户要一次截图——现在跟
          // 「找不到标题输入框」那个报错一样,把当前页面上所有看起来像按钮的
          // 文字都列出来,下次再出这个错,日志里就直接有答案,不用再来回一轮。
          throw new Error(
            `已自动填好表单,但没找到「发布」按钮,请手动检查并点击发布。诊断信息:${JSON.stringify(collectDiagnostics())}`
          );
        }
        // 「发布」按钮找到了,不代表它是能点的——Facebook 经常把必填项没填全
        // 时的发布按钮渲染成灰色但还在页面上(aria-disabled="true")。之前
        // 这种情况会直接点下去,Facebook 什么反应都没有,只能等 8 秒后靠
        // "网址没跳转"这个更晚的信号才发现有问题,报错也说不清到底是哪个
        // 环节。现在提前检查一下,能立刻说清楚"按钮找到了但是灰的,肯定是
        // 少了某个必填项",不用再等那 8 秒、也不用再猜。
        const isDisabled = publishBtn.getAttribute('aria-disabled') === 'true' || publishBtn.disabled === true;
        if (isDisabled) {
          throw new Error(
            `[PUBLISH_DISABLED] 找到了「发布」按钮,但它是灰色不能点的状态——说明表单里还有某个必填项没填(图片/类别/成色/地点这些都有可能),不是没找到按钮的问题。诊断信息:${JSON.stringify(collectDiagnostics())}`
          );
        }
        publishBtn.click();

        // 点了「发布」按钮不代表真的发布成功了——可能因为漏了某个必填项、
        // 网络问题之类的原因,Facebook 什么反应都没有,或者弹出一条错误提示,
        // 网址还留在原来的 /marketplace/create/item。真正发布成功之后,
        // Facebook 通常会跳转到这个新商品自己的页面,网址里带着新商品的编号——
        // 用这个当作「是不是真的发布出去了」的判断依据,而不是点了按钮、睡了
        // 几秒就直接当成功,这样万一没真的发出去,至少不会把旧商品删掉却什么
        // 新的都没有。
        steps.push('确认发布是否真的成功');
        const newItemInfo = await waitFor(() => {
          const info = captureNewItemId();
          return info.newItemId ? info : null;
        }, { timeout: 8000 });

        if (!newItemInfo) {
          throw new Error(
            `已经点击了「发布」按钮,但等了几秒网址还是没有跳转到新商品自己的页面,不确定是不是真的发布成功了,请手动检查。诊断信息:${JSON.stringify(collectDiagnostics())}`
          );
        }
        return { ok: true, published: true, steps, ...newItemInfo };
      }

      return { ok: true, published: false, steps };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err), steps };
    }
  }

  chrome.runtime.sendMessage({ type: 'CONTENT_READY' }).catch(() => {});

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'FILL_LISTING') {
      const listing = { ...message.listing, settingsAutoPublish: !!(message.settings && message.settings.autoPublish) };
      fillListing(listing).then(sendResponse);
      return true;
    }
  });
})();
