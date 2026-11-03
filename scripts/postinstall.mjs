/**
 * 安装后置：把逐帧渲染要用的 Chromium 备好。
 *
 * 为什么不用 `npx playwright install`：npx 依赖网络去解析 shim，离线装的时候会卡住。
 * 这里直接调 playwright 自己的 cli.js，路径能从 node_modules 里解出来。
 *
 * 失败不阻断安装：很多人只是先装下来看看，网络受限时也应该装得上。
 * 真的缺浏览器，`tuwen doctor` 会明确告诉他跑哪条命令。
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';

const requireFromHere = createRequire(import.meta.url);

function chromiumReady() {
  try {
    const { chromium } = requireFromHere('playwright');
    const exe = chromium.executablePath();
    return Boolean(exe && existsSync(exe));
  } catch {
    return false;
  }
}

function playwrightCli() {
  try {
    const pkg = requireFromHere.resolve('playwright/package.json');
    const cli = path.join(path.dirname(pkg), 'cli.js');
    return existsSync(cli) ? cli : null;
  } catch {
    return null;
  }
}

if (chromiumReady()) {
  console.log('[tuwen] Chromium 已就绪，跳过下载。');
  process.exit(0);
}

const cli = playwrightCli();
if (!cli) {
  console.log('[tuwen] 没找到 playwright（可能用了 --omit=dev）。装完依赖后跑：tuwen doctor');
  process.exit(0);
}

console.log('[tuwen] 正在下载逐帧渲染要用的 Chromium（约 150MB，只需一次）…');
const r = spawnSync(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit' });

if (r.status !== 0) {
  console.log('');
  console.log('[tuwen] Chromium 没装成（通常是网络问题）。不影响安装完成，但还不能出片。');
  console.log('[tuwen] 网络恢复后跑一次：npx playwright install chromium');
  console.log('[tuwen] 或者用镜像：set PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright');
  // 安装脚本失败不该让 npm install 整体失败
  process.exit(0);
}
console.log('[tuwen] Chromium 就绪。下一步：tuwen doctor');
