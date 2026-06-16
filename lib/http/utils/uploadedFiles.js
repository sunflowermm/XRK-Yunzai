import path from 'path';
import { FileUtils } from '../../utils/file-utils.js';
import { resolveProjectPath, DATA_UPLOADS_DIR, DATA_MEDIA_DIR } from '../../config/config-constants.js';

const uploadDir = resolveProjectPath(DATA_UPLOADS_DIR);
const mediaDir = resolveProjectPath(DATA_MEDIA_DIR);
const fileMap = new Map();

export function registerUploadedFile(info) {
  if (info?.id) fileMap.set(info.id, info);
}

export function deleteUploadedFile(id) {
  fileMap.delete(id);
}

export function getUploadedFileSync(id) {
  return fileMap.get(id);
}

export function listUploadedFiles() {
  return Array.from(fileMap.values());
}

/** 供 files 模块定时清理 */
export function getUploadedFileEntries() {
  return fileMap;
}

export async function getUploadedFile(id) {
  const cached = fileMap.get(id);
  if (cached) {
    if (await FileUtils.exists(cached.path)) return cached;
    fileMap.delete(id);
  }

  for (const dir of [mediaDir, uploadDir]) {
    if (!FileUtils.existsSync(dir)) continue;
    const files = FileUtils.readDirSync(dir);
    const name = files.find(f => f.includes(id));
    if (!name) continue;
    const filePath = path.join(dir, name);
    const ext = path.extname(name);
    const isMedia = /\.(jpg|jpeg|png|gif|webp|mp4|webm|mp3|wav|ogg)$/i.test(ext);
    const info = { id, path: filePath, name, is_media: isMedia };
    fileMap.set(id, info);
    return info;
  }
  return null;
}
