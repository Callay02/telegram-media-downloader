/**
 * Telegram 媒体批量下载器 —— 工具栏弹窗
 * 只做遥控：真正的扫描 / 下载都在页面的 content script 里完成。
 */
'use strict';

const $ = (id) => document.getElementById(id);
/** @type {number|null} */
let tabId = null;
let injected = false;
let settingsLoaded = false;

const TG_URL = /^https:\/\/(web|webk|webz)\.telegram\.org\//;

document.addEventListener('DOMContentLoaded', init);

async function init() {
  const tab = await getActiveTab();
  if (!tab || !TG_URL.test(tab.url || '')) {
    setHint('请先打开 web.telegram.org 并进入一个聊天窗口');
    setButtonsEnabled(false);
    $('chat').textContent = '当前标签页不是 Telegram Web';
    return;
  }
  tabId = tab.id;
  setButtonsEnabled(true);
  bind();
  await refresh();
  setInterval(refresh, 1500); // 弹窗打开期间轮询一次即可
}

function bind() {
  $('open').addEventListener('click', () => send('togglePanel'));
  $('scan').addEventListener('click', () => send('scan', 'open'));
  $('auto').addEventListener('click', () => send('autoscroll', 'open'));
  $('selected').addEventListener('click', () => send('selectedImages', 'open'));
  $('dl-sel').addEventListener('click', () => send('downloadSelected', 'open'));
  $('dl-all').addEventListener('click', () => send('downloadAll', 'open'));
  $('clear').addEventListener('click', () => send('clear'));
  $('autodetect').addEventListener('change', async () => {
    await send('setSetting', null, { key: 'autoDetect', value: $('autodetect').checked });
  });
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0];
}

function setButtonsEnabled(on) {
  document.querySelectorAll('.grid button').forEach((b) => {
    b.disabled = !on;
  });
  $('autodetect').disabled = !on;
}

function setHint(text) {
  $('hint').textContent = text || '';
}

async function send(cmd, force, extra) {
  if (tabId == null) return null;
  const msg = { type: 'TMD_CMD', cmd, force, ...(extra || {}) };
  try {
    const res = await chrome.tabs.sendMessage(tabId, msg);
    if (res && res.stats) paint(res.stats);
    return res;
  } catch (_) {
    // content script 还没注入（例如扩展刚安装、页面还没刷新）
    const ok = await injectContentScript();
    if (!ok) return null;
    try {
      const res = await chrome.tabs.sendMessage(tabId, msg);
      if (res && res.stats) paint(res.stats);
      return res;
    } catch (err) {
      setHint('与页面通信失败：' + String((err && err.message) || err));
      return null;
    }
  }
}

async function injectContentScript() {
  if (injected) return false;
  setHint('正在注入脚本…');
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['src/content.css'] });
    // 主世界桥接脚本（MSE 视频录制 / blob 读取需要它）
    await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['src/inject.js'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content.js'] });
    injected = true;
    await sleep(500);
    setHint('');
    return true;
  } catch (err) {
    setHint('注入失败：' + String((err && err.message) || err) + '（刷新 Telegram 页面后重试）');
    return false;
  }
}

async function refresh() {
  if (tabId == null) return;
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'TMD_GET_STATS' });
    if (res && res.stats) paint(res.stats);
  } catch (_) {
    setHint('页面脚本未就绪，点任意按钮会自动注入');
  }
}

function paint(stats) {
  $('s-total').textContent = stats.total || 0;
  $('s-photo').textContent = stats.photos || 0;
  $('s-video').textContent = stats.videos || 0;
  $('s-done').textContent = stats.done || 0;
  $('s-fail').textContent = stats.failed || 0;
  $('chat').textContent = stats.chat ? `当前：${stats.chat}` : '未检测到聊天';
  setHint('');
  if (!settingsLoaded) {
    settingsLoaded = true;
    chrome.storage.local.get('tmd_settings', (res) => {
      const s = (res && res.tmd_settings) || {};
      $('autodetect').checked = typeof s.autoDetect === 'boolean' ? s.autoDetect : true;
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
