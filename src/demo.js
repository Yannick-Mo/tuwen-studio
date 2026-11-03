/**
 * 内置示例：知识科普 · 9:16 · 约 35 秒。
 * 演示四件事：抽象画面 + 运镜 + 转场 + 卡拉OK 字幕。
 */
import { autoDeltas, autoPauses, composeVoice } from './delivery.js';
import { VOICE_PRESETS } from './schema.js';

export const DEMO = {
  id: 'blackhole',
  title: '黑洞到底是什么',
  aspect: '9:16',
  template: 'knowledge-v1',
  style: {
    token: 'cinematic sci-fi illustration, deep navy and amber, volumetric light, ultra detailed',
    negative: 'text, watermark, logo, extra fingers, deformed hands',
    palette: ['#05070d', '#1e3a8a', '#f59e0b'],
    grade: 'teal-orange-soft',
  },
  voice: { provider: 'edge', name: 'zh-CN-YunxiNeural', rate: '+5%', pitch: '+0Hz' },
  scenes: [
    {
      id: 's1',
      narration: '宇宙里最神秘的天体，是黑洞。',
      motif: 'blackhole',
      motion: { preset: 'push-in', amount: 0.14 },
      texts: [
        { style: 'keyword', text: '黑洞', x: 96, y: 200, w: 800, at: 0.25, motion: { preset: 'per-char', duration: 0.7 } },
        { type: 'shape', x: 99, y: 382, w: 190, h: 9, color: '#f59e0b', at: 0.85, radius: 4 },
      ],
      transitionOut: { type: 'zoom-blur', duration: 0.5 },
    },
    {
      id: 's2',
      narration: '它的引力强到，连光都逃不出去。',
      motif: 'collapse',
      motion: { preset: 'pull-out', amount: 0.1 },
      transitionOut: { type: 'crossfade', duration: 0.45 },
    },
    {
      id: 's3',
      narration: '一颗比太阳大几十倍的恒星死去，才可能诞生它。',
      motif: 'star',
      motion: { preset: 'push-in', amount: 0.18 },
      transitionOut: { type: 'whip-pan', duration: 0.42 },
    },
    {
      id: 's4',
      narration: '2019 年，人类第一次拍到了黑洞的照片。',
      motif: 'photo',
      motion: { preset: 'drift', amount: 0.1 },
      texts: [
        { style: 'sub', text: '2019 · M87 星系', x: 96, y: 250, w: 800, at: 0.6, motion: { preset: 'fade-up' } },
      ],
      transitionOut: { type: 'crossfade', duration: 0.45 },
    },
    {
      id: 's5',
      narration: '而银河系的正中心，就躺着一个超大质量黑洞。',
      motif: 'galaxy',
      motion: { preset: 'pan-right', amount: 0.07 },
      texts: [
        { style: 'sub', text: '人马座 A*', x: 96, y: 250, w: 800, at: 1.5, motion: { preset: 'fade-up' } },
      ],
      transitionOut: { type: 'zoom-blur', duration: 0.5 },
    },
    {
      id: 's6',
      narration: '我们看不见它，只能看见它吃掉的东西。',
      motif: 'void',
      motion: { preset: 'push-in', amount: 0.2 },
      transitionOut: { type: 'whip-pan', duration: 0.4 },
    },
    {
      id: 's7',
      narration: '下一条，讲讲它为什么不是一个洞。',
      motif: 'horizon',
      motion: { preset: 'pull-out', amount: 0.14 },
      texts: [
        { style: 'title', text: '为什么不是一个洞？', x: 96, y: 250, w: 880, at: 0.5, motion: { preset: 'fade-up' } },
      ],
      transitionOut: { type: 'flash', duration: 0.4 },
    },
  ],
};

/** 给真实图像模型的画面描述：每一镜的构图必须互相排斥，否则连看会像卡住 */
const SUBJECTS = {
  s1: '巨大的黑洞侧视，吸积盘像一条炽热的光带横穿画面，背景是深蓝星场',
  s2: '极其靠近黑洞边缘的视角，光线被引力弯折成一道细亮环，四周是深蓝星云',
  s3: '一颗恒星在坍缩瞬间爆炸，外层物质被抛向四周，中心塌陷成黑点',
  s4: '望远镜拍下的黑洞照片质感：模糊的橙红色圆环，明显颗粒与噪点，类似胶片扫描',
  s5: '银河系全景，旋臂铺满整个画面，中心核球过曝发白',
  s6: '一条被拉长的发光物质流正被拖进黑暗中心，周围几乎没有星光',
  s7: '行星地平线特写，蓝色大气层发出辉光，上方是深空',
};

/** 内置示例把画面描述挂在 scenes 上（通用 spec 自己带 visual，不经过这里） */
export function withSubjects(demo) {
  return {
    ...demo,
    scenes: demo.scenes.map((s) => ({
      ...s,
      visual: s.visual || (SUBJECTS[s.id] ? { subject: SUBJECTS[s.id] } : null),
    })),
  };
}

export function buildProject(demo, { assetBase }) {
  // 语气曲线：给每镜叠加相对基准的快慢变化；写死的 scene.voice 优先
  const deltas = autoDeltas(demo.scenes, { enabled: demo.voice?.arc !== 'off' });
  const pauses = autoPauses(demo.scenes);
  const chars = demo.characters || [];
  // 预设先解析成绝对参数，语气曲线的增量才有正确的基准
  const baseVoice = { ...VOICE_PRESETS[demo.voice?.preset], ...demo.voice };

  return {
    id: demo.id,
    meta: { title: demo.title, template: demo.template, aspect: demo.aspect, fps: 30, lang: 'zh-CN', coverShot: demo.coverShot || '', kicker: demo.kicker || '', coverTitle: demo.coverTitle || '' },
    style: demo.style,
    voice: demo.voice,
    audio: { bgm: null, bgmGain: -9, duck: true, loudness: -14, ...(demo.audio || {}) },
    characters: demo.characters || [],
    scenes: demo.scenes.map((s, i) => ({
      id: s.id,
      narration: s.narration,
      visual: s.visual || null,
      cast: s.cast || [],
      layers: [
        { type: 'image', src: `${assetBase}/img/${s.id}.jpg`, z: 0, motion: s.motion },
        ...(s.texts || []).map((t) => ({ type: 'text', z: 50, ...t })),
      ],
      fx: { particles: 'dust', density: 0.32, grain: 0.035, vignette: 0.45 },
      transitionOut: s.transitionOut,
      // 节奏三件套：timeline 会读，缺省就退回 LEAD/PAUSE/TAIL 常量
      pauseBefore: s.pauseBefore ?? pauses[i] ?? undefined,
      leadIn: s.leadIn,
      tail: s.tail,
      voice: (() => {
        if (s.voice) return s.voice;                       // 手写的永远最优先
        const speaker = s.speaker ? chars.find((c) => c.id === s.speaker) : null;
        if (speaker?.voice) {
          // 有专属嗓子：以它为准，语气曲线叠加在它上面
          const base = { ...VOICE_PRESETS[speaker.voice.preset], ...speaker.voice };
          const arc = composeVoice(base, deltas[i]);
          return { ...base, ...(arc || {}) };
        }
        return composeVoice(baseVoice, deltas[i]);
      })(),
      speaker: s.speaker || null,
      performance: s.performance || null,
      motif: s.motif,
    })),
  };
}
