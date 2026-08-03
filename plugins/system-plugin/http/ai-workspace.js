/**
 * AI 对话工作区 API（对齐 XRK-AGT ai-workspace.js）
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import multer from 'multer';
import { respondFail } from '../../../lib/http/utils/helpers.js';
import { getServerUploadLimits } from '../../../lib/utils/upload-limits.js';
import {
  normalizePresetId,
  getConfiguredDefaultWorkspaceId,
  listWorkspacePresets,
  listPresetFiles,
  listWorkspaceFiles,
  readPresetAgents,
  writePresetAgents,
  resolvePresetDownload,
  resolvePresetOrThrow,
  parseRequestWorkspace,
  createAgentWorkspace,
  sanitizeWorkspaceUploadName,
  openWorkspaceFileDownload
} from '../lib/ai-workspace-runtime.js';
import { readAuditTail } from '../lib/ai-workspace-audit.js';
import { installMcpAuditHook } from '../lib/ai-workspace-context.js';

function ensureAuditHook() {
  installMcpAuditHook();
}

function success(res, data, message) {
  const body = { success: true, data };
  if (message) body.message = message;
  res.json(body);
}

function badRequest(res, message) {
  return respondFail(res, 400, message, 'AIWorkspace');
}

function parsePresetId(req) {
  const raw = req.query.workspace ?? req.query.id ?? req.body?.workspace ?? getConfiguredDefaultWorkspaceId();
  return normalizePresetId(String(raw ?? '').trim() || getConfiguredDefaultWorkspaceId());
}

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

function decodeUploadName(name) {
  try {
    return Buffer.from(String(name || ''), 'latin1').toString('utf8');
  } catch {
    return String(name || 'file');
  }
}

function createWorkspaceUploader(destDir, maxBytes) {
  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, destDir),
    filename: (_req, file, cb) => {
      const safe = sanitizeWorkspaceUploadName(decodeUploadName(file.originalname));
      cb(null, safe);
    }
  });
  return multer({
    storage,
    limits: { fileSize: maxBytes, files: 8 }
  }).any();
}

export default {
  name: 'ai-workspace',
  dsc: 'AI 对话工作区：预设、文件、规则、审计',
  priority: 79,

  routes: [
    {
      method: 'GET',
      path: '/api/ai/workspaces',
      handler: async (_req, res) => {
        ensureAuditHook();
        const presets = listWorkspacePresets().map((p) => ({
          id: p.id,
          label: p.label,
          description: p.description,
          kind: p.kind
        }));
        success(res, { workspaces: presets, defaultId: getConfiguredDefaultWorkspaceId() });
      }
    },
    {
      method: 'POST',
      path: '/api/ai/workspaces',
      handler: async (req, res) => {
        ensureAuditHook();
        const id = String(req.body?.id || req.body?.name || '').trim();
        if (!id) return badRequest(res, 'id 不能为空');
        try {
          const created = createAgentWorkspace(id);
          success(res, created, '工作区已创建');
        } catch (err) {
          return badRequest(res, err.message || '创建失败');
        }
      }
    },
    {
      method: 'GET',
      path: '/api/ai/workspace/files',
      handler: async (req, res) => {
        ensureAuditHook();
        const workspace = parsePresetId(req);
        const subdir = String(req.query.dir ?? '').trim();
        const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 120));
        try {
          const result = await listPresetFiles(workspace, { subdir, limit });
          success(res, {
            workspace,
            root: result.root,
            dir: result.dir,
            files: result.files,
            ...(result.error ? { hint: result.error } : {})
          });
        } catch (err) {
          return badRequest(res, err.message || '无效工作区');
        }
      }
    },
    {
      method: 'POST',
      path: '/api/ai/workspace/files/upload',
      handler: async (req, res, Bot) => {
        ensureAuditHook();
        const workspace = parsePresetId(req);
        const subdir = String(req.query.dir ?? req.body?.dir ?? '').trim();
        const ctx = parseRequestWorkspace({ workspace: { id: workspace } });
        const contentType = req.headers['content-type'] || '';
        if (!contentType.includes('multipart/form-data')) {
          return badRequest(res, '请使用 multipart/form-data 上传');
        }
        const maxFileSize = getServerUploadLimits().maxFileBytes;
        let destDir;
        try {
          const listed = listWorkspaceFiles(ctx.fileRootAbs, subdir);
          destDir = path.resolve(ctx.fileRootAbs, listed.dir || '.');
          await fs.mkdir(destDir, { recursive: true });
        } catch (err) {
          return badRequest(res, err.message || '无效目录');
        }
        let files = [];
        try {
          const upload = createWorkspaceUploader(destDir, maxFileSize);
          await new Promise((resolve, reject) => upload(req, res, (err) => (err ? reject(err) : resolve())));
          files = Array.isArray(req.files) ? req.files : [];
        } catch (e) {
          return respondFail(res, 400, e?.message || '上传失败', 'AIWorkspace', e);
        }
        if (!files.length) return badRequest(res, '没有文件');
        const baseUrl = getBaseUrl(req, Bot);
        const relDir = String(subdir || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        const uploaded = files.map((f) => {
          const name = path.basename(f.filename || f.originalname || 'file');
          const relPath = relDir ? `${relDir}/${name}` : name;
          const serveUrl = `${baseUrl}/api/ai/workspace/files/serve?workspace=${encodeURIComponent(workspace)}&path=${encodeURIComponent(relPath)}`;
          return { name, path: relPath, size: f.size, url: serveUrl };
        });
        success(res, { workspace, dir: relDir, files: uploaded }, '上传成功');
      }
    },
    {
      method: 'GET',
      path: '/api/ai/workspace/files/serve',
      handler: async (req, res) => {
        ensureAuditHook();
        const workspace = parsePresetId(req);
        const filePath = String(req.query.path || '').trim();
        if (!filePath) return badRequest(res, 'path 不能为空');
        const ctx = parseRequestWorkspace({ workspace: { id: workspace } });
        try {
          const { abs, name } = openWorkspaceFileDownload(ctx.fileRootAbs, filePath);
          res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(name)}"`);
          return res.sendFile(abs);
        } catch (err) {
          return badRequest(res, err.message || '无法读取文件');
        }
      }
    },
    {
      method: 'GET',
      path: '/api/ai/workspace/files/download',
      handler: async (req, res) => {
        ensureAuditHook();
        const workspace = parsePresetId(req);
        const filePath = String(req.query.path || '').trim();
        if (!filePath) return badRequest(res, 'path 不能为空');
        try {
          const { abs, basename } = await resolvePresetDownload(workspace, filePath);
          return res.download(abs, basename);
        } catch (err) {
          return badRequest(res, err.message || '无法下载');
        }
      }
    },
    {
      method: 'GET',
      path: '/api/ai/workspace/agents',
      handler: async (req, res) => {
        ensureAuditHook();
        const workspace = parsePresetId(req);
        try {
          resolvePresetOrThrow(workspace);
          const data = await readPresetAgents(workspace);
          success(res, { workspace, ...data });
        } catch (err) {
          return badRequest(res, err.message || '读取失败');
        }
      }
    },
    {
      method: 'PUT',
      path: '/api/ai/workspace/agents',
      handler: async (req, res) => {
        ensureAuditHook();
        const workspace = parsePresetId(req);
        const content = req.body?.content;
        if (typeof content !== 'string') {
          return badRequest(res, 'content 必须为字符串');
        }
        try {
          const saved = await writePresetAgents(workspace, content);
          success(res, { workspace, ...saved }, '规则已保存');
        } catch (err) {
          return badRequest(res, err.message || '保存失败');
        }
      }
    },
    {
      method: 'GET',
      path: '/api/ai/workspace/audit',
      handler: async (req, res) => {
        ensureAuditHook();
        const workspace = parsePresetId(req);
        try {
          resolvePresetOrThrow(workspace);
          const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
          const entries = await readAuditTail(workspace, limit);
          success(res, { workspace, entries });
        } catch (err) {
          return badRequest(res, err.message || '无效工作区');
        }
      }
    }
  ]
};
