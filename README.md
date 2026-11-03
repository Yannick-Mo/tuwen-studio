# 图文视频工坊 · tuwen-studio

把「一句主题 / 一段小说 / 一个知识点」变成一条可直接发布的图文视频：
**脚本 → 配音 → 画面 → 动效 → 字幕 → 成片**，全程可预览、可单点重做、可批量。

> 当前版本：P0 已跑通（内核引擎 + CLI），P1~P4 见 [DESIGN.md](./DESIGN.md)。

---

## 30 秒上手

```powershell
node src/cli.js demo
```

产出在 `projects/blackhole/out/`：

| 文件 | 说明 |
|---|---|
| `blackhole.mp4` | 成片（1080×1920 / 30fps / H.264 + AAC） |
| `qc.json` | 自动质检报告 |
| `cover.jpg` | 封面帧 |
| `contact-sheet.jpg` | 成片联系表（每 2 秒一帧） |
| `images-sheet.jpg` | 原图联系表（每镜一张，出图后就生成，用来查图对没对上台词） |

首次运行会生成占位画面、合成配音；之后再跑会命中缓存，只重渲视频。

---

## 在对话里用（DSH 插件）

插件 `@local/dsh-video-studio` 已装进当前 profile，装了就有三个工具：

| 工具 | 干什么 |
|---|---|
| `video_studio_build` | 给一份剧本描述（JSON），直接出 mp4 |
| `video_studio_frames` | 从已渲染项目里取静帧审片（每帧 0.1 秒） |
| `video_studio_list` | 列出本机项目 |

说一句「用图文视频工坊做一条关于银河系的竖屏视频，三镜」就能跑。
插件源码在 [plugin-video-studio](plugin-video-studio)，配置里 `engineDir` 指向本仓库。

---

### 角色一致性

同一个人物反复出现时，在 spec 里定义一次：

```jsonc
"characters": [
  { "id": "lin", "name": "林夏",
    "look": "二十二岁中国女性，齐肩黑色短发，左眉上方一道细疤，眼神冷静",
    "outfit": "橙色战术太空服，领口金属环，黑色高领内衬" }
],
"scenes": [
  { "id": "s1", "narration": "…", "cast": ["lin"], "visual": { "subject": "…" } },
  { "id": "s3", "narration": "…", "visual": { "subject": "警报灯特写" } }   // 不填 cast = 没有人
]
```

两件事同时发生，缺一不可：

1. **提示词锁（L1）**：`look` / `outfit` 原文拼进每一镜的提示词；
2. **参考图锁（L2）**：先出一张定妆照（`img/_char_<id>.jpg`），之后每镜把它以 base64 作为 `image` 传给 Seedream。

实测下来脸、疤、服装能对上；只靠 L1 时第三四镜就开始漂。定妆照只生成一次，缓存复用。

**多人同框**：`cast: ["lin", "zhou"]` 会按顺序传两张参考图，提示词里写明「参考图1是林夏，参考图2是周野；两个人不能串脸」。实测双人镜头不会串脸。

**镜头语言**：景别放在提示词最前面（权重最高），量化构图约束放在接近结尾（收尾强调）：

```
[景别] + [人物] + [画面内容] + [风格] + [竖屏构图] + [“人物高度不超过画面高度的四分之一”] + [负向词]
```

只用形容词（「大全景、人物很小」）会被忽略，写死数字才有效——这是加人物之后最明显的一个变化。

---

## 声音：程序化配乐 + 音效

全部本地合成（[src/synth.js](src/synth.js)），不依赖任何素材库，没有版权问题。20 秒配乐生成约 0.5 秒。

**配乐**：A 小调 i–VI–III–VII，pad + 八分音符琶音 + 低音，76 BPM（`tense` 68），循环铺满全片，首尾自动淡入淡出。
`calm` 用于科普，`tense` 用于剧情——在 spec 里写 `"audio": { "bgmStyle": "tense" }`。

**音效**：按转场类型自动挂，不用手点。

| 转场 | 音效 | 说明 |
|---|---|---|
| `zoom-blur` | riser | 上扬噪声扫频，提前 0.45 秒进 |
| `whip-pan` | whoosh | 甩镜风声 |
| `flash` | boom | 低频冲击 + 裂响 |
| `crossfade` | pop | 很轻的过渡点头 |
| `wipe` | whoosh | 同甩镜 |

**电平**（这组数字调了三轮才对）：

- 配乐比人声低约 16 dB；
- sidechain 软闪避 `ratio=3 threshold=0.06`——用的是 ratio 8 的话，持续人声会把配乐压到几乎为零；
- 最终整体 `-14 LUFS / TP -1.5 dBTP`。

---

## 工作台

```powershell
node src/cli.js studio --port=7788
```

打开 `http://127.0.0.1:7788/`：

- 左侧是分镜列表，每镜一张缩略图 + 台词 + 角色；
- 中间是成片播放器，点某一镜自动跳到它的时间点；
- 右侧是这一镜的提示词，改完点「重新出图 + 重渲」或「只重渲」。

只重渲约 11 秒、不花钱；重新出图约 25 秒、花一张图。改完自动刷新缩略图和播放器。
服务只监听 127.0.0.1，没有鉴权，别暴露到公网。

---

## 先审后拍

`build` 默认不花钱：它只出分镜表就停下。

```powershell
node src/cli.js plan specs/chapter-02.json          # 只看分镜表
node src/cli.js build specs/chapter-02.json         # 出分镜表并停下（退出码 2）
node src/cli.js build specs/chapter-02.json --yes   # 真正出图 + 渲染
```

分镜表存在 `projects/<id>/storyboard.md`，每镜给出：景别、台词、画面描述、时长、有没有角色、转场类型。

分镜表上的时长是**真的**：出一份表之前，引擎会先把每句旁白本地合成一遍、解码量出真实长度（`--fast` 可按 5 字/秒估算跳过这一步）。本地引擎不花钱，结果按内容哈希缓存，第二次只是读盘。
校对过：`chapter-02` 的表报 16.23s，成片正好 16.23s。

闸门设在「刚要花钱」的那一刻——分镜表看不对就改 spec，改完重跑，一分钱不花。

---

## 命令

```powershell
node src/cli.js demo                      # 内置示例
node src/cli.js build spec.json --json    # 按剧本描述出片（配图/配音/渲染全自动）
node src/cli.js scene p.json --id=s3      # 只改一镜（重出图 + 只重渲这一段，约 25 秒）
node src/cli.js render project.json       # 只重渲（图和音已就绪）
node src/cli.js frames p.json --times=1,3.5   # 取静帧审片
node src/cli.js list                      # 列出项目
```

选项：`--jobs=4` 并行进程、`--fallback` 强制本地 SAPI、`--mock` 用占位图、`--json` 机器可读输出、`--engine=edge|volc` 指定配音引擎、`--fast` 分镜表用字数估算。
`scene` 子命令：`--prompt="新的画面描述"`、`--seed=123`、`--image=本地图片`、`--no-image`（只重渲不改图）。

## 自检

改完代码先跑这条，再谈别的：

```powershell
npm test            # 离线：占位图 + 本地配音，约 35 秒，不花钱
npm run test:real   # 真跑一次，会消耗出图额度
```

它用一条固定 spec 走完整流程，然后核对 11 项：退出码、产物齐全、帧数、成片时长与时间轴是否吻合、质检七项、每镜的配音和画面、引擎记录、降级标记。任何一项不过就退出码 1。

这是唯一能在没人盯着的时候，证明「刚才那改动没把别的地方改坏」的东西。

### 改一镜为什么快

整片被切成「每镜一段」的 mp4（`work/seg/seg_000.mp4`…）。改一镜时：

1. 只重新出这一张图（一张图的钱）；
2. 只重渲这一段的帧（约 1/7 的帧）；
3. `concat -c copy` 把七段重新拼起来，不重新编码其它段；
4. 复用已有的 `work/mix.m4a` 重新封装——**时长没变，音频一个字都不用重算**。

实测：全量 build 约 110 秒，改一镜约 24 秒。

> 前提是时长不能变。改旁白、改镜头数量会改变时间轴，必须重新 build。

---

## 为什么不用「一键成片」那套

| 常见做法 | 这里的做法 | 差别 |
|---|---|---|
| 生成和渲染揉成黑盒流水线 | 视频 = `project.json`，渲染是纯函数 | 改一处只重渲几秒；断了能续；可版本化 |
| 先定每镜 4 秒再配音 | 先配音、量真实时长、反推镜头 | 节奏永远对，字幕永远对得上 |
| 预览一套、导出一套 | 同一个 `seek(t)` 运行时 | 预览什么样，导出就是什么样 |

---

## 结构

```
src/
  cli.js        命令行入口：demo / render
  schema.js     项目模型校验与默认值
  timeline.js   配音时长 → 镜头边界（帧级量化）
  tts.js        配音：edge-tts → Piper → SAPI 三级降级
  encode.js     截帧编码 / 拼接 / 人声轨 / 混音 / 封装
  stage.js      Playwright 驱动 + 本地静态服务
  mock-art.js   占位画面生成（无 API key 也能跑）
  qc.js         自动质检 + 联系表
  demo.js       内置示例脚本
stage/
  index.html    Stage 页面
  runtime.js    seek(t) 确定性动画运行时
projects/       每个项目一个目录（project.json + img/ + voice/ + out/）
.models/        Piper 中文音色（离线）
```

---

## 项目文件

`project.json` 是唯一真相。最小示例：

```jsonc
{
  "meta": { "title": "黑洞到底是什么", "aspect": "9:16", "fps": 30 },
  "style": { "palette": ["#05070d", "#1e3a8a", "#f59e0b"], "grade": "teal-orange-soft" },
  "scenes": [
    {
      "id": "s1",
      "narration": "宇宙里最神秘的天体，是黑洞。",
      "layers": [
        { "type": "image", "src": "/projects/blackhole/img/s1.jpg", "z": 0,
          "motion": { "preset": "push-in", "amount": 0.14 } },
        { "type": "text", "style": "keyword", "text": "黑洞", "x": 96, "y": 200, "at": 0.25,
          "motion": { "preset": "per-char", "duration": 0.7 } }
      ],
      "fx": { "particles": "dust", "density": 0.32, "grain": 0.035, "vignette": 0.45 },
      "transitionOut": { "type": "zoom-blur", "duration": 0.5 }
    }
  ]
}
```

时间轴、字幕、音频位置都不写进文件——它们由**真实配音时长**推导。

---

## 动作库

**运镜** `push-in` `pull-out` `pan-left/right/up/down` `float` `drift` `shake` `still`
**转场** `cut` `crossfade` `zoom-blur` `whip-pan` `wipe` `flash`
**文字** `fade-up` `pop-in` `per-char` `typewriter` `none`
**粒子** `dust` `embers` `speed`
**图层** `image` `text` `sticker` `shape`

---

## 图像模型（火山方舟 Seedream）

`.env` 里配（不要写进代码）：

```
ARK_API_KEY=...
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
ARK_IMAGE_MODEL=doubao-seedream-4-5-251128
ARK_IMAGE_SIZE=1440x2560
```

两个坑，踩过一次：

- **Seedream 要求单图像素 ≥ 3,686,400**。`1080x1920`（207 万像素）会被 400 拒掉。
  9:16 的最低合法尺寸就是 `1440x2560`，16:9 用 `2560x1440`。
- **`doubao-seedream-5-0-flash` 会被「安全体验模式」限额暂停**（429 SetLimitExceeded），
  换一个已激活的模型即可；报错里会写明是配额还是模型没开。

没配 key、配额用尽、或加 `--mock` 时自动降级成本地占位图，结果里的 `images.mode` 会写明是 `ark` 还是 `mock`。

---

## 配音：两个引擎，三级兜底

**引擎二选一**（`voice.engine`，默认 `edge`）：

| 引擎 | 特点 | 适合 | 代价 |
|---|---|---|---|
| `edge` | 免费、确定性、逐句可控、14 个中文音色 | 科普、新闻、知识、长解说 | 不会「演」，情绪靠换人 + 语速 |
| `volc` | 会演，能听懂「带着疲惫说道」这类描述 | 故事、对白、爽文、情感 | 慢 5 倍、时长长 30~50%、生成不确定 |

引擎按**整条**决定，不逐句混用：volc 中途任何一句失败，整片丢弃重做 edge，因为一条片子里出现两个嗓子比音质差更糟。

volc 的音色靠**参考音频锚定**——不锚定的话，同一句提示词两次调用能差 26 Hz（听感上就是换了个人）。默认自动取第一句当锚点，也可以用 `voice.reference` 指定一段固定样本，跨片一致。

edge 内部还有三级兜底：**edge-tts**（音质最好、带词级时间戳，会间歇性 403，自动重试 + 熔断）→ **Piper**（离线、快）→ **Windows SAPI**（永远能出声）。

命中缓存的结果不会重复合成，缓存键包含引擎和表演提示，所以换引擎不会串。

---

## 渲染性能（本机实测）

| 配置 | 790 帧（26 秒） |
|---|---|
| 单进程 | 139s |
| 4 进程并行 | **51s** |

瓶颈在 Chromium 截帧（约 90ms/帧），不在编码。`seek()` 本身只有 2ms。

---

## 待办（P1~P4）

- 真实图像模型适配器（Seedream / 万相 / Nano Banana），替换 `mock-art.js`
- LLM 写脚本与分镜（现在由 Agent 在对话里写，够用但没固化）
- 角色一致性（角色圣经 + 参考图）
- 视频工坊面板：分镜卡片、画布预览、单镜重生成（P4）
