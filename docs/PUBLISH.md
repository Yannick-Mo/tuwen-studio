# 发布到 DSH 插件市场

先把两件事分开——它们互不依赖：

| 想达到 | 需要什么 | 卡点 |
|---|---|---|
| 别人能装上 | 一个 pnpm 能解析的地址：`github:用户名/仓库` 或 npm 包名 | 仓库根目录得是一个合法的 DSH bundle |
| 出现在市场的列表里 | 被某个「索引」收录 | 索引是人维护的，要提交 |

所以：**不用等收录，先把 GitHub 发出去，别人就能装。** 收录只是让它「能被搜到」。

---

## 市场是怎么来的（我查到的机制）

DSH 里那个「插件市场」是社区插件 `dshmarket`（`dshmarket.com` / `github.com/dsh-market/dsh-market`）。
它的目录来自一个索引文件：

```
https://awesome-dsh-plugin.com/plugins.json      # 截至今天 8489 条
```

每条长这样（字段是实测的，不是我编的）：

| 字段 | 说明 |
|---|---|
| `name` / `owner` / `url` | 仓库名、作者、GitHub 地址 |
| `page` | 市场站的详情页地址 |
| `category` | 分类，例如 `agi` |
| `description` | `{ en, zh }` 双语，**必须两边都写** |
| `npm` / `version` | 发过 npm 才有，没有就是 `null` |
| `install` | 一条可直接复制的命令，如 `dsh plugin --profile web add github:Anmulzhao/DSH-AGINT` |
| `stars` / `downloads` | 抓来的，不用填 |
| `capabilities` | `shell` / `fs-write` / `fs-read` / `network` / `env` / `subagent`，**静态扫描代码得出** |
| `icon` | 一张图，一般是 raw.githubusercontent 的 PNG |

收录入口：`github.com/awesome-dsh-plugin/awesome-dsh-plugin` 的 `contributing.md`（市场页面上那个「申请收录插件 ↗」就指向这里）。

---

## 现在的状态

已经发布，可以直接用：

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/Yannick-Mo/tuwen-studio （public，`main`） |
| 协议 | Apache-2.0（建仓库时选的） |
| 安装 | `dsh plugin --profile <名字> add github:Yannick-Mo/tuwen-studio` |
| 图标 | `assets/icon.png`，256×256，从 `plugin-video-studio/icon.svg` 渲染 |
| 已验证 | `npm i github:Yannick-Mo/tuwen-studio` → 装完能作为插件加载，注册 6 个 `video_studio_*` 工具 |
| 还差 | 仓库描述和 topics 是空的；市场收录还没提交 |

npm 上 `tuwen-studio` 这个包名**还没人占用**；另外已经有一个 `dsh-video-studio`（作者 litao，0.4.3），
做的是「把素材目录剪成片」，和这个不冲突但名字容易混，描述里要把「AI 出图 + 真配音」说清楚。

---

## 已经做完的步骤

### 1. 推到 GitHub ✅

remote 用 SSH：`git@github.com:Yannick-Mo/tuwen-studio.git`（`~/.ssh/config` 里已经把 github 走 443 端口）。

### 2. 验证别人装得上 ✅

同一条路走过两遍：打包成 tgz 装一次、直接从 GitHub 装一次，两次装完都能加载出 6 个工具。

> **再验证时别在正在用的 profile 上装第二份**——会重复注册同名工具。
> 要试就开一个临时 profile：`dsh plugin --profile tmp-check add github:Yannick-Mo/tuwen-studio`。

### 3. 图标（已就绪）

`assets/icon.png` 已生成（256×256，从 `plugin-video-studio/icon.svg` 渲染）。
推上去之后地址是：

```
https://raw.githubusercontent.com/Yannick-Mo/tuwen-studio/main/assets/icon.png
```

### 4. 提交收录

打开 `github.com/awesome-dsh-plugin/awesome-dsh-plugin`，按 `contributing.md` 提 PR。要准备的东西：

```yaml
name: 图文视频工坊 · tuwen-studio
repo: https://github.com/Yannick-Mo/tuwen-studio
category: video            # 按他们的分类表选
description:
  en: >-
    Turn a script into a narrated, subtitled, animated vertical video: AI-generated
    stills (Volcano Ark Seedream), real TTS with word-level timestamps, karaoke/comic
    captions, per-shot re-render, automatic QC. Ships its own ffmpeg/Chromium —
    no Python, no PATH setup.
  zh: >-
    把一个剧本变成有配音、有字幕、有运镜的竖屏视频：AI 出图（方舟 Seedream）、
    真配音带词级时间戳、卡拉OK/漫画字幕、单镜重渲、自动质检。
    ffmpeg 和 Chromium 随包安装，不需要 Python，不用配 PATH。
icon: https://raw.githubusercontent.com/Yannick-Mo/tuwen-studio/main/assets/icon.png
```

其余字段（星数、下载量、能力扫描、`install` 命令）由索引方自动生成。

### 5.（可选）发 npm

发 npm 之后 `install` 会变成 `tuwen-studio@0.2.0`，升级和卸载都更干净：

```powershell
npm login
npm publish
```

---

## 会被扫出哪些「能力」

索引会静态扫描代码，列出这个插件「能做什么」。我们这个会被扫出：

| 能力 | 为什么 |
|---|---|
| `shell` | 调 ffmpeg、ffprobe、node 子进程 |
| `fs-write` | 写 `projects/`、`.cache/`、`~/.dsh/tuwen/.env` |
| `fs-read` | 读剧本、图片、配音 |
| `network` | 方舟出图、微软语音、（可选）火山语音 |
| `env` | 读 API Key |

这是事实，写清楚比藏着好。市场页面上原话是「静态扫描只能证明『有』，不能证明『没有』」，所以别指望它给你安全背书。

---

## 一句话总结

先推到 GitHub → `dsh plugin add github:你/仓库` 验证 → 提 PR 申请收录。
npm 是可选的加速项，不是门槛。
