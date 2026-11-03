import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';

export const name = 'video-studio';
export const inject = ['tools'];

const DEFAULT_ENGINE = 'D:\\YannickFile\\TuWenShiPin';

/** 从插件自身位置推断引擎目录（本地链接安装时正好是上一级） */
function resolveEngine(config) {
  const candidates = [
    config.engineDir,
    path.resolve(import.meta.dirname, '..'),
    DEFAULT_ENGINE,
  ].filter(Boolean);
  return candidates[0];
}

function runCli(engineDir, args, { timeoutMs }) {
  const cli = path.join(engineDir, 'src', 'cli.js');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: engineDir,
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`渲染超时（${Math.round(timeoutMs / 60000)} 分钟）。可以调小 --jobs 或拆成更短的项目。`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ out, err });
      const tail = (err || out).trim().split('\n').slice(-12).join('\n');
      reject(new Error(`引擎退出码 ${code}\n${tail}`));
    });
  });
}

function lastJson(text) {
  const lines = String(text).trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim().startsWith('{')) continue;
    try { return JSON.parse(lines.slice(i).join('\n')); } catch { /* try earlier */ }
  }
  return null;
}

const OUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean', description: '是否成功' },
    out: { type: 'string', description: '成片绝对路径' },
    duration: { type: 'number', description: '时长（秒）' },
  },
};

export function apply(ctx, config = {}) {
  const engineDir = resolveEngine(config);
  const jobs = Number(config.jobs) || 4;
  const timeoutMs = Number(config.timeoutMs) || 20 * 60 * 1000;

  // ---------------------------------------------------------------- build
  ctx.effect(() => ctx.tools.register({
    name: 'video_studio_build',
    description: [
      '把一份「剧本描述」渲染成图文视频（mp4）：自动生成画面、合成配音、按真实语音时长排时间轴、逐帧渲染、混音、质检。',
      '重要：第一次调用不要传 confirmed，只会返回分镜表（每镜景别/台词/实测时长/图片张数），一分钱不花。分镜表里的时长是真跑了一遍配音量出来的，不是估的。把分镜表给人看过、改完 spec 之后，再带 confirmed: true 调用一次才真正出图。',
      '画面优先走火山方舟 Seedream（.env 里的 ARK_API_KEY）；配额用尽或没配置时自动降级成本地占位图，结果里的 images.mode 会写明是 ark 还是 mock。',
      '一条 30 秒视频大约 1~2 分钟（含出图）；调用前先把旁白写成短句（每句 8~20 字、对应一个镜头），场景数量 = 镜头数量。',
      'spec.scenes[] 每个元素：narration（必填，该镜旁白）、motif（画面母题，见下）、motion（运镜）、texts（画面上叠加的文字）、transitionOut（转场）。',
      '要人物反复出现时，在 spec.characters 里定义一次（{ id, name, look 外貌, outfit 服装 }），再在每镜用 cast: ["id"] 引用；会先生成一张定妆照，之后每镜把它当参考图，脸和服装才稳。',
      '配音引擎两选一（voice.engine）：edge 免费、确定性、逐句可控，适合科普/新闻/知识；volc 会演、像人、能听懂 performance 描述，适合故事/对白/爽文，但它慢 5 倍、时长会变长 30~50%、生成不确定。默认 edge。引擎按整条决定，volc 中途失败会整条退回 edge，不会一条片子里混两套声音。',
      '多人对白：characters[].voice 给每个角色自己的嗓子，scenes[].speaker 标这句谁说的；两者和 cast 是分开的（cast 管画面里有谁）。换人说话会自动留 0.45 秒停顿。',
      '景别默认按镜头顺序轮换（大全景/中景/特写/仰拍/俯视），也可以在某镜用 visual.shot 指定一句话。',
      '风格不要自己堆形容词：用 style.preset 六选一（cinematic 电影写实 / manga 国漫热血 / comic 美式搞笑 / storybook 温柔绘本 / chalk 黑板粉笔 / flat 扁平科普），预设自带画面 token、负向词、调色和配套字幕样式。一条片子只用一套。',
      'motion.preset 可选：push-in / pull-out / pan-left / pan-right / pan-up / pan-down / float / drift / shake / still；amount 是幅度（0.05~0.25）。',
      'transitionOut.type 可选：cut / crossfade / zoom-blur / whip-pan / wipe / flash；duration 一般 0.4~0.6。',
      'texts[] 元素：{ style: "keyword"|"title"|"sub", text, x, y, w, at（出现时间，秒）, motion: { preset: "per-char"|"fade-up"|"pop-in" } }。',
      '返回成片路径、时长、体积、质检结果，以及 imagesSheet（所有原图拼成的一张联系表）。交付前先看 imagesSheet 确认每镜没跑题——图不对题在这里最便宜地发现；qc.ok 为 false 时要看 qc.checks 哪一条没过。',
    ].join('\n'),
    parameters: {
      spec: {
        type: 'object',
        additionalProperties: true,
        description: '剧本描述对象。不传就读 projects/<projectId>/spec.json（改完文件再重跑时用）',
        properties: {
          id: { type: 'string', description: '项目 id，小写字母数字与短横线，例如 "deepsea"。同一 id 会覆盖旧项目。' },
          title: { type: 'string', description: '视频标题' },
          aspect: { type: 'string', enum: ['9:16', '16:9', '3:4', '1:1'], description: '画幅，默认 9:16' },
          voice: {
            type: 'object',
            additionalProperties: true,
            description: '配音。优先用 preset：warm 温暖女声 / passion 热血男声 / lively 轻快男声 / cute 可爱 / funny 东北方言幽默 / news 播音 / soft 活泼少女。也可直接给 name、rate（"+12%"）、pitch。',
            properties: {
              preset: { type: 'string', enum: ['warm', 'passion', 'lively', 'cute', 'funny', 'news', 'soft'], description: '配音预设，自带音色和语速' },
              name: { type: 'string', description: 'edge 音色名，覆盖 preset' },
              rate: { type: 'string', description: '语速，如 "+12%" / "-5%"' },
              pitch: { type: 'string', description: '音高，如 "+6Hz"' },
              engine: {
                type: 'string',
                enum: ['edge', 'volc'],
                description: 'edge 免费、确定、快，适合科普/新闻/知识；volc 会演、像人，适合故事/对白/爽文。默认 edge。一条片子只用一种，中途失败会整条退回 edge。',
              },
              reference: { type: 'string', description: '仅 volc：固定音色锚点的参考音频路径。不给就自动用第一句当锚点（换片会变音色）' },
            },
          },
          style: {
            type: 'object',
            additionalProperties: true,
            description: '风格。优先用 preset 六选一，它会自动带出 token/负向词/调色/字幕样式；也可单独覆盖 token 或 caption',
            properties: {
              preset: { type: 'string', enum: ['cinematic', 'manga', 'comic', 'storybook', 'chalk', 'flat'], description: '画面风格预设，一条片子只用一套' },
              caption: { type: 'string', enum: ['karaoke', 'comic', 'impact', 'clean'], description: '字幕样式：karaoke 逐字点亮 / comic 黄色粗描边弹出 / impact 白色大字 / clean 无描边小字' },
              token: { type: 'string', description: '自定义画面风格词（覆盖 preset）' },
              palette: { type: 'array', items: { type: 'string' }, description: '[深色, 主色, 强调色]' },
            },
          },
          characters: {
            type: 'array',
            description: '可选，反复出现的人物。定义一次，之后每镜用 cast 引用',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                id: { type: 'string', required: true, description: '英文 id，例如 "lin"' },
                name: { type: 'string', description: '中文名' },
                look: { type: 'string', required: true, description: '外貌：年龄、发型、脸型、特征（伤疤/眼镜/发色）' },
                 outfit: { type: 'string', description: '服装' },
                voice: { type: 'object', additionalProperties: true, description: '这个角色自己的嗓子：{ preset } 或 { name, rate, pitch }。配合 scene.speaker 用，多人对白才不会共用一个声音' },
              },
            },
          },
          scenes: {
            type: 'array',
            required: true,
            description: '镜头列表，按播放顺序',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                narration: { type: 'string', required: true, description: '该镜旁白，会同时作为字幕' },
                cast: { type: 'array', items: { type: 'string' }, description: '本镜出现的人物 id 列表，例如 ["lin"]；不填表示不需要人物' },
                speaker: { type: 'string', description: '这句是谁说的（角色 id）。cast 管画面里有谁，speaker 管谁在说；不填就是旁白' },
                performance: { type: 'string', description: '仅 volc 引擎：表演提示，例如「压低声音，带一点哽咽」「语速快、带着火气」。只喂给 TTS，不会出现在字幕上' },
                visual: { type: 'object', additionalProperties: true, description: '画面描述 { subject }：给图像模型的一句话，写清主体、材质、光线、色调；不写会退化成按 motif 猜' },
                motif: { type: 'string', description: '占位图母题（仅降级时用）' },
                motion: { type: 'object', additionalProperties: true, description: '{ preset, amount }' },
                texts: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '叠加文字' },
                transitionOut: { type: 'object', additionalProperties: true, description: '{ type, duration }' },
                leadIn: { type: 'number', description: '这一镜比台词早多少秒出现（默认 0.42，第一镜 0.55）。想剪得更紧就调小' },
                tail: { type: 'number', description: '台词说完后画面还留多少秒（默认 0.28）' },
                pauseBefore: { type: 'number', description: '上一镜结束到这一镜台词开始之间的停顿（默认 0.18）' },
              },
            },
          },
        },
      },
      projectId: { type: 'string', description: '覆盖 spec.id' },
      jobs: { type: 'integer', description: '并行渲染进程数，默认 4' },
      confirmed: { type: 'boolean', description: '必须显式传 true 才会真正出图；不传就只返回分镜表，不花钱' },
    },
    output: {
      schema: OUT_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: value.planned
          ? [
            `分镜表（还没花钱）：${value.storyboard?.scenes?.length || 0} 镜，约 ${value.storyboard?.totals?.estimatedSeconds || '?'}s，需出图 ${value.storyboard?.totals?.images || '?'} 张。`,
            ...(value.storyboard?.scenes || []).map((s) => `${s.index}. ${s.id} ${s.seconds}s ${s.shot}${s.cast?.length ? ` 👤${s.cast.join('+')}` : ''}\n   ${s.narration}`),
            ...(value.storyboard?.warnings || []).map((w) => `! ${w}`),
            ...(value.storyboard?.problems || []).map((p) => `✗ ${p}`),
            value.storyboard?.ok ? '确认后带 confirmed: true 再调用才会真正出图。' : '先修掉上面的问题再确认。',
          ].join('\n')
          : value.ok
            ? [
              `成片：${value.out}`,
              `${value.duration}s / ${value.sizeMB}MB / ${value.frames} 帧`,
              `封面：${value.cover}`,
              `联系表：${value.sheet}`,
              `质检：${(value.qc?.checks || []).map((c) => `${c.ok ? '✓' : '✗'}${c.name}`).join(' ')}`,
              `画面：${value.images?.mode === 'ark' ? `方舟 ${value.images.model}（新生成 ${value.images.generated} / 缓存 ${value.images.cached}）` : `占位图（${value.images?.reason || '未配置'}）`}`,
              `配音：${JSON.stringify(value.voice || {})}`,
            ].join('\n')
            : `渲染失败：${value.error || '未知错误'}`,
      }],
    },
    timeoutMs,
    async execute(args) {
      const given = args.spec && typeof args.spec === 'object' ? args.spec : null;
      const hasSpec = given && Object.keys(given).length > 0;
      const spec = { ...(hasSpec ? given : {}) };
      const id = String(args.projectId || spec.id || '').trim();
      if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(id)) {
        throw new Error('project id 必须是 1~41 位小写字母/数字/短横线，例如 "deepsea"');
      }
      if (hasSpec && (!Array.isArray(spec.scenes) || spec.scenes.length === 0)) {
        throw new Error('spec.scenes 不能为空：每个镜头一条旁白');
      }
      spec.id = id;

      const dir = path.join(engineDir, 'projects', id);
      await fs.mkdir(dir, { recursive: true });
      const specPath = path.join(dir, 'spec.json');
      if (hasSpec) {
        await fs.writeFile(specPath, JSON.stringify(spec, null, 2), 'utf8');
      } else {
        const ok = await fs.stat(specPath).then(() => true).catch(() => false);
        if (!ok) return { ok: false, error: `没有 spec：传 spec，或先把 spec.json 放到 ${specPath}` };
      }

      // 第一道闸门：没确认就只出分镜表，一分钱不花
      if (!args.confirmed) {
        try {
          const { out } = await runCli(engineDir, ['plan', specPath, '--json'], { timeoutMs: 180_000 });
          const sb = lastJson(out);
          if (!sb) return { ok: false, error: '分镜表生成失败' };
          return { ok: true, planned: true, storyboard: sb };
        } catch (e) {
          return { ok: false, error: String(e.message).slice(0, 1500) };
        }
      }

      try {
        const { out } = await runCli(engineDir, ['build', specPath, '--yes', '--json', `--jobs=${args.jobs || jobs}`], { timeoutMs });
        const result = lastJson(out);
        if (!result) throw new Error('引擎没有返回结果 JSON');
        return result;
      } catch (e) {
        return { ok: false, error: String(e.message).slice(0, 2000) };
      }
    },
  }));

  // --------------------------------------------------------------- scene
  ctx.effect(() => ctx.tools.register({
    name: 'video_studio_scene',
    description: [
      '只改一镜：重新出这一张图（或用你给的图），只重渲这几秒，然后无缝拼回整条片子。',
      '全程 20~30 秒，只花一张图的钱；其它镜头、配音、混音都不动。',
      '适用于「第 3 镜画面不对」「换个构图」「换成实拍图」这类微调。改旁白或改镜头数量请重新 build。',
      'prompt 不给就沿用原来的画面描述；想换一个样子可以再给 seed。',
    ].join('\n'),
    parameters: {
      projectId: { type: 'string', required: true, description: '项目 id' },
      sceneId: { type: 'string', required: true, description: '镜头 id，例如 "s3"（见 build 返回的 scenes）' },
      prompt: { type: 'string', description: '新的画面描述；不给就沿用原来的' },
      seed: { type: 'integer', description: '换一个随机种子，同一描述也能出不同构图' },
      noImage: { type: 'boolean', description: '只重渲这一段，不重新出图（配合手动改 project.json 的图层用）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          scene: { type: 'string' },
          frames: { type: 'integer' },
          out: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_a, v) => [{
        type: 'text',
        text: v.ok
          ? [
            `已重渲 ${v.scene}（${v.frames} 帧）→ ${v.out}`,
            `出图：${v.image ? `${v.image.mode}${v.image.cached ? '（命中缓存）' : ''}` : '沿用原图'}`,
            `质检：${(v.qc?.checks || []).map((c) => `${c.ok ? '✓' : '✗'}${c.name}`).join(' ')}`,
          ].join('\n')
          : `重渲失败：${v.error || '未知错误'}`,
      }],
    },
    timeoutMs: 10 * 60 * 1000,
    async execute(args) {
      const id = String(args.projectId || '').trim();
      const sceneId = String(args.sceneId || '').trim();
      if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(id)) throw new Error('非法 projectId');
      if (!/^[A-Za-z0-9_-]{1,20}$/.test(sceneId)) throw new Error('非法 sceneId');
      const cli = ['scene', path.join(engineDir, 'projects', id, 'project.json'), `--id=${sceneId}`];
      if (args.prompt) cli.push(`--prompt=${args.prompt}`);
      if (args.seed != null) cli.push(`--seed=${args.seed}`);
      if (args.noImage) cli.push('--no-image');
      try {
        const { out } = await runCli(engineDir, cli, { timeoutMs: 10 * 60 * 1000 });
        return lastJson(out) || { ok: false, error: '引擎没有返回结果' };
      } catch (e) {
        return { ok: false, error: String(e.message).slice(0, 1500) };
      }
    },
  }));

  // --------------------------------------------------------------- frames
  ctx.effect(() => ctx.tools.register({
    name: 'video_studio_frames',
    description: [
      '从已渲染的项目里取若干静帧（jpg），用于审片、挑封面、确认画面和字幕位置。',
      '比重新渲染整条视频快得多（每帧约 0.1 秒），改稿时先用它检查。',
      '返回每帧的时间点和文件路径。',
    ].join('\n'),
    parameters: {
      projectId: { type: 'string', required: true, description: '项目 id' },
      times: {
        type: 'array', required: true,
        items: { type: 'number' },
        description: '取帧时间点（秒），例如 [0.5, 3, 8.5]',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          frames: { type: 'array', items: { type: 'object', additionalProperties: true } },
          error: { type: 'string' },
        },
      },
      render: (_a, v) => [{
        type: 'text',
        text: v.ok
          ? (v.frames || []).map((f) => `${f.t}s → ${f.file}`).join('\n')
          : `取帧失败：${v.error}`,
      }],
    },
    timeoutMs: 5 * 60 * 1000,
    async execute(args) {
      const id = String(args.projectId || '').trim();
      if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(id)) throw new Error('非法 projectId');
      const times = (args.times || []).filter((n) => Number.isFinite(n) && n >= 0).slice(0, 12);
      if (!times.length) throw new Error('times 不能为空');
      try {
        const { out } = await runCli(engineDir, ['frames', path.join(engineDir, 'projects', id, 'project.json'), `--times=${times.join(',')}`], { timeoutMs: 5 * 60 * 1000 });
        return lastJson(out) || { ok: false, error: '没有取到帧' };
      } catch (e) {
        return { ok: false, error: String(e.message).slice(0, 1200) };
      }
    },
  }));

  // ----------------------------------------------------------------- list
  ctx.effect(() => ctx.tools.register({
    name: 'video_studio_list',
    description: '列出本机已有的图文视频项目（id、标题、镜头数、时长、成片路径）。想接着改一条旧片时先用它。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { projects: { type: 'array', items: { type: 'object', additionalProperties: true } } },
      },
      render: (_a, v) => [{
        type: 'text',
        text: (v.projects || []).length
          ? v.projects.map((p) => `${p.id} · ${p.title} · ${p.scenes} 镜 · ${p.duration ?? '?'}s\n  ${p.out || '（未渲染）'}`).join('\n')
          : '还没有项目',
      }],
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute() {
      const { out } = await runCli(engineDir, ['list'], { timeoutMs: 60_000 });
      return { projects: lastJson(out) || [] };
    },
  }));
}
