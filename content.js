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
  async function attachPhotos(photos, steps) {
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

    // 必须先记完"上传之前有几张图",再触发变化事件——顺序不能反。如果
    // Facebook 在事件处理函数里是同步地(不是等 React 下一轮渲染)直接往
    // DOM 插入预览图,那等触发完事件才去数"上传前"的数量,这一刻其实已经
    // 是"上传后"的数量了,两次数出来的自然一样多,会被误判成"完全没反应"。
    const beforeCount = document.querySelectorAll('img').length;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    // 这里本来是想确认"Facebook 收到并且在处理"——等页面上新出现预览缩略图
    // (数 <img> 标签数量变化)。但这只是一个启发式信号,不是可靠的事实:
    // Facebook 的上传预览组件是 React 动态渲染的,完全有可能不是通过新增
    // <img> 标签来展示预览(比如用 background-image、canvas,或者这次渲染
    // 恰好比 8 秒还慢)——"没检测到新增 img"不等于"文件真的没上传成功"。
    // 真正确定的事实只有上面两步:文件对象都成功生成了、也成功赋给了上传
    // 控件的 FileList——这两步任何一步失败才是真正可以确定的失败。这里检测
    // 不到新增预览图,不再当成硬性失败去中断整个发布流程(以前这么做,可能
    // 把"其实已经上传成功、只是插件没观察到预览"的情况也一起误判成失败),
    // 只是记一条非致命的提示,继续往下走。
    const newCount = await waitFor(() => {
      const delta = document.querySelectorAll('img').length - beforeCount;
      return delta > 0 ? delta : null;
    }, { timeout: 8000, interval: 300 });

    if (!newCount && steps) {
      steps.push(
        `已经把 ${files.length} 张图片交给了上传控件、也触发了变化事件,但等了 8 秒页面上没有观察到新增的图片预览(不代表一定失败,继续往下走,以实际发布结果为准)`
      );
    }
    await fbSleep(1000);
  }

  // 之前这里是直接在整个 document 里搜 [role="option"]/[role="menuitem"]/li,
  // 弹出的下拉框其实通常是插到 document.body 末尾的一个浮层容器里,但页面上
  // 同时可能还残留着别的、本该已经关闭的下拉框/菜单节点(没被真正移除,只是
  // 隐藏),不分范围地整页搜有可能挑到不属于"当前刚点开这个"下拉框的选项。
  // 现在先找"当前可见的浮层容器"(listbox/menu/dialog 里最后一个出现且可见
  // 的那个),只在这个容器里面找选项;实在找不到这样的容器才退回整页搜索,
  // 保证不会因为收窄范围反而找不到东西。
  function findOpenPopupScope() {
    const containers = Array.from(document.querySelectorAll('[role="listbox"], [role="menu"], [role="dialog"]')).filter(
      (el) => el.offsetParent !== null
    );
    return containers.length ? containers[containers.length - 1] : document;
  }

  // 点完一个选项之后,不能光"点了就当选上了"——万一这次点击压根没生效(比如
  // 点到了浮层外层的空白、或者 Facebook 那次渲染还没绑定好点击事件),后面
  // 的表单字段其实还是空的,只是我们自己以为选好了。这里等一小段时间,确认
  // 要么这个选项本身被标成了"已选中"(aria-selected),要么它所在的浮层已经
  // 关掉/换掉(说明点击确实触发了下一步),两者都没发生就说明这次点击大概率
  // 没生效。
  async function confirmOptionPicked(pick) {
    const ok = await waitFor(() => {
      if (!document.body.contains(pick)) return true;
      if (pick.getAttribute('aria-selected') === 'true') return true;
      return null;
    }, { timeout: 1200, interval: 100 });
    return !!ok;
  }

  // 读"页面上这个字段控件现在实际显示的文字",不是"我们打算填成什么"——
  // 类别/成色这些字段选中后,Facebook 会把选中的值直接显示在原来那个触发
  // 控件上(field-utils.js 里 findFieldByNearbyLabel 的注释也提到过这一点),
  // 所以可以用同一套查找逻辑,选择流程走完之后再读一次,就知道 Facebook
  // 这边到底有没有真的收下这次选择,不用再靠"我们自己以为选上了"。
  function readFieldDisplayText(candidates) {
    const el = findFieldByLabel(candidates) || findFieldByNearbyLabel(candidates) || findClickableByText(candidates);
    if (!el) return '(控件都没找到)';
    const raw = 'value' in el ? el.value : el.textContent;
    const text = fbNormalize(raw || '');
    return text || '(显示为空)';
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
        const scope = findOpenPopupScope();
        const list = Array.from(scope.querySelectorAll('[role="option"], [role="menuitem"], li')).filter(
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
      await confirmOptionPicked(pick);
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
      const scope = findOpenPopupScope();
      const list = Array.from(scope.querySelectorAll('[role="option"], li')).filter((el) => el.offsetParent !== null);
      return list.length ? list : null;
    }, { timeout: 3000 });
    if (!options) throw new Error('成色下拉列表没有弹出任何选项');

    let pick = null;
    if (preferredText) pick = options.find((o) => fbNormalize(o.textContent).includes(fbNormalize(preferredText)));
    if (!pick) pick = options[0];
    pick.click();
    await confirmOptionPicked(pick);
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

  // 发布之后网址没有直接带上新商品编号时(比如跳到了"你的商品"列表页)的
  // 补救办法:在当前页面上找 /marketplace/item/编号 这种链接,按标题重叠度
  // 挑一个最像的当作"很可能就是刚发布出来的这条"。挑不出足够像的就返回
  // null——宁可没有编号,也不要瞎猜一个错的(错的编号可能会导致后面误删
  // 别的商品)。
  function findLikelyNewItemId(title) {
    if (!title) return null;
    const wanted = fbNormalize(title).split(/\s+/).filter(Boolean);
    if (!wanted.length) return null;
    const links = Array.from(document.querySelectorAll('a[href*="/marketplace/item/"]'));
    let best = null;
    let bestScore = 0;
    for (const a of links) {
      const m = a.href.match(/\/marketplace\/item\/(\d+)/);
      if (!m) continue;
      const text = fbNormalize(a.textContent || a.getAttribute('aria-label') || '');
      if (!text) continue;
      const words = new Set(text.split(/\s+/).filter(Boolean));
      const overlap = wanted.filter((w) => words.has(w)).length / wanted.length;
      if (overlap > bestScore) {
        bestScore = overlap;
        best = m[1];
      }
    }
    return bestScore >= 0.5 ? best : null;
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
        await attachPhotos(listing.photos, steps);
      }

      // 用户反馈过:上传/发布本身能走通,但发布出来的标题/价格/描述是空的。
      // 之前这里填完就直接往下走,从来没确认过"填的时候这个字段本身有没有
      // 内容"——填空值也是"成功地填了一个空字符串",不会报错,没法区分到底
      // 是「读取那一步就没读到内容」还是「读到了内容但填的时候出了什么问题」。
      // 现在每一步填完都记一条日志,带上"当时打算填的值是不是空的",下次再
      // 出现发布出来内容是空的情况,从这几行日志就能直接看出问题出在读取
      // 还是填写这一侧,不用再靠猜。
      steps.push('填写标题');
      const titleEl = findFieldByLabel(FB_LABELS.title);
      if (titleEl) setNativeValue(titleEl, listing.title || '');
      steps.push(`标题字段:${titleEl ? '找到控件' : '没找到控件'},准备填入的值${listing.title ? `「${listing.title}」` : '是空的'}`);

      steps.push('填写价格');
      const priceEl = findFieldByLabel(FB_LABELS.price);
      if (priceEl) setNativeValue(priceEl, String(listing.price ?? ''));
      steps.push(`价格字段:${priceEl ? '找到控件' : '没找到控件'},准备填入的值${listing.price ? `「${listing.price}」` : '是空的'}`);

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
      steps.push(`描述字段:${descEl ? '找到控件' : '没找到控件'},准备填入的值${listing.description ? `(${listing.description.length} 个字符)` : '是空的'}`);

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
          if (suggestion) {
            suggestion.click();
            // Location 这个控件大概率是个 React combobox,不是普通 input——点了
            // 建议项之后不能假设就一定生效了,等一下确认输入框里真的变成选中的
            // 地点文字了(而不是还停在我们自己敲进去的原始文字,或者变回空的)。
            const committed = await waitFor(() => (locEl.value && locEl.value.trim() ? true : null), { timeout: 1000, interval: 100 });
            if (!committed) {
              steps.push(`地点建议项点击后未确认生效(输入框当前显示:「${locEl.value || '(空)'}」)`);
            }
          } else {
            steps.push('地点没有弹出建议项可选,可能没有真正生效');
          }
        }
      }

      if (listing.settingsAutoPublish) {
        steps.push('自动翻页并发布');
        let publishBtn = null;
        let nextWasDisabled = false;
        for (let i = 0; i < 8; i++) {
          publishBtn = findClickableByText(FB_LABELS.publish);
          if (publishBtn) break;
          const nextBtn = findClickableByText(FB_LABELS.next);
          if (!nextBtn) break;
          // 「下一步」也可能是灰色不能点的——之前这里跟"下一步"一样,不管
          // 能不能点直接点、等 1.2 秒、再点,点满 8 次还是翻不过去才报错,
          // 报错的时候早就看不出来到底是"翻页按钮找不到"还是"翻页按钮一直
          // 是灰的"。现在跟发布按钮一样提前检查一下,是灰的就立刻停下来报
          // 具体原因,不用再空转 8 次才发现。
          const nextDisabled = nextBtn.getAttribute('aria-disabled') === 'true' || nextBtn.disabled === true;
          if (nextDisabled) {
            nextWasDisabled = true;
            break;
          }
          nextBtn.click();
          await fbSleep(1200);
        }
        if (nextWasDisabled) {
          // 之前这里报的是"从旧商品读到的原始文字",不是"Facebook 表单现在实际
          // 显示的值"——这两个可能对不上:比如类别其实点开过、但没点中真正的选项,
          // 表单上还是空的,只是我们自己读到过一个文字。现在改成直接从页面上读
          // 这几个控件当前显示的内容,才能真正回答"到底是哪个字段没提交成功",
          // 不用再靠猜。
          const currentState = {
            类别: readFieldDisplayText(FB_LABELS.category),
            成色: readFieldDisplayText(FB_LABELS.condition),
            地点: readFieldDisplayText(FB_LABELS.location),
          };
          throw new Error(
            `[NEXT_DISABLED] 「下一步」按钮是灰色不能点的状态,Facebook 认为当前这一页表单还有必填项没填好。表单上现在实际显示的值——类别:${currentState.类别} / 成色:${currentState.成色} / 地点:${currentState.地点}(供对比,原本从旧商品读到的值——类别:${listing.category || '(空)'} / 成色:${listing.condition || '(空)'} / 地点:${listing.location || '(空)'})。诊断信息:${JSON.stringify(collectDiagnostics())}`
          );
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
        // 之前这里只认「网址变成 /marketplace/item/新编号」这一种情况算成功,
        // 实测发现 Facebook 点了发布之后经常跳的其实是"你的商品"列表页
        // (/marketplace/you/selling),不是新商品自己的详情页——这种情况下之前
        // 的代码会误判成"没有真的发布成功",商品明明发出去了却被记成失败,还
        // 会一直重试。现在只要网址已经离开了发布表单本身(不管具体跳到哪),
        // 就先认为发布这个动作大概率是成功的,再尝试从当前页面按标题找出新
        // 商品的编号——找不到编号不会当成失败,只是没法确认具体是哪个新编号
        // (这不影响下面"删旧商品"的安全逻辑:background.js 那边只有真的拿到
        // 了确认的新编号才会去删旧的,没编号就只是不删,不会误删)。
        const outcome = await waitFor(() => {
          const info = captureNewItemId();
          if (info.newItemId) return { kind: 'item-url', ...info };
          if (!location.href.includes('/marketplace/create/item')) return { kind: 'navigated-away' };
          return null;
        }, { timeout: 8000 });

        if (!outcome) {
          throw new Error(
            `已经点击了「发布」按钮,但等了几秒网址还留在发布表单页面,不确定是不是真的发布成功了,请手动检查。诊断信息:${JSON.stringify(collectDiagnostics())}`
          );
        }
        if (outcome.kind === 'item-url') {
          return { ok: true, published: true, steps, newItemId: outcome.newItemId, newItemUrl: outcome.newItemUrl };
        }
        steps.push('网址跳去了「你的商品」这类页面,不是新商品自己的详情页,已尝试按标题在页面上找出新商品编号');
        const likelyId = findLikelyNewItemId(listing.title);
        return {
          ok: true,
          published: true,
          steps,
          newItemId: likelyId,
          newItemUrl: likelyId ? `https://www.facebook.com/marketplace/item/${likelyId}/` : null,
        };
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
