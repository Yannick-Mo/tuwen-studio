/**
 * 软字幕：成片里已经把字幕烧进画面了，但很多平台还允许/要求单独传一份 SRT
 * （YouTube 的字幕轨、B 站的字幕投稿、抖音的「智能字幕」对照）。
 *
 * 时间戳直接用 project.json 里已经排好的那份——和画面上的字幕是同一份数据，
 * 不存在「软字幕和硬字幕对不上」的问题。
 */

/** 秒 → SRT 时间戳 hh:mm:ss,mmm */
function stamp(sec) {
  const ms = Math.max(0, Math.round(Number(sec) * 1000));
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor((ms % 3600000) / 60000))}:${p(Math.floor((ms % 60000) / 1000))},${p(ms % 1000, 3)}`;
}

/**
 * @returns SRT 文本；没有可用字幕时返回空串
 */
export function buildSrt(project) {
  const scenes = project.scenes || [];
  const blocks = [];
  let n = 0;
  for (const [i, s] of scenes.entries()) {
    const base = Number(s.start ?? 0);
    // 画面同一时刻只显示「最上面那一镜」的字幕：下一镜一开始，这一镜的字幕就被顶掉了。
    // 不按这个裁，SRT 里的句子会比画面上多停留零点几秒，软硬字幕对不上。
    const nextStart = i + 1 < scenes.length ? Number(scenes[i + 1].start ?? Infinity) : Infinity;
    // 字幕时间是「相对本镜」的，导出去要换算成整条片子的绝对时间
    for (const c of s.captions || []) {
      const text = String(c.text || '').trim();
      if (!text) continue;
      let a = base + Number(c.start ?? 0);
      let b = base + Number(c.end ?? (Number(c.start ?? 0) + (s.duration ?? 2)));
      a = Math.max(a, base);
      b = Math.min(b, nextStart);
      if (b - a < 0.01) continue;
      blocks.push(`${++n}\n${stamp(a)} --> ${stamp(b)}\n${text}\n`);
    }
  }
  return blocks.join('\n');
}
