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

- 仓库已经改造成**单包形态**：仓库根目录就是 bundle（`index.js` + `cordis.patch.yml` + `dsh.bundle.patch`）。
  这样 `github:用户名/仓库` 装下来就是「引擎 + 插件」一整套，插件靠「上一级就是引擎根」自己找到引擎，不需要配置。
- 包名 `tuwen-studio` 在 npm 上**还没人占用**（查过了）。
- 注意：npm 上已经有一个 `dsh-video-studio`（作者 litao，0.4.3），做的是「把素材目录剪成片」，和这个不冲突但名字容易混。
- 这台机器上**还没有 git remote**，所以什么都还没发布。

---

## 步骤

### 1. 推到 GitHub

```powershell
cd D:\YannickFile\TuWenShiPin
git remote add origin https://github.com/<你的用户名>/tuwen-studio.git
git branch -M main
git push -u origin main
```

仓库名建议就叫 `tuwen-studio`，和包名一致，读者不容易搞混。

推上去之后，在 `package.json` 里补一行（可选但推荐，npm 和索引都会读）：

```json
"repository": { "type": "git", "url": "git+https://github.com/<你的用户名>/tuwen-studio.git" },
```

### 2. 自己先装一遍，确认别人也装得上

```powershell
dsh plugin --profile web add github:<你的用户名>/tuwen-studio
```

装完重开会话，看到 6 个 `video_studio_*` 工具就算成功。

> **这一步别跳。** `github:` 安装会跑 `postinstall` 下载 Chromium，走的是和本机不一样的环境；
> 别人的机器上没有你已经下好的浏览器和 ffmpeg，这里能通才说明分发包真的完整。

装错了就卸掉重来：

```powershell
dsh plugin --profile web remove tuwen-studio
```

### 3. 准备一张图标

市场条目里 `icon` 是必填的观感项：256×256 PNG，放到仓库里（例如 `assets/icon.png`），
推上去之后用 `https://raw.githubusercontent.com/<用户名>/tuwen-studio/main/assets/icon.png`
这样的地址，收录时会用。

### 4. 提交收录

打开 `github.com/awesome-dsh-plugin/awesome-dsh-plugin`，按 `contributing.md` 提 PR。要准备的东西：

```yaml
name: 图文视频工坊 · tuwen-studio
repo: https://github.com/<你的用户名>/tuwen-studio
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
icon: https://raw.githubusercontent.com/<你的用户名>/tuwen-studio/main/assets/icon.png
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
