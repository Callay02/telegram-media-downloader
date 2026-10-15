/**
 * Telegram 媒体批量下载器 —— MAIN world 桥接脚本
 *
 * 为什么需要它：
 *  - Telegram Web 的图片/视频是页面自己通过 URL.createObjectURL 生成的 blob: URL，
 *    这类 URL 的解析权限绑定在“创建它的源”（也就是本页面）上。
 *  - 在页面主世界里 fetch 这些 blob，成功率最高；<a download> 点击也必须在这里做，
 *    否则浏览器会因为跨源而把下载变成跳转。
 *  - 对于 MSE（MediaSource）流式视频，fetch 会失败，这里额外提供“实时录制兜底”。
 *
 * 与 content script 之间用 window.postMessage 通信（同一页面内的两个 JS 世界）。
 */
(() => {
  'use strict';

  if (window.__TMD_MAIN__) return;
  window.__TMD_MAIN__ = true;

  const CHANNEL = 'TMD_BRIDGE_V1';
  const HELD_URL_TTL = 20 * 60 * 1000; // 主世界保留 blob URL 的最长时间（下载可能排队很久）
  // Chromium 对 URL 长度有约 2MB 的硬上限（url::kMaxURLChars），data: URL 还要按 4/3 膨胀，
  // 因此二进制上限取 1.25MB；超过就走 blob: URL + <a download> 通道。
  const MAX_DATA_URL_BYTES = Math.floor(1.25 * 1024 * 1024);
  const heldUrls = new Map(); // objectUrl -> timeoutId

  // ---------------------------------------------------------------- 工具函数

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function getNonce() {
    try {
      return document.documentElement.getAttribute('data-tmd-nonce') || '';
    } catch (_) {
      return '';
    }
  }

  function reply(id, payload) {
    try {
      window.postMessage({ ch: CHANNEL, dir: 'res', id, nonce: getNonce(), payload }, '*');
    } catch (err) {
      // payload 里可能有超大字符串，退化成错误响应
      window.postMessage(
        { ch: CHANNEL, dir: 'res', id, nonce: getNonce(), payload: { ok: false, error: 'postMessage 失败: ' + err.message } },
        '*'
      );
    }
  }

  function guessTypeFromUrl(url) {
    const clean = String(url).split('?')[0].split('#')[0];
    const ext = (clean.match(/\.([a-z0-9]{2,5})$/i) || [])[1];
    if (!ext) return '';
    const map = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
      gif: 'image/gif',
      bmp: 'image/bmp',
      avif: 'image/avif',
      mp4: 'video/mp4',
      m4v: 'video/mp4',
      webm: 'video/webm',
      mkv: 'video/x-matroska',
      mov: 'video/quicktime',
      mp3: 'audio/mpeg',
      m4a: 'audio/mp4',
      ogg: 'audio/ogg',
      opus: 'audio/ogg',
      pdf: 'application/pdf',
      zip: 'application/zip',
    };
    return map[ext.toLowerCase()] || '';
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(fr.error || new Error('FileReader error'));
      fr.readAsDataURL(blob);
    });
  }

  function holdUrl(url) {
    const old = heldUrls.get(url);
    if (old) clearTimeout(old);
    heldUrls.set(
      url,
      setTimeout(() => {
        try {
          URL.revokeObjectURL(url);
        } catch (_) {}
        heldUrls.delete(url);
      }, HELD_URL_TTL)
    );
  }

  function releaseUrl(url) {
    const t = heldUrls.get(url);
    if (t) clearTimeout(t);
    heldUrls.delete(url);
    try {
      URL.revokeObjectURL(url);
    } catch (_) {}
  }

  /** 真正触发浏览器下载（必须在本世界执行） */
  function clickDownload(url, filename) {
    try {
      const a = document.createElement('a');
      a.href = url;
      a.setAttribute('download', filename || 'telegram_media_' + Date.now());
      a.rel = 'noopener';
      a.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        try {
          a.remove();
        } catch (_) {}
      }, 2000);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  /** 等视频真正开始播放；超时返回 false */
  async function waitForPlayback(video, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!video.paused && (video.currentTime > 0 || video.readyState >= 2)) return true;
      if (video.error) return false;
      await sleep(200);
    }
    return !video.paused;
  }

  function pickMimeType(candidates) {
    for (const c of candidates) {
      try {
        if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
      } catch (_) {}
    }
    return '';
  }

  // ---------------------------------------------------------------- 命令实现

  /**
   * 探测并取回媒体内容。
   *  - 小文件：转成 data: URL 交给 content script（可走 chrome.downloads，支持目录）
   *  - 大文件：转成主世界的 blob: URL 并“挂住”，由 content script 给出最终文件名后再点击下载
   *  - 视频 fetch 失败（MSE 流）：可选录制兜底
   */
  async function cmdPrepare(args) {
    const {
      url,
      maxDataBytes = MAX_DATA_URL_BYTES,
      allowRecord = true,
      maxRecordSeconds = 600,
      forceBlob = false,
    } = args || {};

    if (!url) return { ok: false, error: '空 URL', code: 'EMPTY_URL' };
    if (!/^(blob:|data:|https?:)/i.test(url)) {
      return { ok: false, error: '不支持的地址类型：' + String(url).slice(0, 32), code: 'BAD_SCHEME' };
    }

    // 不管调用方要求多大，data: 通道一律不超过 URL 长度安全值
    const dataLimit = Math.max(0, Math.min(Number(maxDataBytes) || 0, MAX_DATA_URL_BYTES));

    if (url.startsWith('data:')) {
      return { ok: true, mode: 'data', dataUrl: url, size: approximateDataUrlSize(url), type: guessTypeFromUrl(url) };
    }

    let blob = null;
    let fetchError = null;
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      blob = await res.blob();
    } catch (err) {
      fetchError = err;
    }

    if (blob && blob.size === 0) {
      fetchError = new Error('读到 0 字节内容');
      blob = null;
    }

    if (!blob) {
      const reason = String((fetchError && fetchError.message) || fetchError || 'fetch 失败');

      // 普通 http(s) 资源（部分版本的图片/视频直连 CDN）：页面 fetch 可能被 CORS 拦，
      // 但浏览器的下载器不受 CORS 限制，交给 background 的 chrome.downloads 更稳。
      if (/^https?:/i.test(url)) {
        return {
          ok: true,
          mode: 'remote',
          remoteUrl: url,
          size: 0,
          type: guessTypeFromUrl(url),
          fetchError: reason,
        };
      }

      if (allowRecord && args.isVideo) {
        const rec = await cmdRecord({ src: url, maxSeconds: maxRecordSeconds });
        if (rec.ok) return { ...rec, recordedFallback: true, fetchError: reason };
        return {
          ok: false,
          code: 'FETCH_AND_RECORD_FAILED',
          error: `直接读取失败（${reason}），录制兜底也失败（${rec.error || '未知原因'}）`,
        };
      }
      return {
        ok: false,
        code: 'FETCH_FAILED',
        error:
          `无法直接读取该媒体（${reason}）。` +
          (args.isVideo ? '这通常是 MSE 流式视频，请在设置里开启「视频录制兜底」。' : ''),
      };
    }

    const type = blob.type || guessTypeFromUrl(url) || '';
    if (!forceBlob && blob.size <= dataLimit) {
      try {
        const dataUrl = await blobToDataUrl(blob);
        return { ok: true, mode: 'data', dataUrl, size: blob.size, type };
      } catch (err) {
        return { ok: false, code: 'READ_FAILED', error: '读取内容失败: ' + String((err && err.message) || err) };
      }
    }

    const objectUrl = URL.createObjectURL(blob);
    holdUrl(objectUrl);
    return { ok: true, mode: 'blob', blobUrl: objectUrl, size: blob.size, type, direct: true };
  }

  /**
   * 视频兜底：对正在播放的 <video> 做实时录制（1x 速度，会耗时 = 视频时长）。
   * 适用于 Telegram Web K 用 MediaSource 推流的视频：fetch 拿不到完整文件。
   */
  async function cmdRecord(args) {
    const { src, maxSeconds = 600 } = args || {};
    if (!window.MediaRecorder) return { ok: false, error: '浏览器不支持 MediaRecorder' };

    const videos = Array.from(document.querySelectorAll('video'));
    const video =
      videos.find((v) => v.currentSrc === src || v.src === src) ||
      videos.find((v) => {
        const source = v.querySelector('source');
        return source && (source.src === src || source.getAttribute('src') === src);
      }) ||
      null;

    if (!video) {
      return { ok: false, error: '找不到对应的 <video> 元素（这条消息已滚出可视区、DOM 被页面回收）；滚回该消息附近再重试即可' };
    }

    const prev = {
      muted: video.muted,
      loop: video.loop,
      rate: video.playbackRate,
      paused: video.paused,
      currentTime: video.currentTime,
    };

    let stream = null;
    try {
      stream = video.captureStream ? video.captureStream() : video.mozCaptureStream ? video.mozCaptureStream() : null;
    } catch (err) {
      stream = null;
    }
    if (!stream) {
      restore();
      return { ok: false, error: 'captureStream 不可用' };
    }

    // 有音轨才写 opus，否则某些 Chrome 版本会因为 codec 与轨道不匹配而拒绝创建
    const hasAudio = !!(stream.getAudioTracks && stream.getAudioTracks().length);
    const mimeType = pickMimeType(
      hasAudio
        ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=h264,opus', 'video/webm']
        : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm;codecs=h264', 'video/webm']
    );

    const chunks = [];
    let recorder;
    try {
      recorder = mimeType ? new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 }) : new MediaRecorder(stream);
    } catch (err) {
      restore();
      return { ok: false, error: '无法创建 MediaRecorder: ' + String((err && err.message) || err) };
    }

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };

    const stopped = new Promise((resolve) => {
      recorder.onstop = resolve;
      recorder.onerror = resolve;
    });

    try {
      video.muted = true; // 静音只是为了防止声音外放，captureStream 仍会录到音轨
      video.loop = false;
      video.playbackRate = 1;
      try {
        video.currentTime = 0;
      } catch (_) {}
      recorder.start(1000);
      const playPromise = video.play();
      if (playPromise && playPromise.catch) playPromise.catch(() => {});
    } catch (err) {
      try {
        recorder.stop();
      } catch (_) {}
      restore();
      return { ok: false, error: '开始录制失败: ' + String((err && err.message) || err) };
    }

    // 播放没起来就立刻报错，别让用户白等一整段录制时长
    const playing = await waitForPlayback(video, 6000);
    if (!playing) {
      try {
        recorder.stop();
      } catch (_) {}
      await Promise.race([stopped, sleep(2000)]);
      restore();
      return { ok: false, error: '视频没有开始播放（可能需要先点开这个视频，或它已被页面回收）' };
    }

    const durationMs =
      isFinite(video.duration) && video.duration > 0
        ? Math.min(video.duration * 1000 + 1200, maxSeconds * 1000)
        : maxSeconds * 1000;

    const started = Date.now();
    let onEnded = null;
    const endedPromise = new Promise((resolve) => {
      onEnded = resolve;
      video.addEventListener('ended', resolve, { once: true });
    });
    await Promise.race([endedPromise, sleep(durationMs)]);
    if (onEnded) {
      try {
        video.removeEventListener('ended', onEnded);
      } catch (_) {}
    }

    // 结束前留一点尾巴，避免最后一帧被吞
    await sleep(120);
    try {
      if (recorder.state !== 'inactive') recorder.stop();
    } catch (_) {}
    await Promise.race([stopped, sleep(5000)]);

    const elapsed = Date.now() - started;
    restore();

    const blob = new Blob(chunks, { type: mimeType || 'video/webm' });
    if (!blob.size) return { ok: false, error: '录制结果为空（视频可能未真正开始播放）' };

    const objectUrl = URL.createObjectURL(blob);
    holdUrl(objectUrl);
    return {
      ok: true,
      mode: 'blob',
      blobUrl: objectUrl,
      size: blob.size,
      type: 'video/webm',
      truncated: durationMs >= maxSeconds * 1000 && elapsed >= maxSeconds * 1000 - 500,
    };

    function restore() {
      try {
        video.muted = prev.muted;
        video.loop = prev.loop;
        video.playbackRate = prev.rate;
        video.currentTime = prev.currentTime;
        if (prev.paused) video.pause();
        else {
          const p = video.play();
          if (p && p.catch) p.catch(() => {});
        }
      } catch (_) {}
      if (stream && stream.getTracks) stream.getTracks().forEach((t) => t.stop());
    }
  }

  async function handle(cmd, args) {
    switch (cmd) {
      case 'ping':
        return { ok: true, version: 1, world: 'MAIN' };
      case 'prepare':
        return cmdPrepare(args);
      case 'record':
        return cmdRecord(args);
      case 'download': {
        const { url, filename } = args || {};
        if (!url) return { ok: false, error: '空 URL' };
        return clickDownload(url, filename);
      }
      case 'revoke': {
        if (args && args.url) releaseUrl(args.url);
        return { ok: true };
      }
      default:
        return { ok: false, error: '未知命令: ' + cmd };
    }
  }

  function approximateDataUrlSize(dataUrl) {
    const comma = dataUrl.indexOf(',');
    if (comma < 0) return 0;
    const b64 = dataUrl.length - comma - 1;
    return Math.max(0, Math.floor((b64 * 3) / 4));
  }

  window.addEventListener('message', async (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.ch !== CHANNEL || d.dir !== 'req' || !d.id) return;
    const nonce = getNonce();
    if (!nonce || d.nonce !== nonce) return; // nonce 必须匹配，防止页面脚本伪造请求

    let payload;
    try {
      payload = await handle(d.cmd, d.args);
    } catch (err) {
      payload = { ok: false, error: String((err && err.message) || err), code: 'MAIN_WORLD_EXCEPTION' };
    }
    reply(d.id, payload);
  });

  // 页面卸载时释放所有挂住的 blob URL
  window.addEventListener('pagehide', () => {
    for (const url of Array.from(heldUrls.keys())) releaseUrl(url);
  });
})();
