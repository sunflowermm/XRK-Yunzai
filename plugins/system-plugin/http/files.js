import path from 'path';
import { ulid } from 'ulid';
import crypto from 'crypto';
import { FileUtils } from '../../../lib/utils/file-utils.js';
import { parseMultipartData } from '../../../lib/utils/multipart-parser.js';
import { getServerUploadLimits } from '../../../lib/utils/upload-limits.js';
import {
  resolveProjectPath,
  DATA_UPLOADS_DIR,
  DATA_MEDIA_DIR,
  TEMP_HTML_DIR,
} from '../../../lib/config/config-constants.js';
import { respondFail } from '../../../lib/http/utils/helpers.js';
import {
  registerUploadedFile,
  deleteUploadedFile,
  getUploadedFileSync,
  listUploadedFiles,
  getUploadedFileEntries,
} from '../../../lib/http/utils/uploadedFiles.js';

const uploadDir = resolveProjectPath(DATA_UPLOADS_DIR);
const mediaDir = resolveProjectPath(DATA_MEDIA_DIR);
const tempHtmlDir = resolveProjectPath(TEMP_HTML_DIR);
const UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MEDIA_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const TEMP_HTML_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/** 拼装 file_url 的 baseUrl，优先配置再请求头 */
function getBaseUrl(req, Bot) {
  const u = Bot?.url ?? (typeof Bot?.getServerUrl === 'function' ? Bot.getServerUrl() : null);
  if (u && String(u).startsWith('http')) return String(u).replace(/\/$/, '');
  if (req?.get) {
    const host = req.get('host') || req.get('x-forwarded-host');
    const protocol = req.get('x-forwarded-proto') || req.protocol || 'http';
    if (host) return `${protocol}://${host}`.replace(/\/$/, '');
  }
  return '';
}

/** 统一 404 响应 */
function notFound(res, message = '文件不存在') {
  return res.status(404).json({ success: false, message, code: 404 });
}

/** 统一拼装持久化 URL，避免重复逻辑 */
function buildFileUrls(baseUrl, pathPrefix, fileId, filename, isMedia) {
  const url = baseUrl ? `${baseUrl}/${pathPrefix}/${filename}` : `/${pathPrefix}/${filename}`;
  const download_url = baseUrl ? `${baseUrl}/api/file/download/${fileId}` : `/api/file/download/${fileId}`;
  const preview_url = isMedia ? (baseUrl ? `${baseUrl}/api/file/preview/${fileId}` : `/api/file/preview/${fileId}`) : null;
  return { url, download_url, preview_url };
}

/**
 * 根据MIME类型获取文件扩展名
 */
function getExtFromMime(mimeType) {
  const mimeMap = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'audio/mpeg': '.mp3',
    'audio/ogg': '.ogg',
    'audio/wav': '.wav',
    'application/pdf': '.pdf',
    'application/json': '.json',
    'text/plain': '.txt',
    'text/html': '.html'
  };
  return mimeMap[mimeType] || '.file';
}

/**
 * 文件管理API
 * 提供文件上传、下载、预览等功能
 */
export default {
  name: 'file',
  dsc: '文件管理API',
  priority: 95,

  routes: [
    {
      method: 'POST',
      path: '/api/file/upload',
      handler: async (req, res, Bot) => {

        try {
          const contentType = req.headers['content-type'] || '';
          let files = [];
          
          if (contentType.includes('multipart/form-data')) {
            try {
              const result = await parseMultipartData(req, getServerUploadLimits());
              files = result.files;
            } catch (uploadErr) {
              const isSize = /超过.*限制/.test(uploadErr?.message || '');
              return res.status(isSize ? 413 : 400).json({
                success: false,
                message: uploadErr?.message || '上传解析失败',
                code: isSize ? 413 : 400
              });
            }
          } else {
            return res.status(400).json({ 
              success: false, 
              message: '请使用 multipart/form-data 格式上传文件',
              code: 400
            });
          }

          if (files.length === 0) {
            return res.status(400).json({ 
              success: false, 
              message: '没有文件',
              code: 400
            });
          }

          const baseUrl = getBaseUrl(req, Bot);
          const uploadedFiles = [];

          for (const file of files) {
            const fileId = ulid();
            const ext = path.extname(file.originalname) || '.file';
            const filename = `${fileId}${ext}`;
            
            const isMedia = /\.(jpg|jpeg|png|gif|webp|mp4|webm|mp3|wav|ogg)$/i.test(ext);
            const targetDir = isMedia ? mediaDir : uploadDir;
            const targetPath = path.join(targetDir, filename);
            
            await FileUtils.writeFileBuffer(targetPath, file.buffer);
            
            const hash = crypto.createHash('md5').update(file.buffer).digest('hex');
            const pathPrefix = isMedia ? 'media' : 'uploads';
            const urls = buildFileUrls(baseUrl, pathPrefix, fileId, filename, isMedia);
            const fileInfo = {
              id: fileId,
              name: file.originalname,
              path: targetPath,
              ...urls,
              size: file.size,
              mime: file.mimetype,
              hash,
              is_media: isMedia,
              upload_time: Date.now()
            };

            registerUploadedFile(fileInfo);
            uploadedFiles.push(fileInfo);
          }

          const results = uploadedFiles.map(fileInfo => ({
            type: fileInfo.is_media ? 'image' : 'file',
            data: [{
              type: fileInfo.is_media ? 'image' : 'file',
              url: fileInfo.url,
              name: fileInfo.name,
              size: fileInfo.size,
              mime: fileInfo.mime,
              download_url: fileInfo.download_url,
              preview_url: fileInfo.preview_url
            }]
          }));

          if (files.length === 1) {
            const fileInfo = uploadedFiles[0];
            res.json({
              success: true,
              code: 200,
              file_id: fileInfo.id,
              file_url: fileInfo.url,
              file_name: fileInfo.name,
              results: results,
              timestamp: Date.now()
            });
          } else {
            res.json({
              success: true,
              code: 200,
              files: uploadedFiles.map(f => ({
                file_id: f.id,
                file_url: f.url,
                file_name: f.name
              })),
              results: results,
              timestamp: Date.now()
            });
          }
        } catch (error) {
          return respondFail(res, 500, '文件上传失败', 'FilesAPI', error);
        }
      }
    },

    {
      method: 'GET',
      path: '/api/file/:id',
      handler: async (req, res, Bot) => {
        const { id } = req.params;
        const fileInfo = getUploadedFileSync(id);

        if (!fileInfo) {
          try {
            for (const dir of [uploadDir, mediaDir]) {
              const files = FileUtils.existsSync(dir) ? FileUtils.readDirSync(dir) : [];
              const file = files.find(f => f.includes(id));
              if (file) {
                const filePath = path.join(dir, file);
                return res.sendFile(filePath);
              }
            }
          } catch (err) {
            Bot.makeLog('error', `查找文件失败: ${err.message}`, 'FilesAPI');
          }
          
          return notFound(res);
        }

        if (!FileUtils.existsSync(fileInfo.path)) {
          deleteUploadedFile(id);
          return notFound(res);
        }
        res.sendFile(fileInfo.path);
      }
    },

    {
      method: 'GET',
      path: '/api/file/download/:id',
      handler: async (req, res, Bot) => {
        const { id } = req.params;
        const fileInfo = getUploadedFileSync(id);

        if (!fileInfo) return notFound(res);

        if (!FileUtils.existsSync(fileInfo.path)) {
          deleteUploadedFile(id);
          return notFound(res);
        }
        res.download(fileInfo.path, fileInfo.name);
      }
    },

    {
      method: 'GET',
      path: '/api/file/preview/:id',
      handler: async (req, res, Bot) => {
        const { id } = req.params;
        const fileInfo = getUploadedFileSync(id);

        if (!fileInfo || !fileInfo.is_media) return notFound(res, '预览不可用');

        if (!FileUtils.existsSync(fileInfo.path)) {
          deleteUploadedFile(id);
          return notFound(res);
        }
        res.setHeader('Content-Type', fileInfo.mime);
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.sendFile(fileInfo.path);
      }
    },

    {
      method: 'DELETE',
      path: '/api/file/:id',
      handler: async (req, res, Bot) => {

        const { id } = req.params;
        const fileInfo = getUploadedFileSync(id);

        if (fileInfo) {
          try {
            await FileUtils.unlink(fileInfo.path);
            deleteUploadedFile(id);
          } catch (err) {
            Bot.makeLog('error', `删除文件失败: ${err.message}`, 'FilesAPI');
          }
        }

        res.json({ 
          success: true, 
          message: '文件已删除',
          code: 200,
          timestamp: Date.now()
        });
      }
    },

    {
      method: 'GET',
      path: '/api/files',
      handler: async (req, res, Bot) => {

        const files = listUploadedFiles().map(f => ({
          id: f.id,
          name: f.name,
          url: f.url,
          size: f.size,
          mime: f.mime,
          is_media: f.is_media,
          upload_time: f.upload_time
        }));

        res.json({ 
          success: true, 
          files,
          total: files.length,
          timestamp: Date.now()
        });
      }
    },

    {
      method: 'POST',
      path: '/api/file/upload-base64',
      handler: async (req, res, Bot) => {

        const { data, filename = 'file', mime = 'application/octet-stream' } = req.body;

        if (!data) {
          return res.status(400).json({ 
            success: false, 
            message: '缺少文件数据',
            code: 400
          });
        }

        try {
          let base64Data = data;
          if (data.includes(',')) {
            base64Data = data.split(',')[1];
          }
          
          const buffer = Buffer.from(base64Data, 'base64');
          
          const ext = path.extname(filename) || getExtFromMime(mime);
          const fileId = ulid();
          const finalFilename = `${fileId}${ext}`;
          
          const isMedia = /^(image|video|audio)\//.test(mime);
          const targetDir = isMedia ? mediaDir : uploadDir;
          const targetPath = path.join(targetDir, finalFilename);
          
          await FileUtils.writeFileBuffer(targetPath, buffer);
          const baseUrl = getBaseUrl(req, Bot);
          const pathPrefix = isMedia ? 'media' : 'uploads';
          const urls = buildFileUrls(baseUrl, pathPrefix, fileId, finalFilename, isMedia);
          const fileInfo = {
            id: fileId,
            name: filename,
            path: targetPath,
            ...urls,
            size: buffer.length,
            mime,
            is_media: isMedia,
            upload_time: Date.now()
          };

          registerUploadedFile(fileInfo);

          const results = [{
            type: isMedia ? 'image' : 'file',
            data: [{
              type: isMedia ? 'image' : 'file',
              url: fileInfo.url,
              name: fileInfo.name,
              size: fileInfo.size,
              mime: fileInfo.mime,
              download_url: fileInfo.download_url,
              preview_url: fileInfo.preview_url
            }]
          }];

          res.json({
            success: true,
            code: 200,
            file_id: fileId,
            file_url: fileInfo.url,
            file_name: fileInfo.name,
            results: results,
            timestamp: Date.now()
          });
        } catch (error) {
          return respondFail(res, 500, '文件上传失败', 'FilesAPI', error);
        }
      }
    }
  ],

  init(app, Bot) {
    setInterval(async () => {
      const now = Date.now();
      for (const [id, info] of getUploadedFileEntries()) {
        if (now - info.upload_time > UPLOAD_MAX_AGE_MS) {
          try {
            await FileUtils.unlink(info.path);
            deleteUploadedFile(id);
          } catch (err) {
            Bot.makeLog('debug', `[files] 清理过期上传失败 id=${id}: ${err?.message || err}`, 'FilesAPI');
          }
        }
      }
      const mediaN = await FileUtils.cleanDirByMaxAge(mediaDir, MEDIA_MAX_AGE_MS);
      const tempN = await FileUtils.cleanDirByMaxAge(tempHtmlDir, TEMP_HTML_MAX_AGE_MS, true);
      if (mediaN + tempN > 0) Bot.makeLog('debug', `清理过期媒体/临时: data/media ${mediaN} 个, temp/html ${tempN} 个`, 'FilesAPI');
    }, CLEANUP_INTERVAL_MS);
  }
};