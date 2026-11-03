/**
 * 火山 Seed Audio 1.0：能听懂「带着疲惫说道」这类描述的语音合成。
 * 和 edge 的区别不是音质，是「能不能演」——但也正因为它是生成式的，
 * 同一句话重跑结果会变，所以它只能整条用，不能逐句混着用。
 */
import { loadEnv } from '../util.js';

const ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/create';

export class VolcTTSUnavailable extends Error {
  constructor(message, code = 'unavailable') {
    super(message);
    this.name = 'VolcTTSUnavailable';
    this.code = code;
  }
}

export function volcAvailable(env = loadEnv()) {
  return !!(env.VOLC_TTS_APP_ID && env.VOLC_TTS_ACCESS_TOKEN);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 合成一段。prompt 是完整的「表演提示 + 台词」，由调用方拼好。
 * 返回 { buffer, duration, words, format }。
 */
export async function synthesizeVolc({
  prompt,
  references = null,
  env = loadEnv(),
  format = 'mp3',
  sampleRate = 48000,
  speechRate = 0,
  pitchRate = 0,
  loudnessRate = 0,
  timeoutMs = 180_000,
} = {}) {
  if (!volcAvailable(env)) {
    throw new VolcTTSUnavailable('没有配置 VOLC_TTS_APP_ID / VOLC_TTS_ACCESS_TOKEN', 'auth');
  }
  if (!prompt || !String(prompt).trim()) {
    throw new VolcTTSUnavailable('text_prompt 为空', 'input');
  }

  const body = {
    model: env.VOLC_TTS_MODEL || 'seed-audio-1.0',
    text_prompt: String(prompt).slice(0, 3000),
    audio_config: {
      format,
      sample_rate: sampleRate,
      speech_rate: speechRate,
      pitch_rate: pitchRate,
      loudness_rate: loudnessRate,
    },
    watermark: {},
  };
  // 参考音频用来钉住音色：不给的话每次调用会挑不同的嗓子
  if (references && references.length) {
    body.references = references.slice(0, 3).map((b64) => ({ audio_data: b64 }));
  }

  const headers = {
    'Content-Type': 'application/json',
    'X-Api-App-Id': env.VOLC_TTS_APP_ID,
    'X-Api-Access-Key': env.VOLC_TTS_ACCESS_TOKEN,
    'X-Api-Request-Id': crypto.randomUUID(),
  };

  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.status === 429) throw new VolcTTSUnavailable('限流 429', 'quota');
      if (res.status === 401 || res.status === 403) {
        throw new VolcTTSUnavailable(`鉴权失败 ${res.status}`, 'auth');
      }
      if (!res.ok) throw new VolcTTSUnavailable(`HTTP ${res.status}`, 'network');

      const json = await res.json();
      const code = json.code;
      if (code !== undefined && code !== null && Number(code) !== 0) {
        const msg = String(json.message || '');
        const quota = /quota|limit|balance|额度/i.test(msg) || Number(code) === 45;
        throw new VolcTTSUnavailable(`code=${code} ${msg.slice(0, 160)}`, quota ? 'quota' : 'api');
      }
      const b64 = json.audio || json.data;
      if (!b64) throw new VolcTTSUnavailable('返回里没有音频数据', 'empty');

      const buffer = Buffer.from(b64, 'base64');
      if (buffer.length < 2048) throw new VolcTTSUnavailable(`音频过小 ${buffer.length}B`, 'empty');

      return {
        buffer,
        duration: Number(json.duration || json.original_duration || 0),
        words: mapWords(json.subtitle),
        format,
      };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (e instanceof VolcTTSUnavailable && (e.code === 'auth' || e.code === 'input')) throw e;
      if (attempt < 2) await sleep(800 * (attempt + 1) + Math.random() * 400);
    }
  }
  throw lastErr || new VolcTTSUnavailable('未知错误');
}

/** 把返回的字幕转成本地词级时间戳结构（毫秒 → 秒） */
function mapWords(subtitle) {
  const words = [];
  for (const s of subtitle?.sentences || []) {
    for (const w of s.words || []) {
      if (!w.text) continue;
      words.push({
        w: w.text,
        start: Number(w.start_time || 0) / 1000,
        end: Number(w.end_time || 0) / 1000,
      });
    }
  }
  return words.length ? words : null;
}

/**
 * 把「表演提示」和「台词」拼成 text_prompt。
 * 没有提示就纯念，和普通 TTS 一样。
 */
export function buildVolcPrompt({ performance, text }) {
  const t = String(text || '').trim();
  if (!performance) return t;
  const p = String(performance).trim();
  return p.includes('“') || p.includes('"') ? `${p}${t}` : `${p}说道：“${t}”`;
}
