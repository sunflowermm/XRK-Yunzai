import path from 'node:path';
import { FileUtils } from '../../utils/file-utils.js';
import { PLUGINS_DIR, resolveProjectPath } from '../../config/config-constants.js';

const segment = {
  custom(type, data) {
    return { type, ...data }
  },
  raw(data) {
    return { type: "raw", data }
  },
  button(...data) {
    return { type: "button", data }
  },
  markdown(data) {
    return { type: "markdown", data }
  },
  image(file, name) {
    return { type: "image", file, name }
  },
  at(qq, name) {
    return { type: "at", qq, name }
  },
  record(file, name) {
    return { type: "record", file, name }
  },
  video(file, name) {
    return { type: "video", file, name }
  },
  file(file, name) {
    return { type: "file", file, name }
  },
  reply(id, text, qq, time, seq) {
    return { type: "reply", id, text, qq, time, seq }
  },
  text(text) {
    return { type: "text", text }
  }
}

const icqqPath = path.join(resolveProjectPath(PLUGINS_DIR), 'ICQQ-Plugin/node_modules/icqq/lib/message/elements.js');
if (FileUtils.existsSync(icqqPath)) {
  try {
    const { segment: icqq_segment } = await import(FileUtils.toImportUrl(icqqPath, { cacheBust: false }));
    const { deprecate } = await import('node:util');
    for (const i in icqq_segment) {
      if (!segment[i]) {
        segment[i] = deprecate(icqq_segment[i], `segment.${i} 仅在 icqq 上可用`);
      }
    }
  } catch (err) {
    Bot.makeLog('debug', `[oicq] ICQQ segment 扩展失败: ${err?.message || err}`, 'oicq');
  }
}

export { segment }