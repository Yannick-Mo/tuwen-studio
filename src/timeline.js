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

  let cursor = 0;
  const scenes = project.scenes.map((s, i) => {
    const voiceDur = voiceDurations.get(s.id) ?? 3;
    const pause = s.pauseBefore ?? (i === 0 ? PAUSE_FIRST : PAUSE);
    const lead = s.leadIn ?? (i === 0 ? LEAD_FIRST : LEAD);
    const tail = s.tail ?? TAIL;

    const voiceStart = q(cursor + pause);
    const voiceEnd = q(voiceStart + voiceDur);
    const start = q(Math.max(0, voiceStart - lead));
    const end = q(voiceEnd + tail);

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
