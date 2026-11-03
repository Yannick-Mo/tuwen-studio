/**
 * 配置：谁在哪儿配、配了什么、怎么安全地写回去。
 *
 * 一条硬规矩：**API Key 不经过对话**。
 * 模型永远不该看见 key，所以没有「让 agent 帮你填 key」这种工具——
 * 人自己在本机页面（tuwen setup，监听 127.0.0.1）里填，直接落盘。
 * 这里只负责读写那个文件，以及告诉别人「配没配」，从不回显明文。
 */
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ensureDir, loadEnv, reloadEnv, CONFIG_DIR, USER_ENV_FILE, REPO_ENV_FILE } from './util.js';

/** 允许写进配置文件的键。不在这个表里的一律拒绝，免得被塞进奇怪的东西。 */
export const KEY_SPECS = [
  {
    key: 'ARK_API_KEY', group: '图像（火山方舟）', label: 'API Key', secret: true, required: false,
    hint: '方舟控制台 → API Key。不填也能出片，但画面是占位图，不算成品。',
  },
  {
    key: 'ARK_BASE_URL', group: '图像（火山方舟）', label: '接口地址', secret: false,
    fallback: 'https://ark.cn-beijing.volces.com/api/v3', hint: '一般不用改。',
  },
  {
    key: 'ARK_IMAGE_MODEL', group: '图像（火山方舟）', label: '出图模型', secret: false,
    fallback: 'doubao-seedream-4-5-251128', hint: '方舟上可用的图片模型名。',
  },
  {
    key: 'ARK_IMAGE_SIZE', group: '图像（火山方舟）', label: '出图尺寸', secret: false,
    fallback: '1440x2560', hint: '只对 9:16 生效；16:9 会按比例自动换成 2560x1440。',
  },
  {
    key: 'VOLC_TTS_APP_ID', group: '配音（火山语音，可选）', label: 'App ID', secret: false,
    hint: '只在想用「会演」的 volc 配音时填。留空就用免费的 edge。',
  },
  { key: 'VOLC_TTS_ACCESS_TOKEN', group: '配音（火山语音，可选）', label: 'Access Token', secret: true },
  { key: 'VOLC_TTS_SECRET_KEY', group: '配音（火山语音，可选）', label: 'Secret Key', secret: true },
  {
    key: 'VOLC_TTS_MODEL', group: '配音（火山语音，可选）', label: '模型名', secret: false,
    fallback: 'seed-audio-1.0',
  },
  {
    key: 'FFMPEG_PATH', group: '高级', label: 'ffmpeg 路径', secret: false,
    hint: '留空就用随包安装的 ffmpeg-static；填了就用你指定的。',
  },
  {
    key: 'FFPROBE_PATH', group: '高级', label: 'ffprobe 路径', secret: false,
    hint: '留空就用随包安装的 ffprobe-static。',
  },
];

const SPEC_BY_KEY = new Map(KEY_SPECS.map((s) => [s.key, s]));

/** 只留前 4 位和后 4 位，中间打码。本来就短的直接全打码。 */
export function mask(value) {
  const v = String(value || '');
  if (!v) return '';
  if (v.length <= 10) return '••••••';
  return `${v.slice(0, 4)}••••${v.slice(-4)}`;
}

function parseEnvText(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i < 0) continue;
    out[s.slice(0, i).trim()] = s.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * 当前生效的配置从哪来：进程环境优先，其次用户级文件，最后仓库里的 .env。
 * 返回的每一项都带来源，方便 doctor 说清「你填的这个为什么没生效」。
 */
export function readConfig() {
  const env = loadEnv();
  const user = existsSync(USER_ENV_FILE) ? parseEnvText(readFileSync(USER_ENV_FILE, 'utf8')) : {};
  const repo = existsSync(REPO_ENV_FILE) ? parseEnvText(readFileSync(REPO_ENV_FILE, 'utf8')) : {};
  const rows = KEY_SPECS.map((spec) => {
    const fromProc = process.env[spec.key];
    const fromUser = user[spec.key];
    const fromRepo = repo[spec.key];
    const value = env[spec.key] || spec.fallback || '';
    const source = fromProc ? 'env'
      : fromUser ? 'user'
        : fromRepo ? 'repo'
          : spec.fallback ? 'default' : 'none';
    return {
      ...spec,
      set: Boolean(value),
      source,
      // 明文只给「写回」逻辑用，页面和 doctor 只看 masked
      masked: spec.secret ? mask(value) : value,
      plain: value,
    };
  });
  return {
    file: USER_ENV_FILE,
    repoFile: REPO_ENV_FILE,
    exists: existsSync(USER_ENV_FILE),
    rows,
  };
}

/**
 * 写用户级配置。只接受白名单里的键；空字符串表示「删掉这一项」，
 * 这样页面上清空就真的是清空，不会留一个空值把默认值顶掉。
 */
export async function writeConfig(patch) {
  const current = existsSync(USER_ENV_FILE) ? parseEnvText(readFileSync(USER_ENV_FILE, 'utf8')) : {};
  const next = { ...current };

  for (const [k, v] of Object.entries(patch || {})) {
    if (!SPEC_BY_KEY.has(k)) throw new Error(`不认识的配置项：${k}`);
    const val = String(v ?? '').trim();
    if (!val) delete next[k];
    else next[k] = val;
  }

  const lines = [
    '# 图文视频工坊 · 本机配置',
    '# 由 `tuwen setup` 的配置页写入。别把这个文件发给人、别提交进仓库。',
    `# 位置：${USER_ENV_FILE}`,
    '',
  ];
  for (const spec of KEY_SPECS) {
    if (!(spec.key in next)) continue;
    lines.push(`# ${spec.group} · ${spec.label}`);
    lines.push(`${spec.key}=${next[spec.key]}`);
    lines.push('');
  }

  await ensureDir(CONFIG_DIR);
  await fs.writeFile(USER_ENV_FILE, lines.join('\n'), { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(USER_ENV_FILE, 0o600).catch(() => { /* Windows 上不一定支持 */ });
  reloadEnv();
  return { file: USER_ENV_FILE, written: Object.keys(next).length };
}

/** 给 doctor 用：哪些关键项配了、哪些没配 */
export function configSummary() {
  const cfg = readConfig();
  const hasArk = Boolean(cfg.rows.find((r) => r.key === 'ARK_API_KEY')?.plain);
  const hasVolc = Boolean(cfg.rows.find((r) => r.key === 'VOLC_TTS_APP_ID')?.plain)
    && Boolean(cfg.rows.find((r) => r.key === 'VOLC_TTS_ACCESS_TOKEN')?.plain);
  return { cfg, hasArk, hasVolc };
}
