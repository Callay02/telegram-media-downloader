#!/usr/bin/env node
/**
 * 离线自测：在 Node 里用最小 DOM/Chrome 桩加载 content.js，
 * 只验证「命名模板 / 路径清洗 / 扩展名推断」这些纯逻辑。
 *
 * 用法：node tools/selftest.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILE = path.join(__dirname, '..', 'src', 'content.js');
const source = fs.readFileSync(FILE, 'utf8');

// 在 IIFE 收尾前把内部纯函数暴露出来
const tail = '})();';
const cut = source.lastIndexOf(tail);
if (cut < 0) throw new Error('找不到 content.js 的 IIFE 结尾');
const instrumented =
  source.slice(0, cut) +
  '\n  globalThis.__TMD_TEST__ = { renderTemplate, renderTokens, resolveDir, flattenPath, extFromType, extFromSrc, sanitizeSegment,' +
  ' setSettings: (v) => Object.assign(settings, v), setState: (v) => Object.assign(state, v),' +
  ' messageDirection, isMessageSelected, decideMessageButtonPlacement, selectMessageTargets,' +
  ' mergeSelectionSnapshot, countSelection, pickSelectionDownloadItems,' +
  ' selectionSummary, SEL_CHIP_TEXT };\n' +
  source.slice(cut);

// ------------------------------------------------------------------ 桩环境

const noop = () => {};

function makeElement() {
  const el = {
    nodeType: 1,
    tagName: 'DIV',
    style: {},
    dataset: {},
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    children: [],
    attributes: {},
    setAttribute(k, v) {
      this.attributes[k] = v;
    },
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null;
    },
    appendChild(c) {
      this.children.push(c);
      return c;
    },
    append() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: noop,
    removeEventListener: noop,
    closest: () => null,
  };
  return el;
}

const ctx = {
  console,
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval: noop,
  Math,
  Date,
  JSON,
  Object,
  Array,
  String,
  Number,
  RegExp,
  Promise,
  Error,
  URL,
  Blob: class {},
  location: { hostname: 'web.telegram.org', hash: '' },
  crypto: { randomUUID: () => 'test-uuid' },
  MutationObserver: class {
    observe() {}
    disconnect() {}
  },
  chrome: {
    storage: { local: { get: (k, cb) => cb && cb({}), set: noop } },
    runtime: {
      onMessage: { addListener: noop },
      getURL: (p) => 'chrome-extension://test/' + p,
      sendMessage: async () => ({ ok: true }),
      lastError: null,
    },
  },
  document: {
    readyState: 'loading', // 让 init() 走 DOMContentLoaded 分支，避免真正初始化 UI
    documentElement: makeElement(),
    body: makeElement(),
    head: makeElement(),
    createElement: makeElement,
    createTextNode: (t) => ({ nodeType: 3, textContent: t }),
    createDocumentFragment: makeElement,
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: noop,
    removeEventListener: noop,
    title: 'Telegram',
  },
  addEventListener: noop,
  removeEventListener: noop,
  postMessage: noop,
  getComputedStyle: () => ({ overflowY: 'auto' }),
};
ctx.window = ctx;
ctx.globalThis = ctx;
ctx.top = ctx;
ctx.self = ctx;

vm.createContext(ctx);
vm.runInContext(instrumented, ctx, { filename: 'content.js' });

const T = ctx.__TMD_TEST__;
if (!T) throw new Error('导出失败：__TMD_TEST__ 未定义');

// ------------------------------------------------------------------ 断言

let pass = 0;
let fail = 0;

function eq(label, actual, expected) {
  if (actual === expected) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}\n      期望: ${JSON.stringify(expected)}\n      实际: ${JSON.stringify(actual)}`);
  }
}

function ok(label, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}${extra ? ' -> ' + JSON.stringify(extra) : ''}`);
  }
}

// 2024-05-13 14:32:07 本地时间
const WHEN = new Date(2024, 4, 13, 14, 32, 7).getTime();
const photo = { kind: 'photo', ext: 'jpg', date: WHEN, msgId: 'm123456', src: 'blob:https://web.telegram.org/abc' };
const video = { kind: 'video', ext: 'mp4', date: WHEN, msgId: 'm999', src: 'blob:https://web.telegram.org/def' };

T.setState({ chatTitle: '设计群' });

console.log('\n[1] 默认模板');
T.setSettings({ template: '{date}_{index}.{ext}', subfolder: 'Telegram/{chat}' });
eq('日期_序号.扩展名', T.renderTemplate('{date}_{index}.{ext}', photo, 7), '20240513_007.jpg');
eq('子目录不含扩展名', T.resolveDir(photo, 7), 'Telegram/设计群');

console.log('\n[2] 带目录的模板');
eq(
  '模板里的 / 形成层级',
  T.renderTemplate('{chat}/{date}/{mid}_{index}.{ext}', photo, 3),
  '设计群/20240513/123456_003.jpg'
);

console.log('\n[3] 时间变量与视频');
eq('time 变量', T.renderTemplate('{time}', video, 1), '143207.mp4');
eq('type 变量', T.renderTemplate('{type}_{index}.{ext}', video, 12), 'video_012.mp4');

console.log('\n[4] 扩展名补全 / 推断');
eq('模板无扩展名时自动补', T.renderTemplate('{date}_{index}', photo, 1), '20240513_001.jpg');
eq('blob URL 推断不出扩展名', T.extFromSrc(photo.src), '');
eq('http URL 推断扩展名', T.extFromSrc('https://cdn.example.com/a/b/photo.WEBP?x=1'), 'webp');
eq('MIME 带参数', T.extFromType('video/mp4; codecs="avc1"'), 'mp4');
eq('MIME 大小写', T.extFromType('IMAGE/PNG'), 'png');
eq('未知 MIME', T.extFromType('application/x-weird'), '');

console.log('\n[5] 危险字符与路径穿越');
T.setState({ chatTitle: 'a/b:c*?"<>|' });
ok('聊天名里的路径分隔符被清洗', !T.renderTokens('{chat}', photo, 1).includes('/'), T.renderTokens('{chat}', photo, 1));
T.setState({ chatTitle: '..' });
eq('聊天名 .. 被替换', T.renderTemplate('{chat}.{ext}', photo, 1), '_.jpg');
eq('模板中的 .. 不会穿越', T.renderTemplate('../../etc/passwd', photo, 1), '_/_/etc/passwd.jpg');
T.setState({ chatTitle: 'x'.repeat(200) });
ok('超长聊天名被截断', T.renderTemplate('{chat}', photo, 1).length <= 86, T.renderTemplate('{chat}', photo, 1).length);

console.log('\n[6] 字符清洗与压平');
eq('控制字符替换为下划线', T.sanitizeSegment('a\tb\nc'), 'a_b_c');
eq('首尾点被清理', T.sanitizeSegment('...name...'), '_name');
eq('空字符串', T.sanitizeSegment(''), '');
eq('子目录压平', T.flattenPath('Telegram/设计群/20240513_007.jpg'), 'Telegram_设计群_20240513_007.jpg');

console.log('\n[7] 时间兜底');
T.setState({ chatTitle: '设计群' });
const noDate = { kind: 'photo', ext: 'jpg', date: 0, msgId: '', src: 'blob:x' };
ok('无消息时间时用当前时间', /^\d{8}_001\.jpg$/.test(T.renderTemplate('{date}_{index}.{ext}', noDate, 1)), T.renderTemplate('{date}_{index}.{ext}', noDate, 1));
eq('mid 缺失时退回序号并补扩展名', T.renderTemplate('{mid}', noDate, 42), '042.jpg');



// ------------------------------------- 消息按钮的「只下这条消息」硬约束

console.log('\n[8] selectMessageTargets（只认这条消息的快照 key）');
const m1 = (n, kind) => ({ key: 'msgA|' + n, kind: kind || 'photo', status: 'idle', src: 'blob:a' + n });
const m2 = (n) => ({ key: 'msgB|' + n, kind: 'photo', status: 'idle', src: 'blob:b' + n });
const allItems = [m1(1), m1(2), m1(3), m2(1), m2(2), { key: 'msgA|5', kind: 'video', status: 'idle', src: 'blob:v' }];
const keysA = new Set(['msgA|1', 'msgA|2', 'msgA|3', 'msgA|5']);
eq('只取这条消息的图片（视频默认不算）', T.selectMessageTargets(allItems, keysA, {}).length, 3);
ok('绝不带别的消息的条目', T.selectMessageTargets(allItems, keysA, {}).every((it) => String(it.key).startsWith('msgA|')));
eq('默认不含视频', T.selectMessageTargets(allItems, keysA, {}).filter((it) => it.kind === 'video').length, 0);
eq('打开开关才带视频', T.selectMessageTargets(allItems, keysA, { includeVideos: true }).length, 4);
eq('空 key 集合 -> 一个都不下', T.selectMessageTargets(allItems, new Set(), {}).length, 0);
eq('没有快照 -> 一个都不下', T.selectMessageTargets(allItems, undefined, {}).length, 0);
const queued = [m1(1), { key: 'msgA|9', kind: 'photo', status: 'queued', src: 'blob:q' }];
eq('已在队列里的不重复加入', T.selectMessageTargets(queued, new Set(['msgA|1', 'msgA|9']), {}).length, 1);
eq('空列表安全', T.selectMessageTargets(null, keysA, {}).length, 0);

// ------------------------------------------- 消息按钮放哪（贴边 / 框内兜底）

console.log('\n[9] decideMessageButtonPlacement');
const rect = (left, right) => ({ left, right, top: 0, width: right - left });
// 复刻截图场景：气泡右侧还有大片空白
eq('气泡右边有空白 -> 贴到外侧右边', T.decideMessageButtonPlacement(rect(230, 1180), rect(230, 1296), 'in'), 'side-right');
eq('自己发的、左边有空白 -> 贴到外侧左边', T.decideMessageButtonPlacement(rect(400, 1180), rect(230, 1296), 'out'), 'side-left');
eq('自己发的但左边没地方 -> 退回框内', T.decideMessageButtonPlacement(rect(235, 1180), rect(230, 1296), 'out'), 'inside');
eq('气泡占满整行 -> 退回框内（不撑出横向滚动条）', T.decideMessageButtonPlacement(rect(230, 1296), rect(230, 1296), 'in'), 'inside');
eq('方向未知但右边有空间 -> 仍然贴右边', T.decideMessageButtonPlacement(rect(230, 900), rect(230, 1296), 'unknown'), 'side-right');
eq('拿不到布局信息 -> 退回框内', T.decideMessageButtonPlacement(null, rect(0, 100), 'in'), 'inside');
eq('元素还没排版(width=0) -> 退回框内', T.decideMessageButtonPlacement({ width: 0, left: 0, right: 0 }, rect(0, 100), 'in'), 'inside');

// ------------------------------------------- 消息方向判定（别人发的 / 自己发的）

console.log('\n[10] messageDirection');
const fake = (classes, attrs) => ({
  classList: { contains: (c) => (classes || []).includes(c) },
  getAttribute: (k) => (attrs || {})[k] ?? null,
  closest: () => null,
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
});
eq('K 版 is-in -> 别人发的', T.messageDirection(fake(['bubble', 'is-in', 'is-first'])), 'in');
eq('K 版 is-out -> 自己发的', T.messageDirection(fake(['bubble', 'is-out'])), 'out');
eq('A 版 own -> 自己发的', T.messageDirection(fake(['Message', 'own'])), 'out');
eq('A 版 incoming -> 别人发的', T.messageDirection(fake(['Message', 'incoming'])), 'in');
eq('data-is-out=1 -> 自己发的', T.messageDirection(fake([], { 'data-is-out': '1' })), 'out');
eq('data-own=0 -> 别人发的', T.messageDirection(fake([], { 'data-own': '0' })), 'in');
eq('完全认不出来时返回 unknown（不会被过滤）', T.messageDirection(fake(['bubble'])), 'unknown');
eq('null 安全', T.messageDirection(null), 'unknown');


// ------------------------------------- Telegram 多选状态识别（纯判定）

console.log('\n[11] isMessageSelected');
const fakeRoot = (o) => {
  const opt = o || {};
  return {
    classList: { contains: (c) => (opt.classes || []).includes(c) },
    getAttribute: (k) => ((opt.attrs || {})[k] !== undefined ? opt.attrs[k] : null),
    querySelector: () => (opt.checkedBox ? { tag: 'input' } : null),
    querySelectorAll: () => opt.boxes || [],
  };
};
eq('K 版 is-selected -> 已选中', T.isMessageSelected(fakeRoot({ classes: ['bubble', 'is-selected'] })), true);
eq('A 版 selected -> 已选中', T.isMessageSelected(fakeRoot({ classes: ['Message', 'selected'] })), true);
eq('is-checked -> 已选中', T.isMessageSelected(fakeRoot({ classes: ['bubble', 'is-checked'] })), true);
eq('aria-selected=true -> 已选中', T.isMessageSelected(fakeRoot({ attrs: { 'aria-selected': 'true' } })), true);
eq('data-selected=true -> 已选中', T.isMessageSelected(fakeRoot({ attrs: { 'data-selected': 'true' } })), true);
eq('内部勾选框选中 -> 已选中', T.isMessageSelected(fakeRoot({ checkedBox: true })), true);
eq(
  '内部 .checkbox.checked -> 已选中',
  T.isMessageSelected(fakeRoot({ boxes: [{ classList: { contains: (c) => c === 'checked' } }] })),
  true
);
eq('普通气泡 -> 未选中', T.isMessageSelected(fakeRoot({ classes: ['bubble', 'is-in'] })), false);
eq('类名 unselected 不算选中', T.isMessageSelected(fakeRoot({ classes: ['bubble', 'unselected'] })), false);
eq('未勾选的 checkbox -> 未选中', T.isMessageSelected(fakeRoot({ boxes: [{ classList: { contains: () => false } }] })), false);
eq('null 安全', T.isMessageSelected(null), false);


// ------------------------- 选中计数：跨虚拟化累积（75+ 张的那个 bug）

console.log('\n[12] 选中快照累积与计数');
const mkSel = (n, kind) => ({ key: 'sel|' + n, kind: kind || 'photo', status: 'idle', src: 'blob:s' + n, msgId: 'm' + Math.floor(n / 3) });

// 模拟：用户分批勾选 75 张，每次只有一部分消息在 DOM 里可见
const all75 = Array.from({ length: 75 }, (_, i) => mkSel(i));
const store = new Map();
const msgs = new Set();
T.mergeSelectionSnapshot(store, all75.slice(0, 20), msgs);
eq('只看到 20 张时先记 20 张', T.countSelection(store, {}).total, 20);
T.mergeSelectionSnapshot(store, all75.slice(20, 50), msgs);
T.mergeSelectionSnapshot(store, all75.slice(50), msgs);
eq('累积到 75 张（而不是只剩可见的几张）', T.countSelection(store, {}).total, 75);
eq('重复并入不会重复计数', T.mergeSelectionSnapshot(store, all75.slice(0, 20), msgs), 0);
eq('去重后仍是 75', store.size, 75);
eq('统计到了消息条数', msgs.size, 25);

// 关键回归：全部滚出视口（当前可见 0 张）后，计数不应该回退
T.mergeSelectionSnapshot(store, [], msgs);
eq('滚出屏幕后计数不回退', T.countSelection(store, {}).total, 75);

// 视频按开关计入
const mixed = new Map();
T.mergeSelectionSnapshot(mixed, [mkSel(1), mkSel(2), mkSel(3, 'video'), mkSel(4, 'video')]);
eq('默认只算图片', T.countSelection(mixed, {}).total, 2);
eq('开启后图片+视频', T.countSelection(mixed, { includeVideos: true }).total, 4);
eq('视频数量单独可读', T.countSelection(mixed, {}).videos, 2);
eq('非法条目被忽略', T.mergeSelectionSnapshot(new Map(), [null, {}, { key: '' }, mkSel(9)]), 1);
eq('空快照计数为 0', T.countSelection(new Map(), {}).total, 0);


// ------------------------------------- 选中内容里图片 / 视频的挑选取舍

console.log('\n[13] pickSelectionDownloadItems（视频能不能下）');
const sel = new Map();
[T_sel(1), T_sel(2), T_sel(3), T_sel(4, 'video'), T_sel(5, 'video')].forEach((it) => sel.set(it.key, it));
function T_sel(n, kind) {
  return { key: 'v|' + n, kind: kind || 'photo', status: 'idle', src: 'blob:v' + n };
}
eq('默认只图片（视频不下）', T.pickSelectionDownloadItems(sel, {}).length, 3);
eq('开启包含视频 -> 图片+视频', T.pickSelectionDownloadItems(sel, { includeVideos: true }).length, 5);
eq('只要视频 -> 2 个', T.pickSelectionDownloadItems(sel, { videosOnly: true }).length, 2);
eq('只要视频时不含图片', T.pickSelectionDownloadItems(sel, { videosOnly: true }).every((it) => it.kind === 'video'), true);
eq('没有 src 的条目会被跳过', T.pickSelectionDownloadItems(new Map([['x', { key: 'x', kind: 'photo', src: '' }]]), {}).length, 0);
eq('空快照安全', T.pickSelectionDownloadItems(new Map(), {}).length, 0);


// ------------------------------------- 列表里的「已选择」提示文案

console.log('\n[14] selectionSummary（列表选中提示）');
eq('没选时提示「未选择」', T.selectionSummary(0, 30, 30).chip, '未选择');
eq('没选时按钮不带数字', T.selectionSummary(0, 30, 30).button, '下载选中');
eq('选了 3 项', T.selectionSummary(3, 30, 30).chip, '已选择 3 项');
eq('按钮带数量', T.selectionSummary(3, 30, 30).button, '下载选中 (3)');
eq('计数文案', T.selectionSummary(3, 30, 30).count, '30 / 30 项');
eq('大数量也对', T.selectionSummary(75, 12, 100).button, '下载选中 (75)');
eq('行内字样', T.SEL_CHIP_TEXT, '已选择');
eq('行内字样在选中时非空', T.selectionSummary(2, 5, 9).row, '已选择');
eq('行内字样在未选时为空', T.selectionSummary(0, 5, 9).row, '');
eq('非法输入按 0 处理', T.selectionSummary(NaN, undefined, null).chip, '未选择');


// ------------------------------------------------- 后台脚本：下载路径清洗

console.log('\n[15] background.sanitizeDownloadPath');
const bgSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'background.js'), 'utf8');
const bgCtx = {
  console, setTimeout, clearTimeout, Promise, Object, Array, String, Number, JSON, Date, Error, Math,
  chrome: {
    runtime: { onMessage: { addListener: noop }, onInstalled: { addListener: noop } },
    downloads: { onChanged: { addListener: noop }, download: async () => 1 },
    tabs: { sendMessage: async () => {} },
    contextMenus: { create: noop, onClicked: { addListener: noop } },
  },
};
bgCtx.globalThis = bgCtx;
vm.createContext(bgCtx);
vm.runInContext(bgSource + '\nglobalThis.__BG_TEST__ = { sanitizeDownloadPath };\n', bgCtx, { filename: 'background.js' });
const B = bgCtx.__BG_TEST__;
if (!B) throw new Error('background.js 导出失败');

const sane = B.sanitizeDownloadPath;
eq('正常中文路径原样保留', sane('Telegram/设计群/20240513_007.jpg'), 'Telegram/设计群/20240513_007.jpg');
eq('上级目录被替换为下划线（不会穿越）', sane('../../etc/passwd'), '_/_/etc/passwd');
eq('去掉绝对路径前缀', sane('/abs/path.jpg'), 'abs/path.jpg');
eq('Windows 反斜杠', sane('a\\b.jpg'), 'a/b.jpg');
eq('冒号被替换', sane('C:/x.jpg'), 'C_/x.jpg');
eq('问号被替换', sane('name?.jpg'), 'name_.jpg');
eq('纯 .. 退化为空', sane('..'), '_');
ok('超长路径被截断到 240 以内', sane('d/'.repeat(200) + 'f.jpg').length <= 240);
ok('空输入返回空', sane('') === '' && sane(null) === '');

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
