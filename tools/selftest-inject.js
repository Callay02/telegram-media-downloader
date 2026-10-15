#!/usr/bin/env node
/**
 * 离线自测 2：用 Node 里的最小 DOM / fetch / Blob 桩加载 inject.js，
 * 验证「主世界下载决策树」——这是整个扩展最容易出错的部分。
 *
 * 用法：node tools/selftest-inject.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILE = path.join(__dirname, '..', 'src', 'inject.js');
const source = fs.readFileSync(FILE, 'utf8');
const cut = source.lastIndexOf('})();');
if (cut < 0) throw new Error('找不到 inject.js 的 IIFE 结尾');
const instrumented =
  source.slice(0, cut) +
  '\n  globalThis.__INJ_TEST__ = { cmdPrepare, cmdRecord, clickDownload, releaseUrl, approximateDataUrlSize, guessTypeFromUrl };\n' +
  source.slice(cut);

// ------------------------------------------------------------------ 桩环境

const noop = () => {};
const created = [];
const revoked = [];
const clicks = [];

let fetchImpl = async () => {
  throw new Error('fetch 不可用');
};

const anchor = () => ({
  style: {},
  attrs: {},
  setAttribute(k, v) {
    this.attrs[k] = v;
  },
  click() {
    clicks.push({ href: this.href, download: this.attrs.download });
  },
  remove: noop,
});

const ctx = {
  console,
  setTimeout,
  clearTimeout,
  Promise,
  Object,
  Array,
  String,
  Number,
  Math,
  Date,
  JSON,
  Error,
  isFinite,
  Blob: class {
    constructor(parts, opts) {
      const options = opts || {};
      this.parts = parts || [];
      this.type = options.type || '';
      this.size =
        options.size !== undefined
          ? options.size
          : this.parts.reduce((n, p) => n + (p && p.size ? p.size : 0), 0);
    }
  },
  FileReader: class {
    readAsDataURL(blob) {
      this.result = 'data:' + (blob.type || 'application/octet-stream') + ';base64,QUJD';
      setTimeout(() => this.onload && this.onload(), 0);
    }
  },
  URL: {
    createObjectURL(blob) {
      created.push(blob);
      return 'blob:https://web.telegram.org/fake-' + created.length;
    },
    revokeObjectURL(url) {
      revoked.push(url);
    },
  },
  MediaRecorder: class {
    static isTypeSupported() {
      return true;
    }
  },
  fetch: (...args) => fetchImpl(...args),
  location: { origin: 'https://web.telegram.org' },
  document: {
    documentElement: { getAttribute: () => null },
    body: { appendChild: noop, removeChild: noop },
    createElement: (tag) => (tag === 'a' ? anchor() : { style: {}, appendChild: noop, remove: noop }),
    querySelectorAll: () => [],
  },
  addEventListener: noop,
  removeEventListener: noop,
  postMessage: noop,
};
ctx.window = ctx;
ctx.globalThis = ctx;
ctx.top = ctx;
vm.createContext(ctx);
vm.runInContext(instrumented, ctx, { filename: 'inject.js' });

const T = ctx.__INJ_TEST__;
if (!T) throw new Error('导出失败：__INJ_TEST__ 未定义');

// ------------------------------------------------------------------ 断言

let pass = 0;
let fail = 0;
function eq(label, actual, expected) {
  if (actual === expected) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}\n      期望: ${JSON.stringify(expected)}\n      实际: ${JSON.stringify(actual)}`);
  }
}
function ok(label, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`);
  }
}
const blobResponse = (size, type) => async () => ({ ok: true, status: 200, blob: async () => new ctx.Blob([], { size, type }) });

(async () => {
  console.log('\n[1] fetch 成功 + 小文件 -> data URL 通道（可带子目录）');
  fetchImpl = blobResponse(1000, 'image/jpeg');
  let r = await T.cmdPrepare({ url: 'blob:https://web.telegram.org/x', maxDataBytes: 4096 });
  eq('mode', r.mode, 'data');
  eq('size', r.size, 1000);
  eq('type', r.type, 'image/jpeg');
  ok('产出 data: URL', String(r.dataUrl).startsWith('data:image/jpeg;base64,'), r.dataUrl);

  console.log('\n[2] fetch 成功 + 大文件 -> 主世界 blob URL 通道');
  fetchImpl = blobResponse(9000, 'video/mp4');
  r = await T.cmdPrepare({ url: 'blob:https://web.telegram.org/y', maxDataBytes: 4096, isVideo: true });
  eq('mode', r.mode, 'blob');
  eq('size', r.size, 9000);
  ok('挂住了新的 blob URL', String(r.blobUrl).startsWith('blob:https://web.telegram.org/fake-'), r.blobUrl);

  console.log('\n[2b] 回归：即使阈值开到 8MB，data URL 也不许超过 Chromium 的 URL 上限');
  fetchImpl = blobResponse(5 * 1024 * 1024, 'video/mp4');
  r = await T.cmdPrepare({ url: 'blob:https://web.telegram.org/big', maxDataBytes: 8 * 1024 * 1024, isVideo: true });
  eq('5MB 内容不走 data 通道', r.mode, 'blob');
  fetchImpl = blobResponse(Math.floor(1.2 * 1024 * 1024), 'image/jpeg');
  r = await T.cmdPrepare({ url: 'blob:https://web.telegram.org/mid', maxDataBytes: 8 * 1024 * 1024 });
  eq('1.2MB 内容仍走 data 通道', r.mode, 'data');
  ok('data URL 字符数 < 2MB', String(r.dataUrl).length < 2 * 1024 * 1024, String(r.dataUrl).length);
  fetchImpl = blobResponse(1300 * 1024, 'image/jpeg');
  r = await T.cmdPrepare({ url: 'blob:https://web.telegram.org/over', maxDataBytes: 8 * 1024 * 1024 });
  eq('1.27MB 内容被拦到 blob 通道', r.mode, 'blob');

  console.log('\n[3] forceBlob（阈值填 0）-> 一律走 blob 通道');
  fetchImpl = blobResponse(10, 'image/png');
  r = await T.cmdPrepare({ url: 'blob:z', maxDataBytes: 0, forceBlob: true });
  eq('mode', r.mode, 'blob');

  console.log('\n[4] fetch 失败 + http(s) 直链 -> 交给浏览器下载器（绕开 CORS）');
  fetchImpl = async () => {
    throw new TypeError('Failed to fetch');
  };
  r = await T.cmdPrepare({ url: 'https://cdn.example.com/a/b/video.mp4', isVideo: true });
  eq('mode', r.mode, 'remote');
  eq('remoteUrl', r.remoteUrl, 'https://cdn.example.com/a/b/video.mp4');
  eq('顺带推断扩展名', T.guessTypeFromUrl(r.remoteUrl), 'video/mp4');

  console.log('\n[5] fetch 失败 + blob 视频 + 录制兜底（找不到 video 元素）');
  r = await T.cmdPrepare({ url: 'blob:https://web.telegram.org/mse', isVideo: true, allowRecord: true });
  eq('失败码', r.code, 'FETCH_AND_RECORD_FAILED');
  ok('错误信息里同时体现两个原因', /直接读取失败/.test(r.error) && /video/.test(r.error), r.error);

  console.log('\n[6] fetch 失败 + blob 图片 -> 明确报错而不是静默失败');
  r = await T.cmdPrepare({ url: 'blob:https://web.telegram.org/img', isVideo: false, allowRecord: true });
  eq('失败码', r.code, 'FETCH_FAILED');
  ok('提示是 MSE 场景', /MSE/.test(r.error) === false, r.error);

  console.log('\n[7] 0 字节内容视为失败');
  fetchImpl = blobResponse(0, 'image/jpeg');
  r = await T.cmdPrepare({ url: 'blob:https://web.telegram.org/empty', isVideo: false });
  eq('失败码', r.code, 'FETCH_FAILED');
  ok('原因是 0 字节', /0 字节/.test(r.error), r.error);

  console.log('\n[8] 视频 fetch 失败时的提示文案');
  fetchImpl = async () => {
    throw new Error('Failed to fetch');
  };
  r = await T.cmdPrepare({ url: 'blob:https://web.telegram.org/mse2', isVideo: true, allowRecord: false });
  ok('提示开启录制兜底', /录制兜底/.test(r.error), r.error);

  console.log('\n[9] data: URL 直接透传');
  r = await T.cmdPrepare({ url: 'data:image/png;base64,' + 'A'.repeat(400) });
  eq('mode', r.mode, 'data');
  ok('体积估算合理', r.size > 250 && r.size < 320, r.size);
  eq('体积估算函数', T.approximateDataUrlSize('data:image/png;base64,QUJD'), 3);

  console.log('\n[10] 下载与释放');
  clicks.length = 0;
  revoked.length = 0;
  r = await T.clickDownload('blob:https://web.telegram.org/fake-1', '中文 名字.jpg');
  eq('点击成功', r.ok, true);
  eq('触发了一次下载', clicks.length, 1);
  eq('download 属性正确', clicks[0].download, '中文 名字.jpg');
  eq('href 正确', clicks[0].href, 'blob:https://web.telegram.org/fake-1');
  r = await T.releaseUrl('blob:https://web.telegram.org/fake-1');
  eq('释放了 blob URL', revoked.pop(), 'blob:https://web.telegram.org/fake-1');

  console.log('\n[11] 空 URL 防御');
  r = await T.cmdPrepare({ url: '' });
  eq('空 URL 码', r.code, 'EMPTY_URL');

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})();
