import ConfigBase from '../../lib/commonconfig/commonconfig.js';

/**
 * 工具配置管理
 * 管理终端命令执行、权限控制等相关配置
 */
export default class ToolConfig extends ConfigBase {
  constructor() {
    super({
      name: 'tool',
      displayName: '工具配置',
      description: '终端命令执行、权限控制、安全设置等配置',
      filePath: 'config/cmd/tools.yaml',
      fileType: 'yaml',
      schema: {
        required: [],
        fields: {
          permission: {
            type: 'string',
            label: '权限级别',
            description: '可执行命令的权限级别。master: 仅主人, admin: 管理员, all: 所有人',
            enum: ['master', 'admin', 'all'],
            default: 'master',
            component: 'Select'
          },
          blacklist: {
            type: 'boolean',
            label: '启用黑名单过滤',
            description: '是否启用黑名单关键词过滤，禁止执行危险命令',
            default: true,
            component: 'Switch'
          },
          ban: {
            type: 'array',
            label: '禁止执行的命令关键词',
            description: '禁止执行的命令关键词列表，匹配到这些关键词的命令将被拒绝执行',
            itemType: 'string',
            default: ['rm -rf', 'sudo', 'shutdown', 'reboot'],
            component: 'Tags'
          },
          shell: {
            type: 'boolean',
            label: '使用系统Shell',
            description: '是否使用系统shell执行命令',
            default: true,
            component: 'Switch'
          },
          timeout: {
            type: 'number',
            label: '命令超时时间',
            description: '命令执行超时时间（毫秒）',
            min: 1000,
            max: 3600000,
            default: 300000,
            component: 'InputNumber'
          },
          maxHistory: {
            type: 'number',
            label: '历史记录最大条数',
            description: '保存的历史记录最大条数',
            min: 1,
            max: 10000,
            default: 100,
            component: 'InputNumber'
          },
          updateInterval: {
            type: 'number',
            label: '更新间隔',
            description: '长时间命令的输出更新间隔（毫秒）',
            min: 100,
            max: 60000,
            default: 3000,
            component: 'InputNumber'
          },
          maxOutputLength: {
            type: 'number',
            label: '最大输出长度',
            description: '命令输出的最大长度（字符数）',
            min: 100,
            max: 1000000,
            default: 5000,
            component: 'InputNumber'
          },
          saveChunkedOutput: {
            type: 'boolean',
            label: '保存分块输出',
            description: '是否保存分块输出并合并显示',
            default: true,
            component: 'Switch'
          },
          maxObjectDepth: {
            type: 'number',
            label: '对象检查最大深度',
            description: '对象检查时的最大递归深度',
            min: 1,
            max: 20,
            default: 4,
            component: 'InputNumber'
          },
          circularDetection: {
            type: 'boolean',
            label: '检测循环引用',
            description: '是否检测对象中的循环引用',
            default: true,
            component: 'Switch'
          },
          printMode: {
            type: 'string',
            label: '打印模式',
            description: '对象打印模式。full: 完整显示, simple: 简化显示',
            enum: ['full', 'simple'],
            default: 'full',
            component: 'Select'
          },
        }
      }
    });
  }

  /**
   * 获取配置结构
   * @returns {Object}
   */
  getStructure() {
    return {
      name: this.name,
      displayName: this.displayName,
      description: this.description,
      schema: this.schema,
      fields: this.schema?.fields || {}
    };
  }
}

