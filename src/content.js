/**
 * Telegram 媒体批量下载器 —— content script
 *
 * 组成：
 *  1. 桥接层：与 MAIN world 的 inject.js 通过 postMessage 通信
 *  2. 扫描层：识别 Telegram Web K/A 两套 DOM 里的 img / video / 背景图
 *  3. 交互层：右下角悬浮按钮 + 可拖拽面板（列表 / 筛选 / 命名模板 / 设置）
 *  4. 下载层：并发队列。小文件走 chrome.downloads（可保留子目录），
 *             大文件在页面主世界用 <a download> 直接触发（blob 权限所限）。
 */
(() => {
  'use strict';

  if (window.__TMD_CONTENT__) return;
  window.__TMD_CONTENT__ = true;
  if (window.top !== window) return; // 只在顶层文档运行

  const LOG = '[TMD]';
  const CHANNEL = 'TMD_BRIDGE_V1';
  const PANEL_ID = 'tmd-panel';
  // Chromium 的 URL 长度上限（约 2MB）——data: URL 超过这个字符数就别再走 downloads 通道
  const MAX_DATA_URL_CHARS = 1_900_000;
  const FAB_ID = 'tmd-fab';

  // ==================================================================== 设置

  const DEFAULT_SETTINGS = {
    // 下载
    concurrency: 2,
    // <= 该体积走 chrome.downloads（可带子目录）。上限受浏览器 URL 长度（约 2MB）约束，
    // 主世界会把它硬压到 1.25MB，所以填再大也不会突破。
    maxDataMB: 1,
    subfolder: 'Telegram/{chat}',
    template: '{date}_{index}.{ext}',
    recordFallback: true, // MSE 流式视频：实时录制兜底
    maxRecordMinutes: 10,
    // 扫描
    minPx: 64,
    includeStickers: false,
    includeLinkPreview: false,
    includeRightColumn: false,
    includeBackground: true,
    includeDataUrls: false,
    autoDetect: true,
    clearOnChatSwitch: true,
    // 滚动
    scrollDelayMs: 1100,
    maxScrollRounds: 500,
    // 每条消息上的下载按钮
    msgButton: true,
    msgButtonIncludeVideos: false, // 消息级按钮默认只收图片
    // Telegram 自己的多选 -> 一键下载选中
    selectedButton: true,
    // UI
    panelVisible: false,
    panelPos: null, // {left, top}
    settingsOpen: false,
  };

  let settings = { ...DEFAULT_SETTINGS };

  function loadSettings() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get('tmd_settings', (res) => {
          if (res && res.tmd_settings) settings = { ...DEFAULT_SETTINGS, ...res.tmd_settings };
          resolve();
        });
      } catch (_) {
        resolve();
      }
    });
  }

  let saveTimer = 0;
  function saveSettings() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        chrome.storage.local.set({ tmd_settings: settings });
      } catch (_) {}
    }, 250);
  }

  // ================================================================== 工具函数

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function log(...args) {
    console.log(LOG, ...args);
  }

  function bridgeNonce() {
    let n = document.documentElement.getAttribute('data-tmd-nonce');
    if (!n) {
      n = 'tmd-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      document.documentElement.setAttribute('data-tmd-nonce', n);
    }
    return n;
  }

  // ==================================================================== 桥接

  const pendingBridge = new Map();
  let bridgeSeq = 0;

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.ch !== CHANNEL || d.dir !== 'res' || !d.id) return;
    const p = pendingBridge.get(d.id);
    if (!p) return;
    pendingBridge.delete(d.id);
    clearTimeout(p.timer);
    p.resolve(d.payload || { ok: false, error: '空响应' });
  });

  function bridge(cmd, args, timeoutMs = 300000) {
    return new Promise((resolve) => {
      const id = 'tmd' + ++bridgeSeq + Math.random().toString(36).slice(2, 8);
      const timer = setTimeout(() => {
        pendingBridge.delete(id);
        resolve({ ok: false, error: `主世界桥接超时（${cmd}）`, code: 'BRIDGE_TIMEOUT' });
      }, timeoutMs);
      pendingBridge.set(id, { resolve, timer });
      window.postMessage({ ch: CHANNEL, dir: 'req', id, nonce: bridgeNonce(), cmd, args: args || {} }, '*');
    });
  }

  /** 确保 MAIN world 脚本已就绪；若页面在安装扩展前就已打开，则动态补注入 */
  async function ensureBridge() {
    let res = await bridge('ping', {}, 1500);
    if (res && res.ok) return true;

    // 方式一：在页面里插 <script src=chrome-extension://...>（可能被页面 CSP 拦）
    try {
      const url = chrome.runtime.getURL('src/inject.js');
      if (!document.querySelector('script[data-tmd-inject]')) {
        await new Promise((resolve) => {
          const s = document.createElement('script');
          s.src = url;
          s.dataset.tmdInject = '1';
          s.onload = resolve;
          s.onerror = resolve;
          (document.head || document.documentElement).appendChild(s);
        });
      }
      res = await bridge('ping', {}, 3000);
      if (res && res.ok) return true;
    } catch (err) {
      log('页面内注入主世界脚本失败，改用 scripting API', err);
    }

    // 方式二：请 background 用 chrome.scripting 注入（不受页面 CSP 限制）
    try {
      const reply = await sendToBackground({ type: 'TMD_INJECT_MAIN' });
      if (reply && reply.ok) {
        res = await bridge('ping', {}, 3000);
        if (res && res.ok) return true;
      } else {
        log('scripting API 注入失败', reply && reply.error);
      }
    } catch (err) {
      log('scripting API 注入异常', err);
    }
    return false;
  }

  // =============================================================== DOM 选择器

  const SEL = {
    scroll: [
      '#column-center .bubbles',
      '#column-center .chat-container .scrollable',
      '#column-center .scrollable-y',
      '#MiddleColumn .MessageList',
      '#MiddleColumn .messages-container',
      '.MessageList',
      '.bubbles',
    ],
    chatRoot: ['#column-center', '#MiddleColumn', '.chat-container', '#chat-container'],
    title: [
      '#column-center .topbar .peer-title',
      '#column-center .chat-info .peer-title',
      '#column-center .chat .top .peer-title',
      '#MiddleColumn .MiddleHeader .title',
      '#MiddleColumn .ChatInfo .title',
      '.ChatInfo .title',
      '.TopBar .peer-title',
    ],
    message: ['.bubble', '.Message', '[data-mid]', '[data-message-id]'],
    ignoreOwn: '[data-tmd-ui], #tmd-panel, #tmd-fab',
    avatar: '.avatar, .Avatar, .peer-avatar, .profile-photo, .AvatarBadge, .avatar-badge',
    sticker:
      '.emoji, .emoji-image, .custom-emoji, .sticker, .sticker-set, .animated-sticker, .media-sticker, .emoji-sticker, .Emoji, .Sticker',
    linkPreview:
      '.webpage, .web-page-preview, .WebPage, .webpage-preview, .preview-media, .WebPagePreview, .reply-media, .reply, .Reply',
    sidebar:
      '#column-left, #column-right, .chatlist, .chat-list, .dialogs, .folders, .sidebar, .LeftMainHeader, .search-super, .SearchInput',
  };

  function findScrollContainer() {
    for (const sel of SEL.scroll) {
      const el = document.querySelector(sel);
      if (el && el.scrollHeight > el.clientHeight + 20) return el;
    }
    // 兜底：在聊天列里找可滚动且最高的元素
    let best = null;
    for (const rootSel of SEL.chatRoot) {
      const root = document.querySelector(rootSel);
      if (!root) continue;
      root.querySelectorAll('div').forEach((el) => {
        const st = getComputedStyle(el);
        if (!/(auto|scroll)/.test(st.overflowY)) return;
        if (el.scrollHeight > el.clientHeight + 50 && (!best || el.scrollHeight > best.scrollHeight)) best = el;
      });
      if (best) break;
    }
    return best;
  }

  function getScanRoots() {
    const roots = [];
    for (const sel of SEL.chatRoot) {
      const el = document.querySelector(sel);
      if (el) roots.push(el);
    }
    if (!roots.length) roots.push(document.body);
    return roots;
  }

  function getChatTitle() {
    for (const sel of SEL.title) {
      const el = document.querySelector(sel);
      const t = el && el.textContent && el.textContent.trim();
      if (t) return t;
    }
    const dt = (document.title || '').replace(/^\(\d+\)\s*/, '').replace(/\s*[-–—]\s*Telegram.*$/i, '').trim();
    return dt || 'Telegram';
  }

  function closestMessage(el) {
    let node = el;
    let hops = 0;
    while (node && node.nodeType === 1 && hops++ < 15) {
      if (node.matches && node.matches(SEL.message.join(','))) return node;
      node = node.parentElement;
    }
    return null;
  }

  /**
   * 判断消息是自己发的（out）还是别人发的（in）。
   * K 版用 .bubble.is-in/.is-out，A 版用 .Message.own 之类；都没有时用气泡的水平位置兜底。
   */
  function messageDirection(root) {
    if (!root) return 'unknown';
    const cl = root.classList;
    if (cl && typeof cl.contains === 'function') {
      if (cl.contains('is-out') || cl.contains('own') || cl.contains('is-owned') || cl.contains('outgoing')) return 'out';
      if (cl.contains('is-in') || cl.contains('incoming') || cl.contains('is-incoming')) return 'in';
    }
    if (typeof root.getAttribute === 'function') {
      const v = root.getAttribute('data-is-out') || root.getAttribute('data-own');
      if (v === '1' || v === 'true') return 'out';
      if (v === '0' || v === 'false') return 'in';
    }
    // 位置兜底：自己发的气泡靠右
    try {
      const rect = typeof root.getBoundingClientRect === 'function' ? root.getBoundingClientRect() : null;
      if (rect && rect.width) {
        const box = (typeof root.closest === 'function' && root.closest('#column-center, #MiddleColumn')) || document.body;
        const host = box && typeof box.getBoundingClientRect === 'function' ? box.getBoundingClientRect() : null;
        if (host && host.width) {
          return rect.left + rect.width / 2 > host.left + host.width / 2 ? 'out' : 'in';
        }
      }
    } catch (_) {}
    return 'unknown';
  }

  function findMessageId(el) {
    const root = closestMessage(el);
    if (!root) return '';
    for (const attr of ['data-mid', 'data-message-id', 'data-id']) {
      const v = root.getAttribute && root.getAttribute(attr);
      if (v) return 'm' + v;
    }
    return '';
  }

  function parseTimeText(text) {
    if (!text) return 0;
    const t = String(text).trim();
    let m = t.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[ T](\d{1,2}):(\d{2})/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
    m = t.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})[ T](\d{1,2}):(\d{2})/);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]).getTime();
    m = t.match(/^(\d{1,2}):(\d{2})$/);
    if (m) {
      const d = new Date();
      d.setHours(+m[1], +m[2], 0, 0);
      return d.getTime();
    }
    return 0;
  }

  function findTimestamp(el) {
    let node = el;
    let hops = 0;
    while (node && node.nodeType === 1 && hops++ < 12) {
      const attr =
        node.getAttribute &&
        (node.getAttribute('data-timestamp') || node.getAttribute('data-date') || node.getAttribute('data-time'));
      if (attr && /^\d{9,13}$/.test(attr)) {
        const n = Number(attr);
        return n < 1e12 ? n * 1000 : n;
      }
      node = node.parentElement;
    }
    const root = closestMessage(el);
    if (root) {
      const time = root.querySelector('time[datetime]');
      if (time) {
        const v = Date.parse(time.getAttribute('datetime'));
        if (!isNaN(v)) return v;
      }
      const t2 = root.querySelector('.time, .message-time, .MessageMeta, .bubble-time');
      if (t2) {
        const v = parseTimeText(t2.textContent);
        if (v) return v;
      }
    }
    return 0;
  }

  // ==================================================================== 扫描

  const state = {
    items: [],
    byKey: new Map(),
    selected: new Set(),
    itemSeq: 0,
    nameSeq: 0,
    scanning: false,
    chatTitle: '',
    lastError: '',
    // Telegram 多选镜像：快照跨虚拟化累积，滚出屏幕的选中项也不丢
    tgSelected: new Map(),
    tgSelectedMsgs: new Set(),
    tgSelectionSig: '',
    tgSelectionMiss: 0,
  };

  function isIgnored(el) {
    if (el.closest(SEL.ignoreOwn)) return true;
    if (el.closest(SEL.avatar)) return true;
    if (!settings.includeStickers && el.closest(SEL.sticker)) return true;
    if (!settings.includeLinkPreview && el.closest(SEL.linkPreview)) return true;
    if (!settings.includeRightColumn && el.closest('#column-right')) return true;
    if (el.closest('.chatlist, .chat-list, .dialogs, .folders, .sidebar, .search-super, #column-left')) return true;
    return false;
  }

  function mediaSrc(el) {
    if (el.tagName === 'VIDEO') {
      const s = el.currentSrc || el.src;
      if (s) return s;
      const source = el.querySelector('source');
      if (source) return source.src || source.getAttribute('src') || '';
      return '';
    }
    return el.currentSrc || el.src || '';
  }

  function isAcceptableSrc(src) {
    if (!src) return false;
    if (src.startsWith('blob:')) return true;
    if (/^https?:/i.test(src)) return true;
    if (src.startsWith('data:')) return !!settings.includeDataUrls;
    return false;
  }

  function naturalSize(el) {
    const w = el.naturalWidth || el.videoWidth || el.clientWidth || 0;
    const h = el.naturalHeight || el.videoHeight || el.clientHeight || 0;
    return { w, h };
  }

  /** 扫描一次当前 DOM，返回新增数量 */
  function scanDom() {
    const title = getChatTitle();
    if (title && title !== state.chatTitle) state.chatTitle = title;

    let added = 0;
    const seenThisPass = new Set();

    for (const root of getScanRoots()) {
      // 1) <img> / <video>
      root.querySelectorAll('img, video').forEach((el) => {
        if (isIgnored(el)) return;
        const src = mediaSrc(el);
        if (!isAcceptableSrc(src)) return;

        const { w, h } = naturalSize(el);
        if (w && h && (w < settings.minPx || h < settings.minPx)) return;

        const kind = el.tagName === 'VIDEO' ? 'video' : 'photo';
        const msgRoot = closestMessage(el);
        const msgId = findMessageId(el);

        let mediaIndex = 0;
        if (msgRoot) {
          const all = Array.from(msgRoot.querySelectorAll('img, video'));
          mediaIndex = all.indexOf(el);
        }

        // 消息 id 只在单个聊天内唯一，因此把聊天名也编进 key
        const chatKey = state.chatTitle || '';
        const key = msgId ? `${chatKey}|${msgId}|${kind}|${mediaIndex}` : `src|${src}`;
        if (seenThisPass.has(key)) return;
        seenThisPass.add(key);

        if (
          addItem({
            key,
            kind,
            src,
            el,
            msgId,
            dir: messageDirection(msgRoot),
            w,
            h,
            date: findTimestamp(el),
            poster: el.poster || '',
          })
        )
          added++;
      });

      // 2) 内联背景图（部分版本的照片是 background-image）
      if (settings.includeBackground) {
        root.querySelectorAll('div[style*="background-image"], a[style*="background-image"]').forEach((el) => {
          if (isIgnored(el)) return;
          if (el.querySelector('img, video')) return;
          const style = el.getAttribute('style') || '';
          const m = style.match(/background-image\s*:\s*url\(["']?([^"')]+)["']?\)/i);
          if (!m) return;
          const src = m[1];
          if (!isAcceptableSrc(src)) return;
          const rect = el.getBoundingClientRect();
          if (rect.width && rect.height && (rect.width < settings.minPx || rect.height < settings.minPx)) return;
          const key = `bg|${src}`;
          if (seenThisPass.has(key)) return;
          seenThisPass.add(key);
          if (
            addItem({
              key,
              kind: 'photo',
              src,
              el,
              msgId: findMessageId(el),
              dir: messageDirection(closestMessage(el)),
              w: Math.round(rect.width),
              h: Math.round(rect.height),
              date: findTimestamp(el),
            })
          )
            added++;
        });
      }
    }

    if (added) {
      log('新增媒体', added, '共', state.items.length);
      renderList();
    }
    syncMessageButtons();
    syncSelectionButton();
    return added;
  }

  function addItem(item) {
    const existing = state.byKey.get(item.key);
    if (existing) {
      // 同一个消息位的元素被重新渲染时，更新 src / 元素引用（blob URL 会变）
      if (existing.src !== item.src || existing.el !== item.el) {
        existing.src = item.src;
        existing.el = item.el;
        existing.poster = item.poster || existing.poster;
        existing.dir = item.dir || existing.dir;
        existing.w = item.w || existing.w;
        existing.h = item.h || existing.h;
        if (existing.status === 'fail') {
          existing.status = 'idle';
          existing.error = '';
        }
        updateRow(existing);
      }
      return false;
    }
    const rec = {
      id: ++state.itemSeq,
      key: item.key,
      kind: item.kind,
      src: item.src,
      el: item.el,
      msgId: item.msgId,
      dir: item.dir || 'unknown',
      poster: item.poster || '',
      w: item.w || 0,
      h: item.h || 0,
      date: item.date || 0,
      size: 0,
      type: '',
      ext: '',
      filename: '',
      status: 'idle', // idle | queued | working | ok | fail
      note: '',
      error: '',
      apiId: null,
    };
    state.items.push(rec);
    state.byKey.set(rec.key, rec);
    return true;
  }

  function kindLabel(kind) {
    return kind === 'video' ? '视频' : '图片';
  }

  // ================================================================== 命名模板

  const MIME_EXT = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif',
    'image/bmp': 'bmp',
    'image/heic': 'heic',
    'image/svg+xml': 'svg',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/x-matroska': 'mkv',
    'video/quicktime': 'mov',
    'video/ogg': 'ogv',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/ogg': 'ogg',
    'application/pdf': 'pdf',
    'application/zip': 'zip',
  };

  function extFromType(type) {
    if (!type) return '';
    const clean = String(type).split(';')[0].trim().toLowerCase();
    return MIME_EXT[clean] || '';
  }

  function extFromSrc(src) {
    if (!src) return '';
    const clean = src.split('?')[0].split('#')[0];
    const m = clean.match(/\.([a-z0-9]{2,5})$/i);
    return m ? m[1].toLowerCase() : '';
  }

  function sanitizeSegment(s) {
    return String(s || '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f<>:"\\|?*/]/g, '_') // 含路径分隔符：变量内容不能改变目录层级
      .replace(/^\.+/, '_')
      .replace(/\.+$/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
  }

  function pad(n, len = 2) {
    return String(n).padStart(len, '0');
  }

  /** 纯变量替换 + 路径清洗（不追加扩展名） */
  function renderTokens(tpl, item, index) {
    const d = item.date ? new Date(item.date) : new Date();
    const map = {
      chat: sanitizeSegment(state.chatTitle || getChatTitle() || 'Telegram'),
      date: `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`,
      time: `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`,
      index: pad(index, 3),
      ext: item.ext || 'bin',
      type: item.kind === 'video' ? 'video' : 'photo',
      mid: (item.msgId || '').replace(/^m/, '') || pad(index, 3),
      name: sanitizeSegment(item.filename || ''),
    };
    const out = String(tpl == null || tpl === '' ? '' : tpl).replace(/\{(\w+)\}/g, (m, k) =>
      Object.prototype.hasOwnProperty.call(map, k) ? map[k] : m
    );
    return out
      .split(/[\\/]+/)
      .map((seg) => sanitizeSegment(seg))
      .filter(Boolean)
      .join('/');
  }

  function renderTemplate(tpl, item, index) {
    let out = renderTokens(tpl || '{date}_{index}.{ext}', item, index);
    if (!out) out = `media_${pad(index, 3)}`;
    if (!/\.[a-z0-9]{1,6}$/i.test(out)) out += '.' + (item.ext || 'bin');
    return out;
  }

  function resolveFilename(item, index) {
    const name = renderTemplate(settings.template, item, index);
    return name;
  }

  function resolveDir(item, index) {
    if (!settings.subfolder) return '';
    return renderTokens(settings.subfolder, item, index);
  }

  function flattenPath(p) {
    return String(p || '').replace(/[\\/]+/g, '_');
  }

  // ================================================================== 下载队列

  const queue = { pending: [], active: 0, total: 0, epoch: 0 };

  /** 进度全部由条目状态推导，避免增量计数在重试 / 回调里重复累加 */
  function queueStats() {
    let done = 0;
    let fail = 0;
    let running = 0;
    let waiting = 0;
    for (const it of state.items) {
      if (it.status === 'ok') done += 1;
      else if (it.status === 'fail') fail += 1;
      else if (it.status === 'working') running += 1;
      else if (it.status === 'queued') waiting += 1;
    }
    return { done, fail, running, waiting, remaining: running + waiting };
  }

  function updateProgress() {
    if (!ui.progressWrap) return;
    const { done, fail, remaining } = queueStats();
    const show = remaining > 0 || done + fail > 0;
    ui.progressWrap.hidden = !show;
    const total = Math.max(queue.total, done + fail + remaining);
    const pct = total ? Math.round(((done + fail) / total) * 100) : 0;
    ui.progressI.style.width = pct + '%';
    ui.progressI.className = fail ? 'has-fail' : '';
    ui.progressText.textContent = `完成 ${done} · 失败 ${fail} · 队列 ${remaining}${total ? ` / ${total}` : ''}`;
    updateHeaderStats();
  }

  function resetQueueCounters() {
    queue.epoch += 1; // 作废在途任务：它们回来后不再触发下载、不再改 UI
    queue.total = 0;
    queue.pending.length = 0;
    state.items.forEach((it) => {
      if (it.status === 'queued') {
        it.status = 'idle';
        it.note = '';
      }
    });
    updateProgress();
  }

  function enqueue(items) {
    const list = items.filter((it) => it && it.status !== 'queued' && it.status !== 'working');
    if (!list.length) {
      toast('没有可下载的项目');
      return;
    }
    list.forEach((it) => {
      it.status = 'queued';
      it.error = '';
      it.note = '排队中';
      updateRow(it);
    });
    queue.pending.push(...list);
    queue.total += list.length;
    updateProgress();
    pump();
  }

  function pump() {
    while (queue.active < Math.max(1, settings.concurrency) && queue.pending.length) {
      const item = queue.pending.shift();
      const epoch = queue.epoch;
      queue.active += 1;
      downloadItem(item, epoch)
        .catch((err) => {
          if (epoch === queue.epoch) setStatus(item, 'fail', String((err && err.message) || err));
        })
        .finally(() => {
          queue.active -= 1;
          if (epoch === queue.epoch) {
            updateProgress();
            pump();
          }
        });
    }
    updateProgress();
  }

  async function sendToBackground(msg) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  /** 大文件 / data 通道失败时的统一出口：在主世界用 <a download> 触发 */
  async function downloadViaAnchor(res, item) {
    const r = await bridge('download', { url: res.blobUrl, filename: flattenPath(item.filename || '') }, 60000);
    if (r && r.ok) {
      const tag = res.recordedFallback ? '已录制并下载（webm）' : '已触发下载';
      setStatus(item, 'ok', res.truncated ? tag + '（已截断）' : tag);
      // 不主动 revoke：浏览器可能还在读这个 blob，交给 inject.js 的 TTL 回收
    } else {
      setStatus(item, 'fail', (r && r.error) || '触发下载失败');
      bridge('revoke', { url: res.blobUrl }, 8000);
    }
  }

  /** 让主世界把同一个媒体重新取成 blob URL（用于 data 通道不可用时） */
  async function reprepareAsBlob(item, isVideo) {
    return bridge(
      'prepare',
      { url: item.src, isVideo, forceBlob: true, maxDataBytes: 0, allowRecord: false },
      10 * 60 * 1000
    );
  }

  /** 轮询 chrome.downloads 的真实状态（service worker 休眠也不会丢事件） */
  async function pollDownloadState(item, downloadId) {
    const deadline = Date.now() + 30 * 60 * 1000;
    while (item.pendingApi && Date.now() < deadline) {
      await sleep(3000);
      if (!item.pendingApi) return;
      const r = await sendToBackground({ type: 'TMD_CHECK_DL', downloadId });
      if (!r || !r.ok) return;
      if (r.state === 'complete') {
        item.pendingApi = false;
        setStatus(item, 'ok', '已完成');
        return;
      }
      if (r.state === 'interrupted') {
        item.pendingApi = false;
        setStatus(item, 'fail', '下载中断：' + (r.error || '未知原因'));
        return;
      }
      if (!r.state) {
        item.pendingApi = false;
        setStatus(item, 'ok', '已交给浏览器下载（状态见下载列表）');
        return;
      }
    }
    item.pendingApi = false;
  }

  async function downloadItem(item, epoch) {
    setStatus(item, 'working', item.kind === 'video' ? '读取视频…' : '读取图片…');

    const isVideo = item.kind === 'video';
    const maxDataBytes = Math.max(0, Number(settings.maxDataMB) || 0) * 1024 * 1024;
    const forceBlob = maxDataBytes === 0;

    const recordMs = Math.max(1, Number(settings.maxRecordMinutes) || 10) * 60 * 1000;
    const timeout = (settings.recordFallback && isVideo ? recordMs + 120000 : 0) || 10 * 60 * 1000;

    const res = await bridge(
      'prepare',
      {
        url: item.src,
        isVideo,
        maxDataBytes,
        forceBlob,
        allowRecord: !!settings.recordFallback && isVideo,
        maxRecordSeconds: Math.round(recordMs / 1000),
      },
      timeout
    );

    if (epoch !== queue.epoch) return; // 列表已被清空，放弃这次任务
    if (!res || !res.ok) {
      setStatus(item, 'fail', (res && res.error) || '读取失败');
      return;
    }

    item.size = res.size || 0;
    item.type = res.type || '';
    item.ext = extFromType(res.type) || extFromSrc(item.src) || (isVideo ? 'mp4' : 'jpg');

    const index = ++state.nameSeq;
    const name = resolveFilename(item, index);
    const dir = resolveDir(item, index);
    const fullPath = dir ? `${dir}/${name}` : name;
    item.filename = fullPath;
    updateRow(item);

    if (res.mode === 'data') {
      // 理论上主世界已经限流；这里是第二道保险：data URL 太长一律改走 blob 通道
      if (String(res.dataUrl).length > MAX_DATA_URL_CHARS) {
        log('data URL 过长，改走页面 blob 通道');
        const blobRes = await reprepareAsBlob(item, isVideo);
        if (epoch !== queue.epoch) return;
        if (blobRes && blobRes.ok && blobRes.blobUrl) {
          await downloadViaAnchor(blobRes, item);
        } else {
          setStatus(item, 'fail', (blobRes && blobRes.error) || '内容超出下载通道上限');
        }
        return;
      }
      const reply = await sendToBackground({
        type: 'TMD_DL_DATA',
        dataUrl: res.dataUrl,
        filename: fullPath,
        itemKey: item.key,
        itemId: item.id,
      });
      if (epoch !== queue.epoch) return;
      if (reply && reply.ok) {
        item.apiId = reply.downloadId;
        item.pendingApi = true;
        setStatus(item, 'ok', '下载中（downloads API）');
        pollDownloadState(item, reply.downloadId);
      } else {
        // downloads API 失败 -> 改走页面 blob 通道（比点击超大 data URL 可靠，代价是没有子目录）
        log('downloads API 失败，回退到页面 blob 通道:', reply && reply.error);
        const blobRes = await reprepareAsBlob(item, isVideo);
        if (epoch !== queue.epoch) return;
        if (blobRes && blobRes.ok && blobRes.blobUrl) {
          await downloadViaAnchor(blobRes, item);
        } else {
          setStatus(item, 'fail', (reply && reply.error) || (blobRes && blobRes.error) || '下载失败');
        }
      }
      return;
    }

    if (res.mode === 'remote') {
      // 页面内 fetch 被 CORS 拦（src 是 CDN 直链）：交给浏览器下载器，能带 Cookie 也能带子目录
      const reply = await sendToBackground({
        type: 'TMD_DL_URL',
        url: res.remoteUrl || item.src,
        filename: fullPath,
        itemKey: item.key,
        itemId: item.id,
      });
      if (epoch !== queue.epoch) return;
      if (reply && reply.ok) {
        item.apiId = reply.downloadId;
        item.pendingApi = true;
        setStatus(item, 'ok', res.recordedFallback ? '已录制并下载' : '下载中（CDN 直链）');
        pollDownloadState(item, reply.downloadId);
      } else {
        setStatus(item, 'fail', (reply && reply.error) || 'CDN 直链下载失败');
      }
      return;
    }

    if (res.mode === 'blob') {
      if (epoch !== queue.epoch) return;
      await downloadViaAnchor(res, item);
      return;
    }

    setStatus(item, 'fail', '主世界返回了未知结果');
  }

  function setStatus(item, status, note) {
    item.status = status;
    if (note !== undefined) item.note = note;
    if (status === 'fail') item.error = note || '失败';
    if (status === 'fail') item.pendingApi = false;
    updateRow(item);
    updateProgress();
  }

  function handleDownloadEvent(msg) {
    const item = state.items.find((it) => it.key === msg.itemKey || it.id === msg.itemId);
    if (!item) return;
    if (msg.state === 'complete') {
      item.pendingApi = false;
      setStatus(item, 'ok', '已完成');
    } else if (msg.state === 'failed') {
      setStatus(item, 'fail', '下载中断：' + (msg.error || '未知原因'));
    }
  }

  // ================================================================== 自动滚动

  async function autoScrollLoad() {
    if (state.scanning) return;
    const container = findScrollContainer();
    if (!container) {
      toast('找不到聊天滚动容器，请先打开一个聊天');
      return;
    }
    state.scanning = true;
    resetQueueCounters();
    setStopVisible(true);
    renderList();

    // 先到底部，确保最新消息也在候选里
    container.scrollTop = container.scrollHeight;
    await sleep(settings.scrollDelayMs);
    scanDom();

    let lastHeight = -1;
    let stable = 0;
    let round = 0;

    try {
      while (state.scanning && round < settings.maxScrollRounds) {
        round += 1;
        container.scrollTop = 0;
        await sleep(settings.scrollDelayMs);
        const added = scanDom();
        ui.progressWrap.hidden = false;
        ui.progressI.style.width = '100%';
        ui.progressText.textContent = `已加载 ${round} 屏 · 当前共 ${state.items.length} 项（新增 ${added}）`;

        if (container.scrollHeight === lastHeight && added === 0) {
          stable += 1;
          if (stable >= 3) break; // 连续三屏没有任何新内容 -> 到头了
        } else {
          stable = 0;
        }
        lastHeight = container.scrollHeight;
        // 让出主线程，保持页面可交互
        await sleep(60);
      }
    } finally {
      state.scanning = false;
      setStopVisible(false);
      renderList();
      updateProgress();
      ui.progressText.textContent = `加载结束 · 共 ${state.items.length} 项`;
      toast(`扫描完成，共发现 ${state.items.length} 个媒体`);
    }
  }

  function stopScan() {
    state.scanning = false;
  }

  // ======================================================================== UI

  const ui = {};

  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'html') el.innerHTML = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (v === true) el.setAttribute(k, '');
        else if (v !== false) el.setAttribute(k, v);
      }
    }
    (Array.isArray(children) ? children : children ? [children] : []).forEach((c) => {
      if (c === null || c === undefined) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }

  function buildUI() {
    if (document.getElementById(PANEL_ID)) return;

    const svg = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M12 3a1 1 0 0 1 1 1v8.6l2.3-2.3a1 1 0 1 1 1.4 1.4l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.4L11 12.6V4a1 1 0 0 1 1-1Zm-7 15a1 1 0 0 1 1 1v1h12v-1a1 1 0 1 1 2 0v1.5A1.5 1.5 0 0 1 18.5 22h-13A1.5 1.5 0 0 1 4 20.5V19a1 1 0 0 1 1-1Z"/></svg>';

    // 悬浮球
    const fab = h('button', { id: FAB_ID, 'data-tmd-ui': '1', title: '打开 Telegram 媒体下载器', html: svg, onclick: () => togglePanel(true) });

    // 面板
    const panel = h('div', { id: PANEL_ID, 'data-tmd-ui': '1', class: settings.panelVisible ? '' : 'tmd-hidden' });

    const head = h('header', { class: 'tmd-head', id: 'tmd-drag' }, [
      h('span', { class: 'tmd-dot' }),
      h('b', { text: 'TG 媒体下载器' }),
      h('span', { class: 'tmd-head-stats', id: 'tmd-head-stats', text: '0' }),
      h('button', { class: 'tmd-icon-btn', title: '收起', text: '–', onclick: () => togglePanel(false) }),
      h('button', { class: 'tmd-icon-btn', title: '清空并隐藏', text: '×', onclick: () => togglePanel(false) }),
    ]);

    const rowActions = h('div', { class: 'tmd-row tmd-actions' }, [
      h('button', { class: 'tmd-btn primary', id: 'tmd-scan', text: '扫描当前视图', onclick: () => onScan() }),
      h('button', { class: 'tmd-btn', id: 'tmd-autoscroll', text: '自动加载全部', onclick: () => autoScrollLoad() }),
      h('button', {
        class: 'tmd-btn',
        text: '下载选中的',
        title: '下载你在 Telegram 里多选的那些消息中的图片',
        onclick: () => downloadTelegramSelection(),
      }),
      h('button', { class: 'tmd-btn danger', id: 'tmd-stop', text: '停止', hidden: true, onclick: () => stopScan() }),
    ]);

    const progress = h('div', { class: 'tmd-progress', id: 'tmd-progress-wrap', hidden: true }, [
      h('div', { class: 'tmd-progress-bar' }, [h('i', { id: 'tmd-progress-i' })]),
      h('div', { class: 'tmd-progress-text', id: 'tmd-progress-text', text: '' }),
    ]);

    const filters = h('div', { class: 'tmd-row tmd-filters' }, [
      h('label', {}, [h('input', { type: 'checkbox', id: 'tmd-f-photo', checked: true }), h('span', { text: '图片' })]),
      h('label', {}, [h('input', { type: 'checkbox', id: 'tmd-f-video', checked: true }), h('span', { text: '视频' })]),
      h('label', {}, [h('input', { type: 'checkbox', id: 'tmd-f-sel' }), h('span', { text: '只看已选' })]),
      h('label', { title: '只看对方 / 群成员发来的消息里的媒体' }, [
        h('input', { type: 'checkbox', id: 'tmd-f-incoming' }),
        h('span', { text: '只看别人发的' }),
      ]),
      h('label', { title: '是否把表情 / 贴纸也算作媒体' }, [
        h('input', { type: 'checkbox', id: 'tmd-f-sticker' }),
        h('span', { text: '含贴纸' }),
      ]),
      h('label', { class: 'tmd-inline-num', title: '小于该像素的图片会被忽略' }, [
        h('input', { type: 'number', id: 'tmd-f-minpx', class: 'tmd-num', min: '0', step: '16', value: String(settings.minPx) }),
        h('span', { text: 'px+' }),
      ]),
    ]);

    const listTools = h('div', { class: 'tmd-row tmd-list-tools' }, [
      h('button', { class: 'tmd-mini', text: '全选', onclick: () => selectAll(true) }),
      h('button', { class: 'tmd-mini', text: '反选', onclick: () => invertSelection() }),
      h('button', { class: 'tmd-mini', text: '取消选择', onclick: () => selectAll(false) }),
      h('button', { class: 'tmd-mini', text: '清空列表', onclick: () => clearItems() }),
      h('span', { class: 'tmd-count', id: 'tmd-count', text: '0 项' }),
      h('span', { class: 'tmd-count-sel', id: 'tmd-count-sel', text: '未选择' }),
    ]);

    const list = h('div', { class: 'tmd-list', id: 'tmd-list' });

    const settingsWrap = h('details', { class: 'tmd-settings', id: 'tmd-settings' }, [
      h('summary', { text: '下载设置' }),
      h('div', { class: 'tmd-settings-body' }, [
        field('文件名模板', 'tmd-s-template', 'text', settings.template, '可用变量：{chat} {date} {time} {index} {ext} {type} {mid}'),
        field('子目录（仅 downloads 通道生效）', 'tmd-s-subfolder', 'text', settings.subfolder, '例如 Telegram/{chat}；大文件由浏览器直接下载，不带目录'),
        field('并发数', 'tmd-s-concurrency', 'number', settings.concurrency, '建议 1–3，过大容易触发浏览器限流'),
        field('走 downloads 的体积上限 (MB)', 'tmd-s-maxdata', 'number', settings.maxDataMB, '受浏览器 URL 长度限制，实际最多 1.25MB；超过的自动改用页面直接下载（无子目录）。填 0 = 全部走页面下载'),
        field('录制兜底最长时长 (分钟)', 'tmd-s-maxrecord', 'number', settings.maxRecordMinutes, 'MSE 流式视频只能实时录制，1 分钟视频≈1 分钟耗时'),
        field('滚动等待 (毫秒)', 'tmd-s-delay', 'number', settings.scrollDelayMs, '网络慢时可调大'),
        h('label', { class: 'tmd-check' }, [
          h('input', { type: 'checkbox', id: 'tmd-s-record', checked: settings.recordFallback }),
          h('span', { text: '视频录制兜底（MSE 视频无法直接读取时，用 MediaRecorder 实时录制为 webm）' }),
        ]),
        h('label', { class: 'tmd-check' }, [
          h('input', { type: 'checkbox', id: 'tmd-s-bg', checked: settings.includeBackground }),
          h('span', { text: '识别 CSS 背景图形式的照片' }),
        ]),
        h('label', { class: 'tmd-check' }, [
          h('input', { type: 'checkbox', id: 'tmd-s-preview', checked: settings.includeLinkPreview }),
          h('span', { text: '包含链接预览图 / 回复缩略图' }),
        ]),
        h('label', { class: 'tmd-check' }, [
          h('input', { type: 'checkbox', id: 'tmd-s-msgbtn', checked: settings.msgButton }),
          h('span', { text: '在每条含图片的消息旁显示下载按钮（只下这一条）' }),
        ]),
        h('label', { class: 'tmd-check' }, [
          h('input', { type: 'checkbox', id: 'tmd-s-msgvideo', checked: settings.msgButtonIncludeVideos }),
          h('span', { text: '把视频也算作可下载内容（消息按钮 + 选中下载都会带上视频）' }),
        ]),
        h('label', { class: 'tmd-check' }, [
          h('input', { type: 'checkbox', id: 'tmd-s-selbtn', checked: settings.selectedButton }),
          h('span', { text: '检测到 Telegram 多选时，显示「下载选中的图片」悬浮按钮' }),
        ]),
        h('label', { class: 'tmd-check' }, [
          h('input', { type: 'checkbox', id: 'tmd-s-recording-hint', checked: true, disabled: true }),
          h('span', { text: '提示：Telegram 的 blob 地址在页面刷新后会失效，请扫描后尽快下载' }),
        ]),
      ]),
    ]);
    if (settings.settingsOpen) settingsWrap.setAttribute('open', '');

    const foot = h('div', { class: 'tmd-row tmd-foot' }, [
      h('button', { class: 'tmd-btn primary', id: 'tmd-dl-sel', text: '下载选中', onclick: () => downloadSelected() }),
      h('button', { class: 'tmd-btn', text: '下载全部', onclick: () => downloadAll() }),
      h('button', { class: 'tmd-btn', text: '重试失败', onclick: () => retryFailed() }),
    ]);

    const hint = h('div', { class: 'tmd-hint', id: 'tmd-hint' });

    panel.append(head, h('div', { class: 'tmd-body' }, [rowActions, progress, filters, listTools, list, settingsWrap, foot, hint]));
    document.body.append(fab, panel);

    Object.assign(ui, {
      fab,
      panel,
      head,
      headStats: panel.querySelector('#tmd-head-stats'),
      scanBtn: panel.querySelector('#tmd-scan'),
      autoBtn: panel.querySelector('#tmd-autoscroll'),
      stopBtn: panel.querySelector('#tmd-stop'),
      progressWrap: progress,
      progressI: progress.querySelector('#tmd-progress-i'),
      progressText: progress.querySelector('#tmd-progress-text'),
      fPhoto: panel.querySelector('#tmd-f-photo'),
      fVideo: panel.querySelector('#tmd-f-video'),
      fSel: panel.querySelector('#tmd-f-sel'),
      fIncoming: panel.querySelector('#tmd-f-incoming'),
      fSticker: panel.querySelector('#tmd-f-sticker'),
      fMinPx: panel.querySelector('#tmd-f-minpx'),
      count: panel.querySelector('#tmd-count'),
      countSel: panel.querySelector('#tmd-count-sel'),
      dlSelBtn: panel.querySelector('#tmd-dl-sel'),
      list,
      settingsWrap,
      hint,
      rows: new Map(),
      toastTimer: 0,
    });

    bindEvents();
    restorePanelPos();
    makeDraggable();
    renderList();
    updateHeaderStats();
  }

  function field(label, id, type, value, hint) {
    return h('label', { class: 'tmd-field', title: hint || '' }, [
      h('span', { class: 'tmd-field-label', text: label }),
      h('input', { type, id, value: String(value) }),
      hint ? h('em', { class: 'tmd-field-hint', text: hint }) : null,
    ]);
  }

  function bindEvents() {
    ui.fPhoto.addEventListener('change', renderList);
    ui.fVideo.addEventListener('change', renderList);
    ui.fSel.addEventListener('change', renderList);
    ui.fIncoming.addEventListener('change', renderList);
    ui.fSticker.addEventListener('change', async () => {
      settings.includeStickers = ui.fSticker.checked;
      saveSettings();
      scanDom();
    });
    ui.fMinPx.addEventListener('change', () => {
      settings.minPx = Math.max(0, Number(ui.fMinPx.value) || 0);
      saveSettings();
      // 已扫描项目按新阈值过滤显示
      renderList();
    });

    ui.settingsWrap.addEventListener('toggle', () => {
      settings.settingsOpen = ui.settingsWrap.open;
      saveSettings();
    });

    const bindText = (id, key, mapper) => {
      const el = ui.panel.querySelector('#' + id);
      el.addEventListener('change', () => {
        settings[key] = mapper ? mapper(el.value) : el.value;
        saveSettings();
        renderList();
      });
    };
    bindText('tmd-s-template', 'template');
    bindText('tmd-s-subfolder', 'subfolder');
    bindText('tmd-s-concurrency', 'concurrency', (v) => Math.min(8, Math.max(1, Number(v) || 1)));
    bindText('tmd-s-maxdata', 'maxDataMB', (v) => Math.min(1.25, Math.max(0, Number(v) || 0)));
    bindText('tmd-s-maxrecord', 'maxRecordMinutes', (v) => Math.min(180, Math.max(1, Number(v) || 10)));
    bindText('tmd-s-delay', 'scrollDelayMs', (v) => Math.min(10000, Math.max(200, Number(v) || 1100)));

    const bindCheck = (id, key, onchange) => {
      const el = ui.panel.querySelector('#' + id);
      el.addEventListener('change', () => {
        settings[key] = el.checked;
        saveSettings();
        if (onchange) onchange();
      });
    };
    bindCheck('tmd-s-record', 'recordFallback');
    bindCheck('tmd-s-bg', 'includeBackground', () => scanDom());
    bindCheck('tmd-s-preview', 'includeLinkPreview', () => scanDom());
    bindCheck('tmd-s-msgbtn', 'msgButton', () => syncMessageButtons());
    bindCheck('tmd-s-msgvideo', 'msgButtonIncludeVideos', () => {
      syncMessageButtons();
      syncSelectionButton();
    });
    bindCheck('tmd-s-selbtn', 'selectedButton', () => syncSelectionButton());

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !ui.panel.classList.contains('tmd-hidden')) togglePanel(false);
    });
  }

  function togglePanel(show) {
    const visible = show === undefined ? ui.panel.classList.contains('tmd-hidden') : show;
    ui.panel.classList.toggle('tmd-hidden', !visible);
    settings.panelVisible = visible;
    saveSettings();
    if (visible) scanDom();
  }

  function restorePanelPos() {
    const pos = settings.panelPos;
    if (!pos || typeof pos.left !== 'number' || typeof pos.top !== 'number') return;
    const maxLeft = Math.max(8, window.innerWidth - 340);
    const maxTop = Math.max(8, window.innerHeight - 200);
    ui.panel.style.left = Math.min(Math.max(8, pos.left), maxLeft) + 'px';
    ui.panel.style.top = Math.min(Math.max(8, pos.top), maxTop) + 'px';
    ui.panel.style.right = 'auto';
    ui.panel.style.bottom = 'auto';
  }

  function makeDraggable() {
    let dragging = false;
    let sx = 0;
    let sy = 0;
    let ox = 0;
    let oy = 0;

    ui.head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const rect = ui.panel.getBoundingClientRect();
      dragging = true;
      sx = e.clientX;
      sy = e.clientY;
      ox = rect.left;
      oy = rect.top;
      ui.head.setPointerCapture(e.pointerId);
      ui.panel.style.right = 'auto';
      ui.panel.style.bottom = 'auto';
      ui.panel.style.left = ox + 'px';
      ui.panel.style.top = oy + 'px';
    });
    ui.head.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const left = Math.min(Math.max(0, ox + e.clientX - sx), window.innerWidth - 80);
      const top = Math.min(Math.max(0, oy + e.clientY - sy), window.innerHeight - 40);
      ui.panel.style.left = left + 'px';
      ui.panel.style.top = top + 'px';
    });
    ui.head.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = false;
      try {
        ui.head.releasePointerCapture(e.pointerId);
      } catch (_) {}
      const rect = ui.panel.getBoundingClientRect();
      settings.panelPos = { left: Math.round(rect.left), top: Math.round(rect.top) };
      saveSettings();
    });
  }

  function setStopVisible(v) {
    ui.stopBtn.hidden = !v;
    ui.autoBtn.disabled = v;
    ui.scanBtn.disabled = v;
  }

  function onScan() {
    const added = scanDom();
    renderList();
    toast(added ? `发现 ${added} 个新媒体，共 ${state.items.length} 项` : `没有新内容，仍是 ${state.items.length} 项`);
  }

  function selectAll(v) {
    state.selected.clear();
    if (v) visibleItems().forEach((it) => state.selected.add(it.key));
    renderList();
    updateSelectionUI();
  }

  function invertSelection() {
    visibleItems().forEach((it) => {
      if (state.selected.has(it.key)) state.selected.delete(it.key);
      else state.selected.add(it.key);
    });
    renderList();
    updateSelectionUI();
  }

  function clearItems() {
    state.items = [];
    state.byKey.clear();
    state.selected.clear();
    removeMessageButtons();
    clearSelectionSnapshot();
    resetQueueCounters();
    renderList();
  }

  function visibleItems() {
    const wantPhoto = ui.fPhoto.checked;
    const wantVideo = ui.fVideo.checked;
    const onlySelected = ui.fSel.checked;
    const minPx = Math.max(0, Number(settings.minPx) || 0);
    return state.items.filter((it) => {
      if (it.kind === 'photo' && !wantPhoto) return false;
      if (it.kind === 'video' && !wantVideo) return false;
      if (onlySelected && !state.selected.has(it.key)) return false;
      if (ui.fIncoming && ui.fIncoming.checked && it.dir === 'out') return false;
      if (minPx && it.w && it.h && (it.w < minPx || it.h < minPx)) return false;
      return true;
    });
  }

  function fmtSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function srcTail(src) {
    if (!src) return '';
    if (src.startsWith('blob:')) return 'blob';
    if (src.startsWith('data:')) return 'data';
    try {
      const u = new URL(src);
      const seg = u.pathname.split('/').filter(Boolean).pop() || u.hostname;
      return seg.slice(0, 48);
    } catch (_) {
      return src.slice(0, 48);
    }
  }

  const STATUS_TEXT = {
    idle: '待下载',
    queued: '排队中',
    working: '处理中',
    ok: '完成',
    fail: '失败',
  };

  function renderList() {
    if (!ui.list) return;
    const items = visibleItems();
    const limit = 800;
    const shown = items.slice(0, limit);

    ui.rows = new Map();
    const frag = document.createDocumentFragment();

    if (!items.length) {
      frag.appendChild(
        h('div', { class: 'tmd-empty', text: '还没有扫描到媒体。先打开一个有图片/视频的聊天，然后点「扫描当前视图」或「自动加载全部」。' })
      );
    } else {
      shown.forEach((it, i) => frag.appendChild(buildRow(it, i)));
    }
    ui.list.replaceChildren(frag);

    if (items.length > limit) {
      ui.list.appendChild(h('div', { class: 'tmd-empty', text: `还有 ${items.length - limit} 项未渲染（下载与处理不受影响）` }));
    }

    updateSelectionUI();
    updateHeaderStats();
  }

  function buildRow(item, idx) {
    const checkbox = h('input', {
      type: 'checkbox',
      checked: state.selected.has(item.key),
      onchange: (e) => {
        if (e.target.checked) state.selected.add(item.key);
        else state.selected.delete(item.key);
        updateRow(item); // 立刻刷新这一行的「已选择」样式
        updateSelectionUI();
      },
    });

    let thumb;
    if (item.kind === 'photo' && !item.src.startsWith('data:')) {
      thumb = h('img', { src: item.src, loading: 'lazy', onerror: function () { this.style.visibility = 'hidden'; } });
    } else if (item.kind === 'video' && item.poster) {
      thumb = h('img', { src: item.poster, loading: 'lazy', onerror: function () { this.style.visibility = 'hidden'; } });
    } else {
      thumb = h('span', { class: 'tmd-thumb-icon', text: item.kind === 'video' ? '▶' : '▣' });
    }

    const title = h('div', { class: 'tmd-name', text: item.filename || `#${idx + 1} ${kindLabel(item.kind)}` });
    const sub = h('div', { class: 'tmd-sub' });
    const badge = h('span', { class: 'tmd-badge' });
    const selChip = h('span', { class: 'tmd-sel-chip', text: SEL_CHIP_TEXT });
    const one = h('button', { class: 'tmd-mini', text: '↓', title: '只下载这一项', onclick: (e) => { e.stopPropagation(); enqueue([item]); } });

    const row = h('div', { class: 'tmd-item', 'data-key': item.key, onclick: (e) => { if (e.target.closest('button')) return; checkbox.checked = !checkbox.checked; checkbox.dispatchEvent(new Event('change')); } }, [
      h('label', { class: 'tmd-check-wrap', onclick: (e) => e.stopPropagation() }, [checkbox]),
      h('div', { class: 'tmd-thumb' }, [thumb]),
      h('div', { class: 'tmd-meta' }, [title, sub]),
      selChip,
      badge,
      one,
    ]);

    const refs = { row, checkbox, title, sub, badge, selChip, idx };
    ui.rows.set(item.key, refs);
    paintRow(refs, item);
    return row;
  }

  function paintRow(refs, item) {
    const selected = state.selected.has(item.key);
    refs.row.className = 'tmd-item tmd-st-' + item.status + (selected ? ' tmd-selected' : '');
    if (!item.filename) refs.title.textContent = `#${(refs.idx ?? 0) + 1} ${kindLabel(item.kind)} · ${srcTail(item.src)}`;
    else refs.title.textContent = item.filename;
    const bits = [kindLabel(item.kind)];
    if (item.ext) bits.push(item.ext.toUpperCase());
    if (item.size) bits.push(fmtSize(item.size));
    if (item.note) bits.push(item.note);
    else bits.push(STATUS_TEXT[item.status] || item.status);
    refs.sub.textContent = bits.join(' · ');
    refs.badge.textContent = item.status === 'ok' ? '✓' : item.status === 'fail' ? '!' : item.kind === 'video' ? 'VID' : 'IMG';
    refs.badge.className = 'tmd-badge tmd-b-' + item.status;
    refs.checkbox.checked = selected;
    if (refs.selChip) refs.selChip.textContent = selected ? SEL_CHIP_TEXT : '';
  }

  function updateRow(item) {
    if (!ui.rows) return;
    const refs = ui.rows.get(item.key);
    if (!refs) return;
    paintRow(refs, item);
  }

  const SEL_CHIP_TEXT = '已选择';

  /** 纯函数：列表里的选择提示文案（计数 / 已选择字样 / 底部按钮） */
  function selectionSummary(selectedCount, visibleCount, totalCount) {
    const n = Math.max(0, Number(selectedCount) || 0);
    return {
      count: `${Math.max(0, Number(visibleCount) || 0)} / ${Math.max(0, Number(totalCount) || 0)} 项`,
      chip: n ? `${SEL_CHIP_TEXT} ${n} 项` : '未选择',
      button: n ? `下载选中 (${n})` : '下载选中',
      row: n ? SEL_CHIP_TEXT : '',
    };
  }

  /** 列表里的「已选择 N 项」提示 + 底部按钮上的数量 */
  function updateSelectionUI() {
    const selected = state.selected.size;
    const text = selectionSummary(selected, visibleItems().length, state.items.length);
    if (ui.count) ui.count.textContent = text.count;
    if (ui.countSel) {
      ui.countSel.textContent = text.chip;
      ui.countSel.classList.toggle('tmd-count-sel-on', selected > 0);
    }
    if (ui.dlSelBtn) ui.dlSelBtn.textContent = text.button;
  }

  function updateHeaderStats() {
    if (!ui.headStats) return;
    const done = state.items.filter((it) => it.status === 'ok').length;
    const fail = state.items.filter((it) => it.status === 'fail').length;
    ui.headStats.textContent = `${state.items.length} 项${done ? ` · ✓${done}` : ''}${fail ? ` · !${fail}` : ''}`;
  }

  function toast(text) {
    if (!ui.hint) return;
    ui.hint.textContent = text;
    ui.hint.classList.add('show');
    clearTimeout(ui.toastTimer);
    ui.toastTimer = setTimeout(() => ui.hint.classList.remove('show'), 4200);
  }

  function downloadSelected() {
    const items = state.items.filter((it) => state.selected.has(it.key));
    if (!items.length) {
      toast('还没有勾选任何项目');
      return;
    }
    enqueue(items);
  }

  function downloadAll() {
    const items = visibleItems();
    if (!items.length) {
      toast('列表为空，先扫描');
      return;
    }
    enqueue(items);
  }

  function retryFailed() {
    const items = state.items.filter((it) => it.status === 'fail');
    if (!items.length) {
      toast('没有失败的项目');
      return;
    }
    enqueue(items);
  }

  // ============================================================ 生命周期 / 事件



  // ================================================ 每条消息角上的单独下载按钮

  const MSG_BTN_GAP = 44; // 气泡外侧至少要有这么宽，才把按钮贴到外面

  /** 消息气泡 -> 该消息内媒体条目的 key 集合（挂按钮时写好，点击时只认这份快照） */
  const msgButtonTargets = new WeakMap();

  /**
   * 纯函数：从全部条目里挑出「某一条消息」该下载的图片。
   * keys 是挂按钮时快照的 key 集合，所以绝不可能把别的消息/别的页面的图带进来。
   */
  function selectMessageTargets(items, keys, opts) {
    if (!keys || !keys.size) return [];
    const includeVideos = !!(opts && opts.includeVideos);
    return (items || []).filter((it) => {
      if (!it || !it.key || !keys.has(it.key)) return false;
      if (!it.src) return false;
      if (it.kind !== 'photo' && !(includeVideos && it.kind === 'video')) return false;
      if (it.status === 'queued' || it.status === 'working') return false;
      return true;
    });
  }
  const MSG_BTN_ICON =
    '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M12 3a1 1 0 0 1 1 1v8.6l2.3-2.3a1 1 0 1 1 1.4 1.4l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.4L11 12.6V4a1 1 0 0 1 1-1Zm-7 15a1 1 0 0 1 1 1v1h12v-1a1 1 0 1 1 2 0v1.5A1.5 1.5 0 0 1 18.5 22h-13A1.5 1.5 0 0 1 4 20.5V19a1 1 0 0 1 1-1Z"/></svg>';

  /** 找到这条消息「看得见的气泡」本体：K 版是 .bubble，A 版是 .message-content */
  function messageBubbleHost(root) {
    if (!root) return null;
    const cl = root.classList;
    if (cl && typeof cl.contains === 'function' && (cl.contains('bubble') || cl.contains('message-content'))) return root;
    try {
      const inner = root.querySelector('.message-content, .bubble-content, .content-inner');
      if (inner) return inner;
    } catch (_) {}
    return root;
  }

  /**
   * 纯函数：按钮放哪。
   *  - 气泡外侧有空白（截图里消息右边那种）-> 贴到外侧，符合「消息框边上」
   *  - 没有空白（气泡占满整行）-> 退回气泡内右上角，避免撑出横向滚动条
   */
  function decideMessageButtonPlacement(rootRect, boxRect, dir) {
    if (!rootRect || !boxRect || !rootRect.width || !boxRect.width) return 'inside';
    const roomRight = boxRect.right - rootRect.right;
    const roomLeft = rootRect.left - boxRect.left;
    if (dir === 'out') return roomLeft >= MSG_BTN_GAP ? 'side-left' : 'inside';
    if (roomRight >= MSG_BTN_GAP) return 'side-right';
    if (roomLeft >= MSG_BTN_GAP) return 'side-left';
    return 'inside';
  }

  /** 按「消息」把已识别的媒体分组（用 DOM containment，消息重渲染也不会串） */
  function collectMessageBuckets(opts) {
    const includeVideos = opts && 'includeVideos' in opts ? !!opts.includeVideos : !!settings.msgButtonIncludeVideos;
    const buckets = new Map(); // messageRoot -> items[]
    for (const it of state.items) {
      if (!it.el || !it.el.isConnected) continue; // 元素已被页面回收
      if (it.kind === 'video' && !includeVideos) continue;
      const root = closestMessage(it.el);
      if (!root) continue;
      let arr = buckets.get(root);
      if (!arr) {
        arr = [];
        buckets.set(root, arr);
      }
      arr.push(it);
    }
    return buckets;
  }

  /** 给每条含图片的消息补一个下载按钮（含别人发来的消息） */
  function syncMessageButtons() {
    if (!settings.msgButton) {
      removeMessageButtons();
      return;
    }
    for (const [root, items] of collectMessageBuckets()) {
      const host = messageBubbleHost(root) || root;
      msgButtonTargets.set(root, new Set(items.map((it) => it.key))); // 这条消息的图，只此一份

      let btn = null;
      try {
        btn = host.querySelector(':scope > .tmd-msg-btn');
      } catch (_) {}
      if (!btn) {
        btn = h('button', {
          class: 'tmd-msg-btn',
          type: 'button',
          'data-tmd-ui': '1',
          html: MSG_BTN_ICON,
          onpointerdown: (e) => e.stopPropagation(),
          onclick: (e) => {
            e.preventDefault();
            e.stopPropagation();
            downloadMessageMedia(root);
          },
        });
        try {
          const pos = getComputedStyle(host).position;
          if (!pos || pos === 'static') host.style.position = 'relative';
          host.appendChild(btn);
        } catch (err) {
          continue; // 插不进去就跳过这条消息
        }
      }

      // 贴边还是框内：按气泡外侧的实际空白决定
      let place = 'inside';
      try {
        const rootRect = host.getBoundingClientRect();
        const box = (typeof host.closest === 'function' && host.closest('#column-center, #MiddleColumn')) || document.body;
        const boxRect = box && typeof box.getBoundingClientRect === 'function' ? box.getBoundingClientRect() : null;
        const dir = (items[0] && items[0].dir) || messageDirection(root);
        place = decideMessageButtonPlacement(rootRect, boxRect, dir);
      } catch (_) {}
      btn.classList.toggle('tmd-side-right', place === 'side-right');
      btn.classList.toggle('tmd-side-left', place === 'side-left');

      // 相册 / 多图：常显 + 数量徽标，方便一眼看到「这条消息有几张」
      const multi = items.length > 1;
      btn.classList.toggle('tmd-msg-multi', multi);
      btn.innerHTML = MSG_BTN_ICON + (multi ? `<span class="tmd-msg-num">${items.length}</span>` : '');

      const photos = items.filter((it) => it.kind === 'photo').length;
      const videos = items.length - photos;
      btn.title = `一键下载这条消息里的全部图片（${photos} 张${videos ? ` + ${videos} 个视频` : ''}）`;
      btn.dataset.count = String(items.length);
    }
  }

  function removeMessageButtons() {
    document.querySelectorAll('.tmd-msg-btn').forEach((b) => {
      try {
        b.remove();
      } catch (_) {}
    });
  }

  /** 只下载「当前这一条消息」里的图片，不碰页面上其它任何消息 */
  function downloadMessageMedia(root) {
    buildUI();
    const keys = msgButtonTargets.get(root);
    const items = selectMessageTargets(state.items, keys, {
      includeVideos: !!settings.msgButtonIncludeVideos,
    });
    if (!items.length) {
      toast('这条消息里没有可下载的图片（元素可能已被页面回收，滚回这条消息再点）');
      return;
    }
    items.forEach((it) => state.selected.add(it.key));
    enqueue(items);
    renderList();
    const photos = items.filter((it) => it.kind === 'photo').length;
    const videos = items.length - photos;
    toast(`本条消息：已加入 ${photos} 张图片${videos ? ` + ${videos} 个视频` : ''}（不含其它消息）`);
  }

  // ============================== Telegram 多选 -> 一键下载选中的图片

  const SEL_BTN_ID = 'tmd-sel-btn';
  const SEL_WRAP_ID = 'tmd-sel-wrap';
  const SEL_VID_ID = 'tmd-sel-vid';
  const VID_ICON =
    '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M4 6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6Zm13.2 4.4 3.1-2.3c.6-.5 1.7-.1 1.7.8v6.2c0 .9-1.1 1.3-1.7.8l-3.1-2.3V10.4Z"/></svg>';
  const DL_ICON =
    '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 3a1 1 0 0 1 1 1v8.6l2.3-2.3a1 1 0 1 1 1.4 1.4l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.4L11 12.6V4a1 1 0 0 1 1-1Zm-7 15a1 1 0 0 1 1 1v1h12v-1a1 1 0 1 1 2 0v1.5A1.5 1.5 0 0 1 18.5 22h-13A1.5 1.5 0 0 1 4 20.5V19a1 1 0 0 1 1-1Z"/></svg>';

  /**
   * 纯判定：这条消息在 Telegram 自己的多选模式里是否被勾选。
   * 三条策略，任一命中即算选中（K 版/A 版类名不同，Telegram 改版也不会同时失效）。
   *   1. 消息节点上的 is-selected / selected / is-checked 类
   *   2. aria-selected / data-selected 属性
   *   3. 节点内部那个多选框处于选中态
   */
  function isMessageSelected(root) {
    if (!root) return false;

    const cl = root.classList;
    if (cl && typeof cl.contains === 'function') {
      if (cl.contains('is-selected') || cl.contains('selected') || cl.contains('is-checked')) return true;
    }
    if (typeof root.getAttribute === 'function') {
      if (root.getAttribute('aria-selected') === 'true') return true;
      if (root.getAttribute('data-selected') === 'true') return true;
    }
    try {
      if (typeof root.querySelector === 'function') {
        if (root.querySelector('input[type="checkbox"]:checked, input[type="radio"]:checked, [aria-checked="true"]')) return true;
      }
      if (typeof root.querySelectorAll === 'function') {
        for (const box of root.querySelectorAll('.checkbox, .Checkbox, .message-select, .select-checkbox, .CheckboxInput')) {
          const bcl = box.classList;
          if (!bcl || typeof bcl.contains !== 'function') continue;
          if (bcl.contains('checked') || bcl.contains('is-checked') || bcl.contains('selected') || bcl.contains('is-selected')) {
            return true;
          }
        }
      }
    } catch (_) {}
    return false;
  }

  /** 收集「Telegram 中已选中」的那些消息里的媒体（只认这些消息，别的一律不碰） */
  /**
   * 当前 DOM 里「可见的」选中消息中的全部媒体。
   * 注意：Telegram 会虚拟化消息列表，滚出视口的消息不在 DOM 里，
   * 所以这个结果必须再并进 tgSelected 快照，不能直接拿来当总数。
   */
  function collectTelegramSelectedItems() {
    const out = [];
    for (const [root, items] of collectMessageBuckets({ includeVideos: true })) {
      if (!isMessageSelected(root)) continue;
      out.push(...items);
    }
    return out;
  }

  /** 当前可见的「未选中」消息里的媒体 key（用来把取消勾选的项目从快照里摘掉） */
  function collectVisibleUnselectedKeys() {
    const keys = new Set();
    for (const [root, items] of collectMessageBuckets({ includeVideos: true })) {
      if (isMessageSelected(root)) continue;
      for (const it of items) keys.add(it.key);
    }
    return keys;
  }

  /** 纯函数：把可见选中项并入快照；返回新增数量 */
  function mergeSelectionSnapshot(store, items, msgs) {
    let added = 0;
    for (const it of items || []) {
      if (!it || !it.key) continue;
      if (msgs && it.msgId) msgs.add(it.msgId);
      if (store.has(it.key)) continue;
      store.set(it.key, it);
      added += 1;
    }
    return added;
  }

  /** 纯函数：快照里的图片 / 视频数量 */
  function countSelection(store, opts) {
    const includeVideos = !!(opts && opts.includeVideos);
    let photos = 0;
    let videos = 0;
    if (store && typeof store.values === 'function') {
      for (const it of store.values()) {
        if (!it) continue;
        if (it.kind === 'video') videos += 1;
        else photos += 1;
      }
    }
    return { photos, videos, total: photos + (includeVideos ? videos : 0) };
  }

  /**
   * 纯函数：从选中快照里挑出本次要下载的条目。
   *  - 默认：只图片
   *  - includeVideos：图片 + 视频
   *  - videosOnly：只视频（按钮上那个「+N 个视频」用）
   */
  function pickSelectionDownloadItems(store, opts) {
    const videosOnly = !!(opts && opts.videosOnly);
    const includeVideos = !!(opts && opts.includeVideos);
    const out = [];
    if (!store || typeof store.values !== 'function') return out;
    for (const it of store.values()) {
      if (!it || !it.src) continue;
      if (it.kind === 'video') {
        if (videosOnly || includeVideos) out.push(it);
      } else if (!videosOnly) {
        out.push(it);
      }
    }
    return out;
  }

  /** Telegram 自己的多选工具栏（存在即说明还在多选模式，用来避免误清空快照） */
  function findSelectionToolbar() {
    try {
      const el = document.querySelector(
        '.SelectionToolbar, .selection-toolbar, #selection-toolbar, .selection-toolbar-wrapper, [class*="selection-bar"]'
      );
      if (!el) return null;
      if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) return null;
      return el;
    } catch (_) {
      return null;
    }
  }

  function clearSelectionSnapshot() {
    state.tgSelected.clear();
    state.tgSelectedMsgs.clear();
    state.tgSelectionSig = '';
    state.tgSelectionMiss = 0;
    removeSelectionButton();
  }

  /** 悬浮按钮：只在 Telegram 里选中的消息含图片时出现 */
  function syncSelectionButton() {
    if (!settings.selectedButton) {
      clearSelectionSnapshot();
      return;
    }

    // 1) 累积：把当前可见的选中项并进快照（滚出视口的也不丢）
    const visibleSelected = collectTelegramSelectedItems();
    const added = mergeSelectionSnapshot(state.tgSelected, visibleSelected, state.tgSelectedMsgs);

    // 2) 剪枝：对「看得见但已取消勾选」的消息，把它们的条目从快照里去掉
    const unselected = collectVisibleUnselectedKeys();
    let removed = 0;
    for (const k of unselected) {
      if (state.tgSelected.delete(k)) removed += 1;
    }

    // 3) 退出多选：连续很多轮既看不到选中项、也没有多选工具栏，就认为这次多选结束了
    const selecting = visibleSelected.length > 0 || !!findSelectionToolbar();
    state.tgSelectionMiss = selecting ? 0 : state.tgSelectionMiss + 1;
    if (state.tgSelectionMiss >= 20 && state.tgSelected.size) {
      clearSelectionSnapshot();
      return;
    }

    const includeVideos = !!settings.msgButtonIncludeVideos;
    const counts = countSelection(state.tgSelected, { includeVideos });

    if (added || removed) {
      state.tgSelectionSig = '';
      if (state.tgSelected.size) {
        for (const it of state.tgSelected.values()) state.selected.add(it.key); // 面板里同步高亮
        renderList();
      }
    }

    if (!counts.total) {
      removeSelectionButton();
      return;
    }

    let wrap = document.getElementById(SEL_WRAP_ID);
    if (!wrap) {
      wrap = h('div', { id: SEL_WRAP_ID, 'data-tmd-ui': '1', class: 'tmd-sel-wrap' }, [
        h('button', {
          id: SEL_BTN_ID,
          'data-tmd-ui': '1',
          type: 'button',
          class: 'tmd-sel-btn',
          onclick: (e) => {
            e.preventDefault();
            e.stopPropagation();
            downloadTelegramSelection();
          },
        }),
      ]);
      document.body.appendChild(wrap);
    }

    const btn = wrap.querySelector('#' + SEL_BTN_ID);
    const label = includeVideos && counts.videos
      ? `下载选中的 ${counts.photos} 张图片 + ${counts.videos} 个视频`
      : `下载选中的 ${counts.photos} 张图片`;
    btn.innerHTML = `${DL_ICON}<span>${label}</span>`;
    const msgCount = state.tgSelectedMsgs.size;
    btn.title =
      `来自 Telegram 中选中的 ${msgCount || '?'} 条消息：图片 ${counts.photos} 张、视频 ${counts.videos} 个` +
      '（滚出屏幕的消息也算在内）';

    // 有视频但当前设置不含视频时，旁边挂一个「+N 个视频」的小按钮，点了就直接下视频
    let vid = wrap.querySelector('#' + SEL_VID_ID);
    const needVidChip = !includeVideos && counts.videos > 0;
    if (needVidChip && !vid) {
      vid = h('button', {
        id: SEL_VID_ID,
        'data-tmd-ui': '1',
        type: 'button',
        class: 'tmd-sel-vid',
        onclick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          downloadTelegramSelection({ videosOnly: true });
        },
      });
      wrap.appendChild(vid);
    } else if (!needVidChip && vid) {
      try {
        vid.remove();
      } catch (_) {}
      vid = null;
    }
    if (vid) {
      vid.innerHTML = `${VID_ICON}<span>${counts.videos} 个视频</span>`;
      vid.title =
        '把选中的这些消息里的视频也一起下载（流式视频会实时录制，耗时约等于视频时长）。' +
        '想以后都包含视频，可在面板设置里勾选「选中下载包含视频」。';
    }

    positionSelectionButton(wrap);
  }

  function positionSelectionButton(el) {
    try {
      const col = document.querySelector('#column-center, #MiddleColumn') || document.body;
      const r = col.getBoundingClientRect();
      const composer = document.querySelector('#column-center .chat-input, #MiddleColumn .Composer');
      const cr = composer && typeof composer.getBoundingClientRect === 'function' ? composer.getBoundingClientRect() : null;
      const bottom = cr && cr.height ? window.innerHeight - cr.top + 12 : window.innerHeight - r.bottom + 78;
      el.style.left = Math.round(r.left + r.width / 2) + 'px';
      el.style.bottom = Math.round(Math.max(12, bottom)) + 'px';
    } catch (_) {}
  }

  function removeSelectionButton() {
    for (const id of [SEL_WRAP_ID, SEL_BTN_ID, SEL_VID_ID]) {
      const el = document.getElementById(id);
      if (el) {
        try {
          el.remove();
        } catch (_) {}
      }
    }
  }

  /** 一键：下载 Telegram 中选中的那些消息里的图片 */
  function downloadTelegramSelection(opts) {
    const videosOnly = !!(opts && opts.videosOnly);
    const includeVideos = !!settings.msgButtonIncludeVideos;

    buildUI();
    scanDom(); // 先把刚加载出来的媒体收进来
    mergeSelectionSnapshot(state.tgSelected, collectTelegramSelectedItems(), state.tgSelectedMsgs);

    const items = pickSelectionDownloadItems(state.tgSelected, { videosOnly, includeVideos });
    if (!items.length) {
      toast(
        videosOnly
          ? '没有检测到选中的视频'
          : '没检测到选中的图片：请在 Telegram 里右键消息 →「选择」勾选后再点这里'
      );
      return;
    }

    items.forEach((it) => state.selected.add(it.key));
    enqueue(items); // enqueue 会自动跳过已在队列里的
    renderList();

    const photos = videosOnly ? 0 : items.filter((it) => it.kind !== 'video').length;
    const videos = items.filter((it) => it.kind === 'video').length;
    // 视频里的 MSE 流必须「边播边录」，元素被虚拟化回收后录不了，这里先提示
    const detachedVideos = videos
      ? items.filter((it) => it.kind === 'video' && (!it.el || !it.el.isConnected)).length
      : 0;
    const warn = detachedVideos
      ? `；其中 ${detachedVideos} 个已滚出屏幕，若是流式视频需要滚回该消息附近再重试`
      : videos
        ? '；视频若是流式播放会实时录制，耗时约等于视频时长'
        : '';
    toast(`已加入 ${photos ? `${photos} 张图片` : ''}${photos && videos ? ' + ' : ''}${videos ? `${videos} 个视频` : ''}（来自选中的消息）${warn}`);
  }


  function watchDom() {
    let timer = 0;
    const observer = new MutationObserver(() => {
      if (!settings.autoDetect || state.scanning) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!ui.panel) return;
        scanDom();
        syncSelectionButton(); // Telegram 的多选状态也要跟着刷新
        updateHeaderStats();
      }, 1200);
    });
    try {
      observer.observe(document.body, { childList: true, subtree: true });
    } catch (_) {}
  }

  function watchChatSwitch() {
    let lastKey = location.hash;
    const check = () => {
      if (location.hash === lastKey) return;
      lastKey = location.hash;
      if (!settings.clearOnChatSwitch) return;
      if (state.items.length) {
        clearItems();
        toast('已切换聊天，媒体列表已清空');
      }
    };
    window.addEventListener('hashchange', check);
    // K 版切换聊天不一定改 hash，这里额外盯着标题变化（连续两次相同才认定切换）
    let pendingTitle = '';
    setInterval(() => {
      const t = getChatTitle();
      if (!t || !state.chatTitle || t === state.chatTitle) {
        pendingTitle = '';
        return;
      }
      if (pendingTitle !== t) {
        pendingTitle = t; // 第一次看到，先记下来
        return;
      }
      pendingTitle = '';
      state.chatTitle = t;
      if (settings.clearOnChatSwitch && state.items.length) {
        clearItems();
        toast(`已切换到「${t}」，媒体列表已清空`);
      }
    }, 3000);
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return undefined;

    if (msg.type === 'TMD_DL_EVENT') {
      handleDownloadEvent(msg);
      return undefined;
    }

    if (msg.type === 'TMD_CMD') {
      switch (msg.cmd) {
        case 'togglePanel':
          buildUI();
          togglePanel(msg.force === 'open' ? true : msg.force === 'close' ? false : undefined);
          break;
        case 'scan':
          buildUI();
          togglePanel(true);
          onScan();
          break;
        case 'autoscroll':
          buildUI();
          togglePanel(true);
          autoScrollLoad();
          break;
        case 'downloadSelected':
          buildUI();
          downloadSelected();
          break;
        case 'downloadAll':
          buildUI();
          downloadAll();
          break;
        case 'clear':
          buildUI();
          clearItems();
          break;
        case 'selectedImages':
          downloadTelegramSelection();
          break;
        case 'setSetting':
          if (msg.key) {
            settings[msg.key] = msg.value;
            saveSettings();
            if (ui.panel) {
              if (msg.key === 'minPx' && ui.fMinPx) ui.fMinPx.value = String(msg.value);
              if (msg.key === 'includeStickers' && ui.fSticker) ui.fSticker.checked = !!msg.value;
              renderList();
            }
            if (msg.key === 'includeStickers' || msg.key === 'includeLinkPreview' || msg.key === 'includeBackground') scanDom();
          }
          break;
        default:
          break;
      }
      sendResponse({ ok: true, stats: buildStats() });
      return undefined;
    }

    if (msg.type === 'TMD_GET_STATS') {
      sendResponse({ ok: true, stats: buildStats() });
      return undefined;
    }

    return undefined;
  });

  function buildStats() {
    return {
      total: state.items.length,
      photos: state.items.filter((it) => it.kind === 'photo').length,
      videos: state.items.filter((it) => it.kind === 'video').length,
      selected: state.selected.size,
      done: state.items.filter((it) => it.status === 'ok').length,
      failed: state.items.filter((it) => it.status === 'fail').length,
      scanning: state.scanning,
      chat: state.chatTitle || getChatTitle(),
      panelVisible: ui.panel ? !ui.panel.classList.contains('tmd-hidden') : false,
    };
  }

  async function init() {
    await loadSettings();
    if (!/^(web|webk|webz)\.telegram\.org$/.test(location.hostname)) return; // 双保险：只在本站运行
    const ok = await ensureBridge();
    if (!ok) log('警告：主世界桥接不可用，下载可能失败。请刷新页面重试。');
    buildUI();
    syncMessageButtons();
    syncSelectionButton();
    // Telegram 的多选状态没有事件可订阅，这里低频轮询
    setInterval(() => {
      // 多选中：持续扫描，保证刚勾选的消息（及其图片）能及时被收录
      if (state.tgSelected.size) scanDom();
      else syncSelectionButton();
      syncMessageButtons();
    }, 900);
    watchDom();
    watchChatSwitch();
    log('已就绪：消息旁的下载按钮 / 选中图片后的悬浮按钮 / 右下角面板。');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
