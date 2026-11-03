/**
 * 时间轴：把「真实配音时长」变成镜头边界。
 * 这不是估算——每条旁白先合成、再解码、量出精确时长，然后反推每一镜的起止帧。
 */

const LEAD_FIRST = 0.55;
const LEAD = 0.42;
const TAIL = 0.28;
const PAUSE_FIRST = 0.4;
const PAUSE = 0.18;
const OUTRO = 0.65;

export function buildTimeline(project, voiceDurations) {
  const fps = project.meta.fps;
  const q = (sec) => Math.round(sec * fps) / fps;
  const minSpan = 1 / fps;
  const adjusted = [];

  let cursor = 0;
  let prevStart = -Infinity;
  const scenes = project.scenes.map((s, i) => {
    const voiceDur = voiceDurations.get(s.id) ?? 3;
    const pause = s.pauseBefore ?? (i === 0 ? PAUSE_FIRST : PAUSE);
    const lead = s.leadIn ?? (i === 0 ? LEAD_FIRST : LEAD);
    const tail = s.tail ?? TAIL;

    const voiceStart = q(cursor + pause);
    const voiceEnd = q(voiceStart + voiceDur);
    let start = q(Math.max(0, voiceStart - lead));
    let end = q(voiceEnd + tail);

    // 上一镜的 leadIn 比「这一镜之前的全部内容」还长时，这一镜会倒着开始：
    // 帧区间变成 0 或负宽度，它会被整段丢掉，成片里直接少一镜而且不报错。
    // 宁可把提前量截短，也不让时间轴倒退。
    if (start < prevStart + minSpan) {
      start = q(prevStart + minSpan);
      adjusted.push({ id: s.id, why: 'leadIn 太长，上一镜还没开始就要求入场' });
    }
    if (end <= start) {
      end = q(start + minSpan);
      adjusted.push({ id: s.id, why: 'pauseBefore 太短，语音落在画面之前' });
    }
    prevStart = start;

    cursor = end;

    return {
      id: s.id,
      index: i,
      start, end,
      startFrame: Math.round(start * fps),
      endFrame: Math.round(end * fps),
      voiceStart, voiceEnd, voiceDur,
    };
  });

  // 结尾留白
  const last = scenes[scenes.length - 1];
  last.endFrame += Math.round(OUTRO * fps);

  const totalFrames = last.endFrame;

  // 每一镜「拥有」的帧区间：从自己的起点到下一镜的起点（重叠部分归下一镜，避免重复帧）
  const ranges = scenes.map((s, i) => ({
    index: i,
    id: s.id,
    fromFrame: s.startFrame,
    toFrame: i < scenes.length - 1 ? scenes[i + 1].startFrame : totalFrames,
  }));

  return {
    fps,
    totalFrames,
    totalDuration: totalFrames / fps,
    scenes,
    ranges,
    adjusted,
  };
}

/** 把时间轴写回 project（渲染层与字幕都以它为准）。 */
export function applyTimeline(project, timeline) {
  timeline.scenes.forEach((t, i) => {
    const s = project.scenes[i];
    s.start = t.startFrame / timeline.fps;
    s.duration = (t.endFrame - t.startFrame) / timeline.fps;
    s.voiceStart = t.voiceStart;
    s.voiceDur = t.voiceDur;
  });
  project.timeline = {
    totalFrames: timeline.totalFrames,
    totalDuration: timeline.totalDuration,
    fps: timeline.fps,
  };
  return project;
}
