/**
 * Telegram 媒体批量下载器 —— background service worker
 *
 * 职责：
 *  1. 接收 content script 送来的 data: URL，调用 chrome.downloads 落盘
 *     （走这条路的文件可以带子目录，且能拿到真实的“完成 / 中断”事件）。
 *  2. 跟踪每个 downloadId 的最终状态，并把结果广播回对应的 Telegram 标签页。
 *  3. 提供扩展级统计信息给 popup。
 *
 * 说明：大于阈值的文件不会走这里，而是在页面主世界直接 <a download> 触发下载，
 *      因为 blob: URL 只在其创建源（telegram.org 页面）里可解析。
 */

'use strict';

/** downloadId -> { itemKey, tabId, filename } */
const tracked = new Map();

/** 本次 SW 生命周期内的计数（SW 休眠后归零，仅用于 UI 即时反馈） */
const counters = { started: 0, complete: 0, failed: 0 };

// Chromium 对 URL 长度有约 2MB 的硬上限（url::kMaxURLChars），超过会让
// chrome.downloads.download 直接报 Invalid URL，所以这里是硬保险丝。
const MAX_DATA_URL_BYTES = 2 * 1024 * 1024;
const MAX_PATH_LENGTH = 240; // chrome.downloads 相对路径的长度保险丝

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return undefined;

  switch (msg.type) {
    case 'TMD_PING':
      sendResponse({ ok: true, counters });
      return undefined;

    case 'TMD_COUNTERS':
      sendResponse({ ok: true, counters });
      return undefined;

    case 'TMD_DL_DATA':
      handleDataDownload(msg, sender)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
      return true; // 异步响应

    case 'TMD_DL_URL':
      handleRemoteDownload(msg, sender)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
      return true; // 异步响应

    case 'TMD_CHECK_DL':
      checkDownload(msg)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
      return true; // 异步响应

    case 'TMD_INJECT_MAIN':
      injectMainWorld(sender)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
      return true; // 异步响应

    default:
      return undefined;
  }
});

/**
 * 回查一个下载任务的真实状态。
 * service worker 可能随时休眠、内存里的 tracked 会丢，所以让 content script 主动问。
 */
async function checkDownload(msg) {
  const id = Number(msg && msg.downloadId);
  if (!Number.isFinite(id)) return { ok: false, error: '缺少 downloadId' };
  if (!chrome.downloads || !chrome.downloads.search) return { ok: false, error: 'downloads.search 不可用' };
  const items = await chrome.downloads.search({ id });
  const item = items && items[0];
  if (!item) return { ok: true, state: '' }; // 记录已被清理
  return {
    ok: true,
    state: item.state || '',
    error: item.error || '',
    filename: item.filename || '',
  };
}

/**
 * 用 chrome.scripting 往页面主世界补注入桥接脚本。
 * 走扩展 API 注入不受页面 CSP 限制，比在页面里插 <script> 更可靠。
 */
async function injectMainWorld(sender) {
  const tabId = sender && sender.tab ? sender.tab.id : undefined;
  if (typeof tabId !== 'number') return { ok: false, error: '拿不到标签页 id' };
  if (!chrome.scripting || !chrome.scripting.executeScript) return { ok: false, error: 'scripting API 不可用' };
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: 'MAIN',
      files: ['src/inject.js'],
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/**
 * 直接用原始 http(s) 地址下载（不受页面 CORS 限制，浏览器下载器会带上 Cookie）。
 * 用于部分版本里 src 就是 CDN 直链、但页面内 fetch 被 CORS 拦截的情况。
 */
async function handleRemoteDownload(msg, sender) {
  const { url, filename, itemKey, itemId } = msg;
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return { ok: false, error: '不是合法的 http(s) 地址' };
  }
  const safeName = sanitizeDownloadPath(filename) || `telegram_media_${Date.now()}`;
  const tabId = sender && sender.tab ? sender.tab.id : undefined;
  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename: safeName,
      conflictAction: 'uniquify',
      saveAs: false,
    });
    counters.started += 1;
    tracked.set(downloadId, { itemKey, itemId, tabId, filename: safeName });
    return { ok: true, downloadId, filename: safeName, mode: 'remote-url' };
  } catch (err) {
    counters.failed += 1;
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/**
 * 用 chrome.downloads.download 落盘一个 data: URL。
 * @param {{dataUrl:string, filename?:string, itemKey?:string, itemId?:string}} msg
 */
async function handleDataDownload(msg, sender) {
  const { dataUrl, filename, itemKey, itemId } = msg;
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
    return { ok: false, error: '不是合法的 data: URL' };
  }
  if (dataUrl.length > MAX_DATA_URL_BYTES) {
    return { ok: false, error: '文件过大，超过 data URL 通道上限' };
  }

  const safeName = sanitizeDownloadPath(filename) || `telegram_media_${Date.now()}`;
  const tabId = sender && sender.tab ? sender.tab.id : undefined;

  try {
    const downloadId = await chrome.downloads.download({
      url: dataUrl,
      filename: safeName,
      conflictAction: 'uniquify',
      saveAs: false,
    });
    counters.started += 1;
    tracked.set(downloadId, { itemKey, itemId, tabId, filename: safeName });
    return { ok: true, downloadId, filename: safeName, mode: 'downloads-api' };
  } catch (err) {
    counters.failed += 1;
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/**
 * chrome.downloads 只接受相对于下载目录的路径：
 *  - 禁止绝对路径 / 盘符 / 上级目录
 *  - 过滤各段里的非法字符
 */
function sanitizeDownloadPath(path) {
  if (!path) return '';
  const parts = String(path)
    .split(/[\\/]+/)
    .map((seg) =>
      seg
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
        .replace(/^\.+$/, '_')
        .replace(/^\.+/, '_')
        .replace(/\.+$/, '')
        .trim()
    )
    .filter((seg) => seg && seg !== '.' && seg !== '..');
  if (!parts.length) return '';

  const full = parts.join('/');
  if (full.length <= MAX_PATH_LENGTH) return full;

  // 文件名优先：先限制最后一段，再从前往后塞目录，塞不下的深层目录丢弃
  const base = parts[parts.length - 1].slice(0, 160);
  const kept = [];
  let len = 0;
  for (const dir of parts.slice(0, -1)) {
    const seg = dir.slice(0, 80);
    if (len + seg.length + 1 + base.length + 1 > MAX_PATH_LENGTH) break;
    kept.push(seg);
    len += seg.length + 1;
  }
  return (kept.length ? kept.join('/') + '/' : '') + base;
}

/** 下载状态变化 -> 回传给发起下载的那个标签页 */
chrome.downloads.onChanged.addListener((delta) => {
  const meta = tracked.get(delta.id);
  if (!meta) return;

  if (delta.state && delta.state.current === 'complete') {
    counters.complete += 1;
    tracked.delete(delta.id);
    notifyTab(meta, { state: 'complete', filename: meta.filename });
  } else if (delta.state && delta.state.current === 'interrupted') {
    counters.failed += 1;
    tracked.delete(delta.id);
    notifyTab(meta, {
      state: 'failed',
      error: (delta.error && delta.error.current) || 'interrupted',
      filename: meta.filename,
    });
  }
});

function notifyTab(meta, payload) {
  if (typeof meta.tabId !== 'number') return;
  chrome.tabs
    .sendMessage(meta.tabId, {
      type: 'TMD_DL_EVENT',
      itemKey: meta.itemKey,
      itemId: meta.itemId,
      ...payload,
    })
    .catch(() => {
      /* 标签页已关闭或未注入 content script，忽略 */
    });
}

/** 右键菜单：在页面里打开下载面板（可选增强） */
chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.contextMenus.create(
      {
        id: 'tmd-open-panel',
        title: '打开 Telegram 媒体下载面板',
        contexts: ['page'],
        documentUrlPatterns: [
          'https://web.telegram.org/*',
          'https://webk.telegram.org/*',
          'https://webz.telegram.org/*',
        ],
      },
      () => void chrome.runtime.lastError
    );
  } catch (_) {
    /* 忽略 */
  }
});

if (chrome.contextMenus && chrome.contextMenus.onClicked) {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'tmd-open-panel' && tab && tab.id) {
      chrome.tabs
        .sendMessage(tab.id, { type: 'TMD_CMD', cmd: 'togglePanel', force: 'open' })
        .catch(() => {});
    }
  });
}
