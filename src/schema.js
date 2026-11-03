/**
 * 项目模型：规范化 + 校验。
 * project.json 是整个系统唯一的真相来源，这里只做「补默认值」和「早失败」。
 */

export const ASPECTS = {
  '9:16': [1080, 1920],
  '16:9': [1920, 1080],
  '3:4': [1080, 1440],
  '4:3': [1440, 1080],
  '1:1': [1080, 1080],
};

export const GRADES = {
  none: 'none',
  'teal-orange-soft': 'saturate(1.06) contrast(1.06) brightness(1.02)',
  'cool-blue': 'saturate(0.96) contrast(1.08) hue-rotate(-6deg) brightness(0.98)',
  'warm-film': 'sepia(0.12) saturate(1.1) contrast(1.04) brightness(1.03)',
  mono: 'grayscale(1) contrast(1.1)',
};

/**
 * 画面风格预设：一条片子只用一套。
 * 风格不是形容词堆出来的，是「token + 负向词 + 调色 + 字幕样式」四件套绑在一起。
 */
export const STYLE_PRESETS = {
  cinematic: {
    token: 'cinematic film still, volumetric light, shallow depth of field, 35mm, photorealistic, ultra detailed',
    negative: 'text, watermark, logo, extra fingers, deformed hands, cartoon, anime, illustration, flat colors',
    grade: 'teal-orange-soft',
    caption: 'karaoke',
  },
  manga: {
    token: 'chinese manhua illustration, bold ink outlines, cel shading, dramatic rim light, vivid flat colors, comic panel art, clean lineart',
    negative: 'text, watermark, logo, photorealistic, 3d render, deformed hands, extra fingers, muddy colors',
    grade: 'none',
    caption: 'comic',
  },
  comic: {
    token: 'western comic book illustration, thick black outlines, halftone dots, exaggerated expressions, flat saturated colors, pop art',
    negative: 'text, watermark, logo, photorealistic, blurry, deformed hands, extra fingers',
    grade: 'none',
    caption: 'comic',
  },
  storybook: {
    token: 'children picture book illustration, soft gouache texture, warm pastel palette, gentle light, hand-painted, rounded shapes',
    negative: 'text, watermark, logo, photorealistic, harsh shadows, deformed hands, extra fingers',
    grade: 'none',
    caption: 'clean',
  },
  chalk: {
    token: 'chalk drawing on a dark blackboard, colored chalk texture, hand-drawn diagram, rough sketchy strokes, educational',
    negative: 'text, watermark, logo, photorealistic, 3d render, glossy, photograph',
    grade: 'none',
    caption: 'clean',
  },
  flat: {
    token: 'flat vector illustration, geometric shapes, limited palette, clean lines, editorial infographic style, soft gradients',
    negative: 'text, watermark, logo, photorealistic, 3d render, noise, deformed hands',
    grade: 'none',
    caption: 'clean',
  },
};

/**
 * 配音预设：不同的片子要不同的嗓子。
 * 单条音色决定「听起来像谁」，rate 决定「听着累不累」。
 */
export const VOICE_PRESETS = {
  warm: { name: 'zh-CN-XiaoxiaoNeural', rate: '+2%', pitch: '+0Hz' },
  passion: { name: 'zh-CN-YunjianNeural', rate: '+12%', pitch: '-2Hz' },
  lively: { name: 'zh-CN-YunxiNeural', rate: '+14%', pitch: '+2Hz' },
  cute: { name: 'zh-CN-YunxiaNeural', rate: '+6%', pitch: '+6Hz' },
  funny: { name: 'zh-CN-liaoning-XiaobeiNeural', rate: '+10%', pitch: '+0Hz' },
  news: { name: 'zh-CN-YunyangNeural', rate: '+4%', pitch: '+0Hz' },
  soft: { name: 'zh-CN-XiaoyiNeural', rate: '+0%', pitch: '+2Hz' },
};

/**
 * 各平台的底部 UI 高度（占画面高度的比例）。
 * 字幕别压在这条线以下，否则会被播放器的点赞/进度条盖住。
 */
export const PLATFORM_SAFE = {
  douyin: 0.172,
  xiaohongshu: 0.15,
  wechat: 0.18,
  bilibili: 0.095,
  youtube: 0.10,
};

const DEFAULTS = {
  fps: 30,
  aspect: '9:16',
  lang: 'zh-CN',
  voice: { provider: 'edge', name: 'zh-CN-YunxiNeural', rate: '+4%', pitch: '+0Hz' },
  audio: { bgm: null, bgmGain: -9, duck: true, loudness: -14, tailFade: 0.6 },
  deliver: { burnSubtitles: true, cover: true, srt: true, aigcLabel: true, crf: 18 },
};

export function normalizeProject(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') throw new Error('project 不是对象');

  const meta = { ...DEFAULTS, ...(raw.meta || {}) };
  const aspect = ASPECTS[meta.aspect] ? meta.aspect : DEFAULTS.aspect;
  const size = meta.size || ASPECTS[aspect];
  const fps = Number(meta.fps || DEFAULTS.fps);

  const project = {
    version: raw.version || 1,
    id: raw.id || 'untitled',
    meta: {
      title: meta.title || '未命名',
      template: meta.template || 'knowledge-v1',
      aspect,
      size,
      fps,
      lang: meta.lang || DEFAULTS.lang,
      platform: meta.platform || 'douyin',
      coverShot: meta.coverShot || '',
      kicker: meta.kicker || '',
      coverTitle: meta.coverTitle || '',
    },
    style: (() => {
      // 什么都没写就按电影写实来，别让新 spec 裸着、一条风格词都没有
      const preset = STYLE_PRESETS[raw.style?.preset]
        || (!raw.style?.token ? STYLE_PRESETS.cinematic : null);
      return {
        preset: raw.style?.preset || '',
        token: raw.style?.token || preset?.token || '',
        negative: raw.style?.negative || preset?.negative || 'text, watermark, logo, extra fingers, deformed hands',
        palette: raw.style?.palette || preset?.palette || ['#0b1220', '#1e3a8a', '#f59e0b'],
        grade: raw.style?.grade || preset?.grade || 'none',
        caption: raw.style?.caption || preset?.caption || 'karaoke',
      };
    })(),
    voice: {
      ...DEFAULTS.voice,
      ...(VOICE_PRESETS[raw.voice?.preset] || {}),
      ...(raw.voice || {}),
    },
    audio: { ...DEFAULTS.audio, ...(raw.audio || {}) },
    deliver: { ...DEFAULTS.deliver, ...(raw.deliver || {}) },
    timeline: raw.timeline || null,
    characters: (raw.characters || []).map((c, i) => ({
      id: c.id || `c${i + 1}`,
      name: c.name || c.id || `角色${i + 1}`,
      look: c.look || c.appearance || '',
      outfit: c.outfit || '',
      // 每个角色自己的嗓子：对白就不用和别人共用一个声音
      voice: c.voice || null,
      sheet: c.sheet || null,
    })),
    scenes: [],
  };

  if (!Array.isArray(raw.scenes) || raw.scenes.length === 0) {
    errors.push('scenes 不能为空');
  }

  project.scenes = (raw.scenes || []).map((s, i) => {
    const id = s.id || `s${i + 1}`;
    if (!s.narration && !s.captions?.length) errors.push(`scene ${id} 缺少 narration`);
    const captions = (s.captions || (s.narration ? [{ text: s.narration }] : [])).map((c) => ({
      text: c.text || '',
      start: c.start, end: c.end,
      words: c.words || null,
      emphasis: c.emphasis || [],
      style: c.style || 'main',
    }));
    const layers = (s.layers || []).map((l) => ({
      z: l.z ?? 0,
      ...l,
      motion: { preset: 'push-in', amount: 0.1, ease: 'outCubic', ...(l.motion || {}) },
    })).sort((a, b) => a.z - b.z);

    return {
      id,
      narration: s.narration || '',
      audio: s.audio || null,
      captions,
      layers,
      fx: { particles: null, density: 0.4, grain: 0.05, vignette: 0.35, ...(s.fx || {}) },
      transitionOut: s.transitionOut || null,
      pauseBefore: s.pauseBefore,
      leadIn: s.leadIn,
      tail: s.tail,
      // 镜头级配音覆盖：同一片子里让某一句换个语气/语速
      voice: s.voice || null,
      // 这句是谁说的：有就用这个角色的嗓子（cast 管画面里有谁，speaker 管谁在说）
      speaker: s.speaker || null,
      // 表演提示：只喂给优化版 TTS，决不会出现在字幕上
      performance: s.performance || null,
      // 画面描述：motif 给占位图，visual.subject 给真实模型
      motif: s.motif,
      visual: s.visual || null,
      cast: s.cast || [],
      // 已排好时间轴的项目（重开旧片）要保留这些，否则镜头不可见
      start: s.start,
      duration: s.duration,
      voiceStart: s.voiceStart,
      voiceDur: s.voiceDur,
      meta: s.meta || {},
    };
  });

  if (errors.length) throw new Error(`项目校验失败:\n- ${errors.join('\n- ')}`);
  return project;
}

/** 给渲染层用的精简视图（不含 prompt 等元数据） */
export function toStageProject(project) {
  return {
    size: project.meta.size,
    fps: project.meta.fps,
    grade: GRADES[project.style.grade] || GRADES.none,
    palette: project.style.palette,
    captionStyle: project.style.caption,
    captionBottom: PLATFORM_SAFE[project.meta.platform] ?? PLATFORM_SAFE.douyin,
    scenes: project.scenes.map((s) => ({
      id: s.id,
      start: s.start,
      duration: s.duration,
      layers: s.layers,
      captions: s.captions,
      fx: s.fx,
      transitionOut: s.transitionOut,
    })),
    deliver: project.deliver,
  };
}
