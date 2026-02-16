/**
 * AI 助手配置（data/ai/config.yaml）
 * 供配置管理 API 与前端编辑使用，与 plugin/ai.js 读取的为同一文件。
 * 注册键名：system-plugin_ai_config（由 loader 按 插件名_文件名 规则生成）。
 */
import ConfigBase from '../../../lib/commonconfig/commonconfig.js';
import path from 'path';
import fs from 'fs/promises';
import BotUtil from '../../../lib/util.js';

export default class AIConfig extends ConfigBase {
  constructor() {
    super({
      name: 'ai_config',
      displayName: 'AI 助手配置',
      description: 'XRK-AI 助手的触发条件、人设与合并工作流（data/ai/config.yaml）',
      filePath: 'data/ai/config.yaml',
      fileType: 'yaml',
      schema: {
        fields: {
          persona: {
            type: 'string',
            label: '人设',
            description: '系统提示中的角色描述，会传入聊天工作流',
            default: '你是本群聊天助手，正常聊天、解决问题，不刻意卖萌或复读固定话术。',
            component: 'Textarea'
          },
          prefix: {
            type: 'string',
            label: '触发前缀',
            description: '消息以此开头且在白名单内时触发',
            default: '',
            component: 'Input'
          },
          groups: {
            type: 'array',
            label: '白名单群',
            description: '仅这些群可触发（@ 或前缀或随机）',
            itemType: 'string',
            default: [],
            component: 'Tags'
          },
          users: {
            type: 'array',
            label: '白名单用户',
            description: '私聊仅这些用户可触发',
            itemType: 'string',
            default: [],
            component: 'Tags'
          },
          cooldown: {
            type: 'number',
            label: '随机触发冷却（秒）',
            description: '群内随机触发冷却时间',
            min: 0,
            default: 300,
            component: 'InputNumber'
          },
          chance: {
            type: 'number',
            label: '随机触发概率',
            description: '0～1，如 0.1 表示 10%',
            min: 0,
            max: 1,
            default: 0.1,
            component: 'InputNumber'
          },
          mergeStreams: {
            type: 'array',
            label: '合并工作流',
            description: '要合并到 chat 的副工作流名称，如 memory、tools、database',
            itemType: 'string',
            default: ['memory', 'tools', 'database'],
            component: 'Tags'
          }
        }
      }
    });
  }

  /** 文件不存在时先建目录、写默认值再读 */
  async read(useCache = true) {
    try {
      return await super.read(useCache);
    } catch (error) {
      if (error.code !== 'ENOENT' && !error.message?.includes('不存在')) {
        BotUtil.makeLog('error', `读取 AI 配置失败: ${error.message}`, 'AIConfig', error);
        throw error;
      }
      const filePath = this.getFilePath();
      await fs.mkdir(path.dirname(filePath), { recursive: true }).catch(() => {});
      const defaultData = {};
      for (const [key, meta] of Object.entries(this.schema?.fields || {})) {
        if (meta.default !== undefined) defaultData[key] = meta.default;
      }
      await this.write(defaultData, { backup: false, validate: false });
      this._cache = defaultData;
      this._cacheTime = Date.now();
      return defaultData;
    }
  }
}
