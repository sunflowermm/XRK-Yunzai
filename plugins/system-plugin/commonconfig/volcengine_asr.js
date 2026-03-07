import ConfigBase from '../../../lib/commonconfig/commonconfig.js';
import { getServerConfigPath } from '../../../lib/config/config-constants.js';

/**
 * 火山引擎 ASR 工厂配置（与 XRK-AGT 对齐）
 *
 * 配置文件：data/server_bots/{port}/volcengine_asr.yaml
 * 管理语音识别：WebSocket 地址、App Key/Access Token、资源 ID、ITN/标点/说话人分离、结果类型与缓冲参数等。
 */
export default class VolcengineASRConfig extends ConfigBase {
  constructor() {
    super({
      name: 'volcengine_asr',
      displayName: '火山引擎 ASR 工厂配置',
      description: '火山引擎语音转文本（ASR）：连接地址与认证、逆文本标准化/标点/说话人分离、加速文本与持久连接等',
      filePath: (c) => getServerConfigPath(c?._port ?? 8086, 'volcengine_asr'),
      fileType: 'yaml',
      schema: {
        fields: {
          // WebSocket 连接配置
          wsUrl: {
            type: 'string',
            label: 'WebSocket 地址',
            description: '火山引擎 ASR WebSocket 服务地址',
            default: 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async',
            component: 'Input'
          },
          appKey: {
            type: 'string',
            label: 'App Key',
            description: '火山引擎控制台获取的APP ID',
            default: '',
            component: 'Input'
          },
          accessKey: {
            type: 'string',
            label: 'Access Key',
            description: '火山引擎控制台获取的Access Token（不是Secret Key）',
            default: '',
            component: 'InputPassword'
          },
          resourceId: {
            type: 'string',
            label: '资源 ID',
            description: '火山引擎 ASR 资源 ID',
            default: 'volc.bigasr.sauc.duration',
            component: 'Input'
          },
          
          // 功能开关配置
          enableItn: {
            type: 'boolean',
            label: '启用 ITN',
            description: '是否启用逆文本标准化',
            default: true,
            component: 'Switch'
          },
          enablePunc: {
            type: 'boolean',
            label: '启用标点',
            description: '是否启用标点符号识别',
            default: true,
            component: 'Switch'
          },
          enableDdc: {
            type: 'boolean',
            label: '启用 DDC',
            description: '是否启用说话人分离',
            default: false,
            component: 'Switch'
          },
          showUtterances: {
            type: 'boolean',
            label: '输出分片结果',
            description: '是否显示中间识别结果',
            default: true,
            component: 'Switch'
          },
          enableAccelerateText: {
            type: 'boolean',
            label: '启用加速文本',
            description: '是否启用加速文本输出',
            default: true,
            component: 'Switch'
          },
          
          // 结果类型配置
          resultType: {
            type: 'string',
            label: '结果类型',
            description: '识别结果类型（full, incremental）',
            enum: ['full', 'incremental'],
            default: 'full',
            component: 'Select'
          },
          
          // 参数配置
          accelerateScore: {
            type: 'number',
            label: '加速阈值',
            description: '加速文本输出的置信度阈值',
            min: 0,
            max: 100,
            default: 15,
            component: 'InputNumber'
          },
          persistentWs: {
            type: 'boolean',
            label: '持久连接',
            description: '是否保持 WebSocket 连接',
            default: true,
            component: 'Switch'
          },
          idleCloseMs: {
            type: 'number',
            label: '空闲断开时间 (ms)',
            description: '连接空闲多长时间后自动断开',
            min: 0,
            default: 6000,
            component: 'InputNumber'
          },
          endWindowSize: {
            type: 'number',
            label: '结束窗口大小',
            description: '检测结束的窗口大小',
            min: 0,
            default: 350,
            component: 'InputNumber'
          },
          forceToSpeechTime: {
            type: 'number',
            label: '强制语音检测时间 (ms)',
            description: '强制检测为语音的时间',
            min: 0,
            default: 500,
            component: 'InputNumber'
          },
          maxAudioBufferSize: {
            type: 'number',
            label: '最大音频缓冲 (秒)',
            description: '最大音频缓冲区大小',
            min: 1,
            default: 30,
            component: 'InputNumber'
          },
          asrFinalTextWaitMs: {
            type: 'number',
            label: '最终文本等待时间 (ms)',
            description: '等待最终文本输出的时间',
            min: 0,
            default: 1200,
            component: 'InputNumber'
          }
        }
      }
    });
  }
}

