/**
 * 图像 provider：火山方舟 Seedream。
 * 只依赖 fetch，不引 SDK；错误按「配额 / 鉴权 / 内容 / 网络」分类，
 * 因为它们的处置方式完全不同——配额要停，内容要改词，网络要重试。
 */

export class ImageError extends Error {
  constructor(message, { code = 'unknown', retryable = false, detail = '' } = {}) {
    super(message);
    this.name = 'ImageError';
    this.code = code;
    this.retryable = retryable;
    this.detail = detail;
  }
}

function classify(status, payload) {
  const code = payload?.error?.code || '';
  const msg = payload?.error?.message || '';
  if (status === 429 || code === 'SetLimitExceeded') {
    return new ImageError(`方舟配额已用尽：${msg || 'SetLimitExceeded'}`, { code: 'quota', retryable: false, detail: msg });
  }
  if (status === 401 || status === 403 || /Authentication|Unauthorized/i.test(code)) {
    return new ImageError(`方舟鉴权失败：${msg || code}`, { code: 'auth', retryable: false, detail: msg });
  }
  if (status === 400 || /Sensitive|Policy|InvalidParameter/i.test(code)) {
    return new ImageError(`方舟拒绝了这个请求：${msg || code}`, { code: 'content', retryable: false, detail: msg });
  }
  return new ImageError(`方舟返回 ${status}：${msg || code}`, { code: 'network', retryable: status >= 500, detail: msg });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postOnce({ apiKey, baseURL, model, prompt, size, seed, image }) {
  const body = { model, prompt, size, response_format: 'url', watermark: false };
  if (seed != null) body.seed = seed;
  // 参考图：data URL 或公网 URL 都接受，数组形式
  if (image && image.length) body.image = image;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120_000);
  let res;
  try {
    res = await fetch(`${baseURL}/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new ImageError(`方舟连接失败：${e.message}`, { code: 'network', retryable: true });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
  if (!res.ok || !json) throw classify(res.status, json);

  const item = json.data?.[0];
  if (!item) throw new ImageError('方舟返回了空结果', { code: 'unknown', retryable: true });

  // url 优先；有的模型直接给 b64
  if (item.url) {
    const img = await fetch(item.url);
    if (!img.ok) throw new ImageError(`下载生成图失败 ${img.status}`, { code: 'network', retryable: true });
    return { buffer: Buffer.from(await img.arrayBuffer()), meta: { model, size, seed, revise: json.usage || null } };
  }
  if (item.b64_json) {
    return { buffer: Buffer.from(item.b64_json, 'base64'), meta: { model, size, seed } };
  }
  throw new ImageError('方舟结果里既没有 url 也没有 b64_json', { code: 'unknown', retryable: true });
}

/**
 * 尺寸降级：模型不一定接受任意分辨率，
 * 先按项目要的尺寸要，被拒就退到 2K，再退到 1024x1024（再靠 object-fit 裁）。
 */
export async function generateArk({ apiKey, baseURL, model, prompt, size = '1080x1920', seed, image }) {
  const sizes = [size, '2K'].filter((s, i, a) => s && a.indexOf(s) === i);
  let lastErr = null;
  for (const s of sizes) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const out = await postOnce({ apiKey, baseURL, model, prompt, size: s, seed, image });
        return { ...out, meta: { ...out.meta, size: s } };
      } catch (e) {
        lastErr = e;
        if (!e.retryable) {
          // 尺寸不被支持时换下一档；配额/鉴权直接抛
          if (/size|resolution|InvalidParameter/i.test(e.detail || '') && s !== sizes.at(-1)) break;
          throw e;
        }
        await sleep(1200 * (attempt + 1));
      }
    }
  }
  throw lastErr;
}

export function arkAvailable(env) {
  return Boolean(env.ARK_API_KEY && env.ARK_BASE_URL && env.ARK_IMAGE_MODEL);
}
