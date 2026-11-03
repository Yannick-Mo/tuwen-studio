/**
 * edge 配音的纯 Node 实现。
 *
 * 以前这里调的是 Python 的 edge-tts 命令行——那是分发时最难受的一个依赖：
 * 用户得先装 Python、再 pip install edge-tts，装错了版本还会 403。
 * 这个文件和 CLI 版走的是同一个微软接口、同一个音色表、同一种 mp3，
 * 但它只需要 npm install，而且顺带把词级时间戳也拿回来了（卡拉OK 字幕靠它）。
 */
import fs from 'node:fs/promises';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

export class EdgeJSError extends Error {
  constructor(message, code = 'network') {
    super(message);
    this.name = 'EdgeJSError';
    this.code = code;
  }
}

/**
 * msedge-tts 的元数据块 → 本地词级时间戳。
 * Offset / Duration 的单位是 100 纳秒，除以 1e7 得到秒。
 */
export function parseWordBoundaries(chunks) {
  const words = [];
  for (const raw of chunks) {
    let doc;
    try { doc = JSON.parse(String(raw)); } catch { continue; }
    for (const m of doc?.Metadata || []) {
      if (m?.Type !== 'WordBoundary') continue;
      const d = m.Data || {};
      const text = d.text?.Text ?? '';
      if (!text) continue;
      const start = Number(d.Offset || 0) / 1e7;
      words.push({ w: text, start, end: start + Number(d.Duration || 0) / 1e7 });
    }
  }
  return words.length ? words : null;
}

/**
 * 合成一句，写到 outFile（mp3）。
 * @returns {{buffer: Buffer, words: Array<{w,start,end}>|null}}
 */
export async function synthesizeEdge({
  text, voice, rate = '+0%', pitch = '+0Hz', outFile, timeoutMs = 120_000,
}) {
  if (!text || !String(text).trim()) throw new EdgeJSError('要合成的文本是空的', 'input');
  if (!voice) throw new EdgeJSError('没有指定音色', 'input');

  const tts = new MsEdgeTTS();
  const meta = [];
  try {
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, { wordBoundaryEnabled: true });
    const { audioStream, metadataStream } = tts.toStream(String(text), { rate, pitch });
    metadataStream?.on('data', (c) => meta.push(c));

    const chunks = [];
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new EdgeJSError(`合成超时（${Math.round(timeoutMs / 1000)}s）`, 'timeout')), timeoutMs);
      audioStream.on('data', (c) => chunks.push(c));
      audioStream.on('end', () => { clearTimeout(timer); resolve(); });
      audioStream.on('error', (e) => {
        clearTimeout(timer);
        reject(new EdgeJSError(e?.message || '音频流中断', 'network'));
      });
    });

    // 词级时间戳偶尔比音频晚几十毫秒到齐，稍等一下再解析，否则字幕会缺最后几个字
    await new Promise((r) => setTimeout(r, 80));

    const buffer = Buffer.concat(chunks);
    if (buffer.length < 2048) throw new EdgeJSError(`音频过小（${buffer.length}B）`, 'empty');
    await fs.writeFile(outFile, buffer);
    return { buffer, words: parseWordBoundaries(meta) };
  } finally {
    try { tts.close(); } catch { /* 已经关了就算了 */ }
  }
}

/** 能不能用：模块装上了就算能用（真正的网络问题在合成时才暴露） */
export async function edgeJSAvailable() {
  try {
    const { MsEdgeTTS: K } = await import('msedge-tts');
    return typeof K === 'function';
  } catch {
    return false;
  }
}
