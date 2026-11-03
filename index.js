/**
 * 这个包的入口是给 DSH 用的：DSH 按 cordis.patch.yml 里的 name 找到本包，
 * 然后 import 它的默认导出，期望拿到 { name, inject, apply }。
 *
 * 插件本体和引擎住在同一个仓库里，所以它可以靠「上一级就是引擎根」自动定位自己，
 * 不需要写死任何路径，也不需要用户配 engineDir。
 */
export { name, inject, apply } from './plugin-video-studio/index.js';
