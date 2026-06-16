/**
 * 工作区 memory/*.md 受限读写
 */
import AIStream from '../../../lib/aistream/aistream.js';
import {
  appendWorkspaceMemory,
  listWorkspaceMemoryFiles,
  readWorkspaceMemory,
  searchWorkspaceMemory,
  writeWorkspaceMemory
} from '../../../lib/utils/agent-workspace-memory.js';
import { resolveWorkspaceAbsFromContext } from '../../../lib/utils/agent-workspace-paths.js';

export default class MemoryStream extends AIStream {
  constructor() {
    super({
      name: 'memory',
      description: '工作区 Markdown 记忆',
      version: '2.0.0',
      author: 'XRK',
      priority: 1,
      config: { enabled: true }
    });
  }

  async init() {
    await super.init();
    this.registerAllFunctions();
  }

  _scopeFromContext(context = {}) {
    const e = context?.e;
    return {
      userId: e?.user_id ?? e?.user?.id ?? null,
      groupId: e?.group_id ?? null,
      scene: e?.group_id ? 'group' : (e?.user_id ? 'private' : 'default')
    };
  }

  registerAllFunctions() {
    this.registerMCPTool('read_memory', {
      description: '读取 memory/MEMORY.md、当日流水或群/用户 scoped 文件。',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'MEMORY | today | group | user' }
        },
        required: []
      },
      handler: async (args = {}, context = {}) => {
        const ws = resolveWorkspaceAbsFromContext(context);
        const data = await readWorkspaceMemory(ws, args.target || 'MEMORY', this._scopeFromContext(context));
        return { success: true, data };
      },
      enabled: true
    });

    this.registerMCPTool('append_memory', {
      description: '向工作区记忆文件追加内容。用户说「记住」时使用。',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string' },
          target: { type: 'string', description: 'MEMORY | today | group | user' }
        },
        required: ['content']
      },
      handler: async (args = {}, context = {}) => {
        const { content, target } = args;
        if (!content?.trim()) return { success: false, error: '记忆内容不能为空' };
        const ws = resolveWorkspaceAbsFromContext(context);
        const scope = this._scopeFromContext(context);
        let memTarget = target || 'MEMORY';
        if (!target && scope.scene === 'group') memTarget = 'group';
        try {
          const data = await appendWorkspaceMemory(ws, content, { target: memTarget, ...scope });
          return { success: true, data: { ...data, message: '记忆已追加' } };
        } catch (err) {
          return { success: false, error: err?.message || String(err) };
        }
      },
      enabled: true
    });

    this.registerMCPTool('write_memory', {
      description: '整文件覆盖指定记忆文件（不可覆盖 MEMORY.md）。',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string' },
          target: { type: 'string' }
        },
        required: ['content', 'target']
      },
      handler: async (args = {}, context = {}) => {
        const { content, target } = args;
        if (!target || target === 'MEMORY') {
          return { success: false, error: 'MEMORY.md 请用 append_memory' };
        }
        const ws = resolveWorkspaceAbsFromContext(context);
        try {
          const data = await writeWorkspaceMemory(ws, content, { target, ...this._scopeFromContext(context) });
          return { success: true, data };
        } catch (err) {
          return { success: false, error: err?.message || String(err) };
        }
      },
      enabled: true
    });

    this.registerMCPTool('list_memory_files', {
      description: '列出 memory/ 下允许的 Markdown 文件。',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async (_args = {}, context = {}) => {
        const files = listWorkspaceMemoryFiles(resolveWorkspaceAbsFromContext(context));
        return { success: true, data: { files, count: files.length } };
      },
      enabled: true
    });

    this.registerMCPTool('search_memory', {
      description: '在 memory/*.md 中按关键词检索。',
      inputSchema: {
        type: 'object',
        properties: {
          keyword: { type: 'string' },
          limit: { type: 'number' }
        },
        required: ['keyword']
      },
      handler: async (args = {}, context = {}) => {
        if (!args.keyword?.trim()) return { success: false, error: '关键词不能为空' };
        const hits = await searchWorkspaceMemory(
          resolveWorkspaceAbsFromContext(context),
          args.keyword,
          args.limit ?? 20
        );
        return { success: true, data: { keyword: args.keyword, hits, count: hits.length } };
      },
      enabled: true
    });
  }

  buildSystemPrompt() {
    return [
      '工作区 memory/*.md 可跨会话保留事实；写入用 append_memory，检索用 search_memory。',
      '勿用 tools.write 改 memory/；勿写密钥。'
    ].join('\n');
  }

  async buildChatContext() {
    return [];
  }
}
