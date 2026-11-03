/**
 * 语气曲线：一条片子默认就该有起伏，不该整片一个语速。
 *
 * 这里只算「相对基准的增量」，不碰绝对数值——因为基准可能是项目嗓子，
 * 也可能是某个角色自己的嗓子，两者语速本来就不一样。
 *
 * 曲线很朴素：开头压住 → 中段走 → 倒数第二镜推进 → 最后一镜收。
 * 句子里带感叹号、又不是收尾镜的，当爆点处理。
 */

const DELTAS = {
  open: { dRate: -4, dPitch: -2 },
  build: { dRate: 6, dPitch: 1 },
  punch: { dRate: 6, dPitch: 2 },
  close: { dRate: -6, dPitch: 0 },
};

export const DELIVERY_LABELS = {
  open: '开场压住',
  build: '推进',
  punch: '爆点',
  close: '收尾',
};

/** 返回每镜的增量（无调整的镜头是 null） */
export function autoDeltas(scenes, { enabled = true } = {}) {
  const n = scenes.length;
  if (!enabled || n < 3) return scenes.map(() => null);

  return scenes.map((s, i) => {
    const text = s.narration || '';
    let kind = null;

    if (i === 0) kind = 'open';
    else if (i === n - 1) kind = 'close';
    else if (i === n - 2) kind = 'build';

    if (/[！!]/.test(text) && i < n - 1) kind = 'punch';
    if (!kind) return null;

    return { ...DELTAS[kind], delivery: kind };
  });
}

/** 把增量叠到某一把嗓子上，得到这一镜最终的发音参数 */
export function composeVoice(base, delta) {
  if (!delta) return null;
  const baseRate = Number.parseInt(base?.rate ?? '0', 10) || 0;
  const basePitch = Number.parseInt(base?.pitch ?? '0', 10) || 0;
  const rate = baseRate + delta.dRate;
  const pitch = basePitch + delta.dPitch;
  const sign = (v, unit) => `${v >= 0 ? '+' : ''}${v}${unit}`;
  return { rate: sign(rate, '%'), pitch: sign(pitch, 'Hz'), delivery: delta.delivery };
}

/**
 * 对白之间的留白：换人说话要给观众反应时间，同一个声音接话不用。
 * 只对有 speaker 标记的镜头生效——纯旁白片子完全不受影响，行为跟以前一模一样。
 * 返回 null 表示「按默认值来」。
 */
export function autoPauses(scenes) {
  return scenes.map((s, i) => {
    if (i === 0) return null;
    const prev = scenes[i - 1];
    const a = prev.speaker || null;
    const b = s.speaker || null;
    if (a === b) return a ? 0.15 : null;   // 同一人连说 / 旁白接旁白：压紧
    if (!a || !b) return 0.55;             // 旁白↔对白：视角切换，得喘口气
    return 0.45;                           // 换人：你一句我一句，别贴太死
  });
}
