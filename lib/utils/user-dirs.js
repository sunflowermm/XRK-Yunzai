/**
 * 用户目录解析（跨平台），供 BaseTools、DesktopStream 等复用
 */
import path from 'path';
import os from 'os';
import { FileUtils } from './file-utils.js';

/**
 * 同步解析默认桌面目录（构造期/无 await 场景）
 */
export function getDefaultDesktopDirSync() {
  const home = os.homedir();

  if (process.env.XDG_USER_DESKTOP_DIR) {
    const xdg = path.normalize(process.env.XDG_USER_DESKTOP_DIR);
    if (FileUtils.existsSync(xdg)) return xdg;
  }

  for (const name of ['Desktop', '桌面']) {
    const p = path.join(home, name);
    if (FileUtils.existsSync(p)) return path.normalize(p);
  }

  return path.normalize(path.join(home, 'Desktop'));
}
