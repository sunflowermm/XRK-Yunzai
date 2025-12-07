import ConfigBase from '../../lib/commonconfig/commonconfig.js';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import yaml from 'yaml';
import BotUtil from '../../lib/common/util.js';

/**
 * 系统配置管理
 * 管理所有系统级配置文件
 */
export default class SystemConfig extends ConfigBase {
  constructor() {
    super({
      name: 'system',
      displayName: '系统配置',
      description: 'XRK-Yunzai 系统配置管理',
      filePath: '', // 系统配置管理多个文件，此处留空
      fileType: 'yaml'
    });

    // 辅助函数：生成基于端口的动态路径
    const getConfigPath = (configName) => {
      return (cfg) => {
        // 从 cfg 获取端口，路径格式：data/server_bots/{port}/{name}.yaml
        const port = cfg?._port || cfg?.server?.server?.port || 8086;
        return port ? `data/server_bots/${port}/${configName}.yaml` : `config/config/${configName}.yaml`;
      };
    };

    // 定义所有系统配置文件
    // 使用动态路径函数，基于端口获取正确路径
    this.configFiles = {
      bot: {
        name: 'bot',
        displayName: '机器人配置',
        description: '机器人核心配置，包括日志、文件监听、Puppeteer等',
        filePath: getConfigPath('bot'),
        fileType: 'yaml',
        schema: {
          required: ['log_level'],
          fields: {
            log_level: {
              type: 'string',
              label: '日志等级',
              description: '日志输出等级。Mark时只显示执行命令，不显示聊天记录',
              enum: ['trace', 'debug', 'info', 'warn', 'fatal', 'mark', 'error', 'off'],
              default: 'info',
              component: 'Select'
            },
            log_align: {
              type: 'string',
              label: '日志头内容',
              description: '日志头内容自定义显示，例如设置为"XRKYZ"将显示[XRKYZ]',
              default: 'XRKYZ',
              component: 'Input'
            },
            log_color: {
              type: 'string',
              label: '日志头颜色方案',
              description: '选择日志头的颜色主题',
              enum: ['default', 'scheme1', 'scheme2', 'scheme3', 'scheme4', 'scheme5', 'scheme6', 'scheme7'],
              default: 'default',
              component: 'Select'
            },
            log_id_length: {
              type: 'number',
              label: '日志ID长度',
              description: '日志ID长度（默认16个字符）',
              min: 1,
              max: 64,
              default: 20,
              component: 'InputNumber'
            },
            log_id_filler: {
              type: 'string',
              label: 'ID美化字符',
              description: 'ID显示时的美化字符（用于填充空白）',
              enum: ['.', '·', '─', '•', '═', '»', '→'],
              default: '.',
              component: 'Select'
            },
            log_object: {
              type: 'object',
              label: '日志对象检查',
              description: '日志对象检查配置',
              component: 'SubForm',
              fields: {
                depth: {
                  type: 'number',
                  label: '检查深度',
                  min: 1,
                  default: 10,
                  component: 'InputNumber'
                },
                colors: {
                  type: 'boolean',
                  label: '彩色输出',
                  default: true,
                  component: 'Switch'
                },
                showHidden: {
                  type: 'boolean',
                  label: '显示隐藏属性',
                  default: true,
                  component: 'Switch'
                },
                showProxy: {
                  type: 'boolean',
                  label: '显示代理对象',
                  default: true,
                  component: 'Switch'
                },
                getters: {
                  type: 'boolean',
                  label: '显示getters',
                  default: true,
                  component: 'Switch'
                },
                breakLength: {
                  type: 'number',
                  label: '换行长度',
                  min: 1,
                  default: 100,
                  component: 'InputNumber'
                },
                maxArrayLength: {
                  type: 'number',
                  label: '最大数组长度',
                  min: 1,
                  default: 100,
                  component: 'InputNumber'
                },
                maxStringLength: {
                  type: 'number',
                  label: '最大字符串长度',
                  min: 1,
                  default: 1000,
                  component: 'InputNumber'
                }
              }
            },
            ignore_self: {
              type: 'boolean',
              label: '过滤自己',
              description: '群聊和频道中过滤自己的消息',
              default: true,
              component: 'Switch'
            },
            '/→#': {
              type: 'boolean',
              label: '斜杠转井号',
              description: '自动把 / 换成 #',
              default: true,
              component: 'Switch'
            },
            file_watch: {
              type: 'boolean',
              label: '监听文件变化',
              description: '是否监听文件变化',
              default: true,
              component: 'Switch'
            },
            online_msg_exp: {
              type: 'number',
              label: '上线推送冷却',
              description: '上线推送通知的冷却时间（秒）',
              min: 0,
              default: 86400,
              component: 'InputNumber'
            },
            file_to_url_time: {
              type: 'number',
              label: '文件URL有效时间',
              description: '文件URL有效时间（分钟）',
              min: 1,
              default: 60,
              component: 'InputNumber'
            },
            file_to_url_times: {
              type: 'number',
              label: '文件URL访问次数',
              description: '文件URL访问次数限制',
              min: 1,
              default: 5,
              component: 'InputNumber'
            },
            chromium_path: {
              type: 'string',
              label: 'chromium路径',
              description: 'chromium其他路径，默认无需填写',
              default: '',
              component: 'Input'
            },
            puppeteer_ws: {
              type: 'string',
              label: 'puppeteer接口地址',
              description: 'puppeteer接口地址，默认无需填写',
              default: '',
              component: 'Input'
            },
            puppeteer_timeout: {
              type: 'number',
              label: 'puppeteer截图超时时间',
              description: 'puppeteer截图超时时间（毫秒）',
              min: 0,
              default: 0,
              component: 'InputNumber'
            },
            cache_group_member: {
              type: 'boolean',
              label: '缓存群成员列表',
              description: '是否缓存群成员列表',
              default: true,
              component: 'Switch'
            }
          }
        }
      },

      server: {
        name: 'server',
        displayName: '服务器配置',
        description: 'HTTP/HTTPS服务器、反向代理、SSL证书等配置',
        filePath: getConfigPath('server'),
        fileType: 'yaml',
        schema: {
          fields: {
            server: {
              type: 'object',
              label: '基础配置',
              component: 'SubForm',
              fields: {
                name: {
                  type: 'string',
                  label: '服务器名称',
                  default: 'XRK Server',
                  component: 'Input'
                },
                host: {
                  type: 'string',
                  label: '监听地址',
                  description: '0.0.0.0: 监听所有网络接口，127.0.0.1: 仅监听本地',
                  default: '0.0.0.0',
                  component: 'Input'
                },
                url: {
                  type: 'string',
                  label: '外部访问URL',
                  description: '用于生成完整的访问链接，留空则自动检测',
                  default: 'http://127.0.0.1',
                  component: 'Input'
                }
              }
            },
            proxy: {
              type: 'object',
              label: '反向代理配置',
              component: 'SubForm',
              fields: {
                enabled: {
                  type: 'boolean',
                  label: '启用反向代理',
                  default: false,
                  component: 'Switch'
                },
                httpPort: {
                  type: 'number',
                  label: 'HTTP端口',
                  min: 1,
                  max: 65535,
                  default: 80,
                  component: 'InputNumber'
                },
                httpsPort: {
                  type: 'number',
                  label: 'HTTPS端口',
                  min: 1,
                  max: 65535,
                  default: 443,
                  component: 'InputNumber'
                },
                domains: {
                  type: 'array',
                  label: '域名配置列表',
                  description: '支持多域名配置，每个域名可以有不同的配置',
                  component: 'ArrayForm',
                  itemType: 'object',
                  fields: {
                    domain: {
                      type: 'string',
                      label: '域名',
                      required: true,
                      component: 'Input',
                      placeholder: 'xrkk.cc'
                    },
                    staticRoot: {
                      type: 'string',
                      label: '静态文件根目录',
                      component: 'Input',
                      placeholder: './www'
                    },
                    target: {
                      type: 'string',
                      label: '目标服务器',
                      component: 'Input',
                      placeholder: 'http://localhost:3000'
                    },
                    ssl: {
                      type: 'object',
                      label: 'SSL配置',
                      component: 'SubForm',
                      fields: {
                        enabled: {
                          type: 'boolean',
                          label: '启用SSL',
                          default: false,
                          component: 'Switch'
                        },
                        certificate: {
                          type: 'object',
                          label: '证书配置',
                          component: 'SubForm',
                          fields: {
                            key: {
                              type: 'string',
                              label: '私钥文件路径',
                              component: 'Input'
                            },
                            cert: {
                              type: 'string',
                              label: '证书文件路径',
                              component: 'Input'
                            },
                            ca: {
                              type: 'string',
                              label: 'CA证书链',
                              component: 'Input'
                            }
                          }
                        }
                      }
                    },
                    rewritePath: {
                      type: 'object',
                      label: '路径重写规则',
                      component: 'SubForm',
                      fields: {
                        from: {
                          type: 'string',
                          label: '源路径',
                          component: 'Input'
                        },
                        to: {
                          type: 'string',
                          label: '目标路径',
                          component: 'Input'
                        }
                      }
                    },
                    preserveHostHeader: {
                      type: 'boolean',
                      label: '保持原始Host头',
                      default: false,
                      component: 'Switch'
                    },
                    ws: {
                      type: 'boolean',
                      label: 'WebSocket支持',
                      default: true,
                      component: 'Switch'
                    },
                    timeout: {
                      type: 'number',
                      label: '超时时间',
                      description: '代理超时时间（毫秒）',
                      min: 1000,
                      default: 30000,
                      component: 'InputNumber'
                    }
                  }
                }
              }
            },
            https: {
              type: 'object',
              label: 'HTTPS配置',
              component: 'SubForm',
              fields: {
                enabled: {
                  type: 'boolean',
                  label: '启用HTTPS',
                  default: false,
                  component: 'Switch'
                },
                certificate: {
                  type: 'object',
                  label: '默认证书配置',
                  component: 'SubForm',
                  fields: {
                    key: {
                      type: 'string',
                      label: '私钥文件路径',
                      component: 'Input'
                    },
                    cert: {
                      type: 'string',
                      label: '证书文件路径',
                      component: 'Input'
                    },
                    ca: {
                      type: 'string',
                      label: 'CA证书链路径',
                      component: 'Input'
                    }
                  }
                },
                tls: {
                  type: 'object',
                  label: 'TLS配置',
                  component: 'SubForm',
                  fields: {
                    minVersion: {
                      type: 'string',
                      label: '最低TLS版本',
                      enum: ['TLSv1.0', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3'],
                      default: 'TLSv1.2',
                      component: 'Select'
                    },
                    http2: {
                      type: 'boolean',
                      label: '启用HTTP/2',
                      default: true,
                      component: 'Switch'
                    }
                  }
                },
                hsts: {
                  type: 'object',
                  label: 'HSTS配置',
                  component: 'SubForm',
                  fields: {
                    enabled: {
                      type: 'boolean',
                      label: '启用HSTS',
                      default: false,
                      component: 'Switch'
                    },
                    maxAge: {
                      type: 'number',
                      label: '有效期',
                      description: '有效期（秒），31536000 = 1年',
                      min: 0,
                      default: 31536000,
                      component: 'InputNumber'
                    },
                    includeSubDomains: {
                      type: 'boolean',
                      label: '包含子域名',
                      default: true,
                      component: 'Switch'
                    },
                    preload: {
                      type: 'boolean',
                      label: '允许预加载',
                      default: false,
                      component: 'Switch'
                    }
                  }
                }
              }
            },
            static: {
              type: 'object',
              label: '静态文件服务',
              component: 'SubForm',
              fields: {
                index: {
                  type: 'array',
                  label: '默认首页文件',
                  description: '按顺序查找，返回第一个存在的文件',
                  itemType: 'string',
                  default: ['index.html', 'index.htm', 'default.html'],
                  component: 'Tags'
                },
                extensions: {
                  type: 'boolean',
                  label: '自动添加扩展名',
                  description: '例如：/page 会尝试 /page.html',
                  default: false,
                  component: 'Switch'
                },
                cacheTime: {
                  type: 'string',
                  label: '缓存时间',
                  description: '支持格式：1d = 1天, 1h = 1小时, 1w = 1周',
                  default: '1d',
                  component: 'Input'
                }
              }
            },
            security: {
              type: 'object',
              label: '安全配置',
              component: 'SubForm',
              fields: {
                helmet: {
                  type: 'object',
                  label: 'Helmet安全头',
                  component: 'SubForm',
                  fields: {
                    enabled: {
                      type: 'boolean',
                      label: '启用Helmet',
                      default: true,
                      component: 'Switch'
                    }
                  }
                },
                hsts: {
                  type: 'object',
                  label: 'HSTS配置',
                  component: 'SubForm',
                  fields: {
                    enabled: {
                      type: 'boolean',
                      label: '启用HSTS',
                      default: false,
                      component: 'Switch'
                    },
                    maxAge: {
                      type: 'number',
                      label: '有效期',
                      description: '有效期（秒），31536000 = 1年',
                      min: 0,
                      default: 31536000,
                      component: 'InputNumber'
                    },
                    includeSubDomains: {
                      type: 'boolean',
                      label: '包含子域名',
                      default: true,
                      component: 'Switch'
                    },
                    preload: {
                      type: 'boolean',
                      label: '允许预加载',
                      default: false,
                      component: 'Switch'
                    }
                  }
                },
                hiddenFiles: {
                  type: 'array',
                  label: '隐藏文件模式',
                  description: '匹配这些模式的文件将返回404，注意：这些模式不会影响 /api/* 路径',
                  itemType: 'string',
                  default: ['^\\..*', 'node_modules', '\\.git', '\\.env', '^/config/', '^/private/'],
                  component: 'Tags'
                }
              }
            },
            cors: {
              type: 'object',
              label: 'CORS配置',
              component: 'SubForm',
              fields: {
                enabled: {
                  type: 'boolean',
                  label: '启用CORS',
                  default: true,
                  component: 'Switch'
                },
                origins: {
                  type: 'array',
                  label: '允许的来源',
                  itemType: 'string',
                  default: ['*'],
                  component: 'Tags'
                },
                methods: {
                  type: 'array',
                  label: '允许的方法',
                  itemType: 'string',
                  default: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH', 'HEAD'],
                  component: 'MultiSelect'
                },
                headers: {
                  type: 'array',
                  label: '允许的请求头',
                  itemType: 'string',
                  default: ['Content-Type', 'Authorization', 'X-API-Key'],
                  component: 'Tags'
                },
                credentials: {
                  type: 'boolean',
                  label: '允许凭证',
                  default: false,
                  component: 'Switch'
                },
                maxAge: {
                  type: 'number',
                  label: '预检缓存时间',
                  description: '预检请求缓存时间（秒）',
                  min: 0,
                  default: 86400,
                  component: 'InputNumber'
                }
              }
            },
            auth: {
              type: 'object',
              label: '认证配置',
              component: 'SubForm',
              fields: {
                apiKey: {
                  type: 'object',
                  label: 'API密钥配置',
                  component: 'SubForm',
                  fields: {
                    enabled: {
                      type: 'boolean',
                      label: '启用API密钥',
                      default: true,
                      component: 'Switch'
                    },
                    file: {
                      type: 'string',
                      label: '密钥存储文件',
                      default: 'config/server_config/api_key.json',
                      component: 'Input'
                    },
                    length: {
                      type: 'number',
                      label: '密钥长度',
                      min: 16,
                      max: 128,
                      default: 64,
                      component: 'InputNumber'
                    }
                  }
                },
                whitelist: {
                  type: 'array',
                  label: '白名单路径',
                  itemType: 'string',
                  default: ['/', '/favicon.ico', '/health', '/status', '/robots.txt', '/xrk', '/media/*', '/uploads/*'],
                  component: 'Tags'
                }
              }
            },
            rateLimit: {
              type: 'object',
              label: '速率限制',
              component: 'SubForm',
              fields: {
                enabled: {
                  type: 'boolean',
                  label: '启用速率限制',
                  default: true,
                  component: 'Switch'
                },
                global: {
                  type: 'object',
                  label: '全局限制',
                  component: 'SubForm',
                  fields: {
                    windowMs: {
                      type: 'number',
                      label: '时间窗口',
                      description: '时间窗口（毫秒）',
                      min: 1000,
                      default: 900000,
                      component: 'InputNumber'
                    },
                    max: {
                      type: 'number',
                      label: '最大请求数',
                      min: 1,
                      default: 1000,
                      component: 'InputNumber'
                    },
                    message: {
                      type: 'string',
                      label: '提示信息',
                      default: '请求过于频繁，请稍后再试',
                      component: 'Input'
                    }
                  }
                },
                api: {
                  type: 'object',
                  label: 'API限制',
                  component: 'SubForm',
                  fields: {
                    windowMs: {
                      type: 'number',
                      label: '时间窗口',
                      min: 1000,
                      default: 60000,
                      component: 'InputNumber'
                    },
                    max: {
                      type: 'number',
                      label: '最大请求数',
                      min: 1,
                      default: 60,
                      component: 'InputNumber'
                    },
                    message: {
                      type: 'string',
                      label: '提示信息',
                      default: 'API请求过于频繁',
                      component: 'Input'
                    }
                  }
                }
              }
            },
            limits: {
              type: 'object',
              label: '请求限制',
              component: 'SubForm',
              fields: {
                urlencoded: {
                  type: 'string',
                  label: 'URL编码数据',
                  default: '10mb',
                  component: 'Input'
                },
                json: {
                  type: 'string',
                  label: 'JSON数据',
                  default: '10mb',
                  component: 'Input'
                },
                raw: {
                  type: 'string',
                  label: '原始数据',
                  default: '50mb',
                  component: 'Input'
                },
                text: {
                  type: 'string',
                  label: '文本数据',
                  default: '10mb',
                  component: 'Input'
                },
                fileSize: {
                  type: 'string',
                  label: '文件上传',
                  default: '100mb',
                  component: 'Input'
                }
              }
            },
            compression: {
              type: 'object',
              label: '压缩配置',
              component: 'SubForm',
              fields: {
                enabled: {
                  type: 'boolean',
                  label: '启用压缩',
                  default: true,
                  component: 'Switch'
                },
                level: {
                  type: 'number',
                  label: '压缩级别',
                  description: '0: 无压缩，9: 最大压缩，推荐：6',
                  min: 0,
                  max: 9,
                  default: 6,
                  component: 'InputNumber'
                },
                threshold: {
                  type: 'number',
                  label: '最小压缩大小',
                  description: '小于此大小的响应不会被压缩（字节）',
                  min: 0,
                  default: 1024,
                  component: 'InputNumber'
                }
              }
            },
            logging: {
              type: 'object',
              label: '日志配置',
              component: 'SubForm',
              fields: {
                requests: {
                  type: 'boolean',
                  label: '记录请求',
                  default: true,
                  component: 'Switch'
                },
                errors: {
                  type: 'boolean',
                  label: '记录错误',
                  default: true,
                  component: 'Switch'
                },
                debug: {
                  type: 'boolean',
                  label: '调试日志',
                  default: false,
                  component: 'Switch'
                },
                quiet: {
                  type: 'array',
                  label: '静默路径',
                  itemType: 'string',
                  default: ['/health', '/favicon.ico', '/robots.txt'],
                  component: 'Tags'
                }
              }
            },
            misc: {
              type: 'object',
              label: '其他配置',
              component: 'SubForm',
              fields: {
                detectPublicIP: {
                  type: 'boolean',
                  label: '检测公网IP',
                  default: true,
                  component: 'Switch'
                },
                defaultRoute: {
                  type: 'string',
                  label: '404重定向',
                  default: '/',
                  component: 'Input'
                }
              }
            }
          }
        }
      },

      db: {
        name: 'db',
        displayName: '数据库配置',
        description: 'Sequelize数据库连接配置',
        filePath: getConfigPath('db'),
        fileType: 'yaml',
        schema: {
          required: ['dialect'],
          fields: {
            dialect: {
              type: 'string',
              label: '数据库类型',
              enum: ['sqlite', 'mysql', 'mariadb', 'postgres', 'mssql', 'db2'],
              default: 'sqlite',
              component: 'Select'
            },
            storage: {
              type: 'string',
              label: 'SQLite文件地址',
              default: 'data/db/data.db',
              component: 'Input'
            },
            logging: {
              type: 'boolean',
              label: '日志输出',
              default: false,
              component: 'Switch'
            }
          }
        }
      },

      device: {
        name: 'device',
        displayName: '设备管理配置',
        description: '设备管理的核心参数配置',
        filePath: getConfigPath('device'),
        fileType: 'yaml',
        schema: {
          fields: {
            heartbeat_interval: {
              type: 'number',
              label: '心跳发送间隔',
              description: '心跳发送间隔（秒）',
              min: 1,
              default: 30,
              component: 'InputNumber'
            },
            heartbeat_timeout: {
              type: 'number',
              label: '心跳超时时间',
              description: '心跳超时时间（秒）',
              min: 1,
              default: 120,
              component: 'InputNumber'
            },
            max_devices: {
              type: 'number',
              label: '最大设备数量',
              min: 1,
              default: 100,
              component: 'InputNumber'
            },
            max_logs_per_device: {
              type: 'number',
              label: '设备最大日志条数',
              min: 1,
              default: 100,
              component: 'InputNumber'
            },
            max_data_per_device: {
              type: 'number',
              label: '设备最大数据条数',
              min: 1,
              default: 50,
              component: 'InputNumber'
            },
            command_timeout: {
              type: 'number',
              label: '命令执行超时',
              description: '命令执行超时时间（毫秒）',
              min: 100,
              default: 5000,
              component: 'InputNumber'
            },
            batch_size: {
              type: 'number',
              label: '批量发送数量',
              min: 1,
              default: 100,
              component: 'InputNumber'
            }
          }
        }
      },

      group: {
        name: 'group',
        displayName: '群组配置',
        description: '群聊相关配置',
        filePath: getConfigPath('group'),
        fileType: 'yaml',
        // 特殊处理：支持数字键（群号）和groups数组的转换
        transformRead: (data) => {
          if (!data || typeof data !== 'object') return data;
          const result = { ...data };
          // 将数字键转换为groups数组
          const groups = [];
          for (const [key, value] of Object.entries(result)) {
            if (key !== 'default' && /^\d+$/.test(key)) {
              groups.push({ groupId: key, ...value });
              delete result[key];
            }
          }
          if (groups.length > 0) {
            result.groups = groups;
          }
          return result;
        },
        transformWrite: (data) => {
          if (!data || typeof data !== 'object') return data;
          const result = { ...data };
          // 将groups数组转换回数字键
          if (Array.isArray(result.groups)) {
            for (const group of result.groups) {
              if (group.groupId) {
                const { groupId, ...config } = group;
                result[groupId] = config;
              }
            }
            delete result.groups;
          }
          return result;
        },
        schema: {
          fields: {
            default: {
              type: 'object',
              label: '默认配置',
              component: 'SubForm',
              fields: {
                groupGlobalCD: {
                  type: 'number',
                  label: '整体冷却时间',
                  description: '群聊中所有指令操作冷却时间（毫秒）',
                  min: 0,
                  default: 500,
                  component: 'InputNumber'
                },
                singleCD: {
                  type: 'number',
                  label: '个人冷却时间',
                  description: '群聊中个人操作冷却时间（毫秒）',
                  min: 0,
                  default: 500,
                  component: 'InputNumber'
                },
                onlyReplyAt: {
                  type: 'number',
                  label: '只关注At',
                  description: '0-否 1-是 2-触发用户非主人只回复@',
                  enum: [0, 1, 2],
                  default: 0,
                  component: 'Select'
                },
                botAlias: {
                  type: 'array',
                  label: '机器人别名',
                  itemType: 'string',
                  default: ['葵崽', '葵葵'],
                  component: 'Tags'
                },
                addPrivate: {
                  type: 'number',
                  label: '私聊添加',
                  enum: [0, 1],
                  default: 1,
                  component: 'Select'
                },
                enable: {
                  type: 'array',
                  label: '功能白名单',
                  itemType: 'string',
                  default: [],
                  component: 'Tags'
                },
                disable: {
                  type: 'array',
                  label: '功能黑名单',
                  itemType: 'string',
                  default: [],
                  component: 'Tags'
                }
              }
            },
            groups: {
              type: 'array',
              label: '群组单独配置',
              description: '为特定群组设置单独的配置，会覆盖默认配置',
              component: 'ArrayForm',
              itemType: 'object',
              fields: {
                groupId: {
                  type: 'string',
                  label: '群号',
                  required: true,
                  component: 'Input',
                  placeholder: '123456'
                },
                groupGlobalCD: {
                  type: 'number',
                  label: '整体冷却时间',
                  description: '群聊中所有指令操作冷却时间（毫秒），0则无限制',
                  min: 0,
                  default: 500,
                  component: 'InputNumber'
                },
                singleCD: {
                  type: 'number',
                  label: '个人冷却时间',
                  description: '群聊中个人操作冷却时间（毫秒）',
                  min: 0,
                  default: 500,
                  component: 'InputNumber'
                },
                onlyReplyAt: {
                  type: 'number',
                  label: '只关注At',
                  description: '0-否 1-是 2-触发用户非主人只回复@',
                  enum: [0, 1, 2],
                  default: 0,
                  component: 'Select'
                },
                botAlias: {
                  type: 'array',
                  label: '机器人别名',
                  itemType: 'string',
                  default: [],
                  component: 'Tags'
                },
                addPrivate: {
                  type: 'number',
                  label: '私聊添加',
                  enum: [0, 1],
                  default: 1,
                  component: 'Select'
                },
                enable: {
                  type: 'array',
                  label: '功能白名单',
                  itemType: 'string',
                  default: [],
                  component: 'Tags'
                },
                disable: {
                  type: 'array',
                  label: '功能黑名单',
                  itemType: 'string',
                  default: [],
                  component: 'Tags'
                }
              }
            }
          }
        }
      },

      notice: {
        name: 'notice',
        displayName: '通知配置',
        description: '各种通知服务配置',
        filePath: getConfigPath('notice'),
        fileType: 'yaml',
        schema: {
          fields: {
            iyuu: {
              type: 'string',
              label: 'IYUU Token',
              description: 'IYUU通知服务Token',
              default: '',
              component: 'Input'
            },
            sct: {
              type: 'string',
              label: 'Server酱',
              description: 'Server酱SendKey',
              default: '',
              component: 'Input'
            },
            feishu_webhook: {
              type: 'string',
              label: '飞书机器人Webhook',
              default: '',
              component: 'Input'
            }
          }
        }
      },

      other: {
        name: 'other',
        displayName: '其他配置',
        description: '其他杂项配置',
        filePath: getConfigPath('other'),
        fileType: 'yaml',
        schema: {
          fields: {
            masterQQ: {
              type: 'array',
              label: '主人QQ',
              itemType: 'string',
              default: [],
              component: 'Tags'
            },
            disableGuildMsg: {
              type: 'boolean',
              label: '禁用频道消息',
              default: true,
              component: 'Switch'
            },
            blackQQ: {
              type: 'array',
              label: '黑名单QQ',
              itemType: 'string',
              default: [],
              component: 'Tags'
            },
            whiteQQ: {
              type: 'array',
              label: '白名单QQ',
              itemType: 'string',
              default: [],
              component: 'Tags'
            },
            blackGroup: {
              type: 'array',
              label: '黑名单群',
              itemType: 'string',
              default: [],
              component: 'Tags'
            },
            whiteGroup: {
              type: 'array',
              label: '白名单群',
              itemType: 'string',
              default: [],
              component: 'Tags'
            },
            autoFriend: {
              type: 'number',
              label: '添加好友',
              enum: [0, 1],
              default: 1,
              component: 'Select'
            },
            autoQuit: {
              type: 'number',
              label: '退群人数',
              min: 0,
              default: 50,
              component: 'InputNumber'
            },
            disablePrivate: {
              type: 'boolean',
              label: '禁用私聊',
              default: false,
              component: 'Switch'
            },
            disableMsg: {
              type: 'string',
              label: '禁私聊提示',
              default: '私聊功能已禁用',
              component: 'Input'
            },
            disableAdopt: {
              type: 'array',
              label: '私聊通行字符串',
              itemType: 'string',
              default: ['stoken'],
              component: 'Tags'
            }
          }
        }
      },

      redis: {
        name: 'redis',
        displayName: 'Redis配置',
        description: 'Redis服务器连接配置',
        filePath: getConfigPath('redis'),
        fileType: 'yaml',
        schema: {
          required: ['host', 'port', 'db'],
          fields: {
            host: {
              type: 'string',
              label: 'Redis地址',
              default: '127.0.0.1',
              component: 'Input'
            },
            port: {
              type: 'number',
              label: 'Redis端口',
              min: 1,
              max: 65535,
              default: 6379,
              component: 'InputNumber'
            },
            username: {
              type: 'string',
              label: 'Redis用户名',
              default: '',
              component: 'Input'
            },
            password: {
              type: 'string',
              label: 'Redis密码',
              default: '',
              component: 'InputPassword'
            },
            db: {
              type: 'number',
              label: 'Redis数据库',
              min: 0,
              default: 0,
              component: 'InputNumber'
            }
          }
        }
      },

      renderer: {
        name: 'renderer',
        displayName: '渲染器配置',
        description: '渲染后端配置',
        filePath: getConfigPath('renderer'),
        fileType: 'yaml',
        schema: {
          fields: {
            name: {
              type: 'string',
              label: '渲染后端',
              enum: ['puppeteer'],
              default: 'puppeteer',
              component: 'Select'
            }
          }
        }
      },

      aistream: {
        name: 'aistream',
        displayName: '工作流系统配置',
        description: 'AI工作流系统配置',
        filePath: getConfigPath('aistream'),
        fileType: 'yaml',
        schema: {
          fields: {
            enabled: {
              type: 'boolean',
              label: '启用工作流',
              default: true,
              component: 'Switch'
            },
            streamDir: {
              type: 'string',
              label: '工作流目录',
              default: 'plugins/stream',
              component: 'Input'
            },
            global: {
              type: 'object',
              label: '全局设置',
              component: 'SubForm',
              fields: {
                maxTimeout: {
                  type: 'number',
                  label: '最大执行超时',
                  description: '最大执行超时时间（毫秒）',
                  min: 1000,
                  default: 30000,
                  component: 'InputNumber'
                },
                debug: {
                  type: 'boolean',
                  label: '调试日志',
                  default: false,
                  component: 'Switch'
                },
                maxConcurrent: {
                  type: 'number',
                  label: '并发执行限制',
                  min: 1,
                  default: 5,
                  component: 'InputNumber'
                }
              }
            },
            cache: {
              type: 'object',
              label: '缓存设置',
              component: 'SubForm',
              fields: {
                enabled: {
                  type: 'boolean',
                  label: '启用缓存',
                  default: true,
                  component: 'Switch'
                },
                ttl: {
                  type: 'number',
                  label: '缓存过期时间',
                  description: '缓存过期时间（秒）',
                  min: 1,
                  default: 300,
                  component: 'InputNumber'
                },
                maxSize: {
                  type: 'number',
                  label: '最大缓存条数',
                  min: 1,
                  default: 100,
                  component: 'InputNumber'
                }
              }
            }
          }
        }
      },

      kuizai: {
        name: 'kuizai',
        displayName: '葵崽AI配置',
        description: '葵崽AI、TTS、ASR相关配置',
        filePath: getConfigPath('kuizai'),
        fileType: 'yaml',
        schema: {
          fields: {
            ai: {
              type: 'object',
              label: 'AI基础配置',
              component: 'SubForm',
              fields: {
                enabled: {
                  type: 'boolean',
                  label: '启用AI',
                  default: true,
                  component: 'Switch'
                },
                baseUrl: {
                  type: 'string',
                  label: 'API地址',
                  default: 'https://api.gptgod.online/v1',
                  component: 'Input'
                },
                apiKey: {
                  type: 'string',
                  label: 'API密钥',
                  description: 'AI API密钥，留空则不使用',
                  default: '',
                  component: 'Input'
                },
                chatModel: {
                  type: 'string',
                  label: '聊天模型',
                  default: 'deepseek-r1-0528',
                  component: 'Input'
                },
                temperature: {
                  type: 'number',
                  label: '温度参数',
                  description: '控制输出的随机性，范围0-2',
                  min: 0,
                  max: 2,
                  step: 0.1,
                  default: 0.8,
                  component: 'InputNumber'
                },
                max_tokens: {
                  type: 'number',
                  label: '最大Token数',
                  min: 1,
                  default: 2000,
                  component: 'InputNumber'
                },
                top_p: {
                  type: 'number',
                  label: 'Top P',
                  description: '核采样参数',
                  min: 0,
                  max: 1,
                  step: 0.1,
                  default: 0.9,
                  component: 'InputNumber'
                },
                presence_penalty: {
                  type: 'number',
                  label: '存在惩罚',
                  min: -2,
                  max: 2,
                  step: 0.1,
                  default: 0.6,
                  component: 'InputNumber'
                },
                frequency_penalty: {
                  type: 'number',
                  label: '频率惩罚',
                  min: -2,
                  max: 2,
                  step: 0.1,
                  default: 0.6,
                  component: 'InputNumber'
                },
                timeout: {
                  type: 'number',
                  label: '请求超时',
                  description: '请求超时时间（毫秒）',
                  min: 1000,
                  default: 30000,
                  component: 'InputNumber'
                },
                displayDelay: {
                  type: 'number',
                  label: '显示延迟',
                  description: '显示延迟时间（毫秒）',
                  min: 0,
                  default: 1500,
                  component: 'InputNumber'
                },
                persona: {
                  type: 'string',
                  label: 'AI人设',
                  default: '我是一个智能语音助手，可以听懂你说的话并做出回应。我会用简短的话语和表情与你交流。',
                  component: 'Textarea'
                }
              }
            },
            tts: {
              type: 'object',
              label: '火山TTS配置',
              component: 'SubForm',
              fields: {
                enabled: {
                  type: 'boolean',
                  label: '启用TTS',
                  default: true,
                  component: 'Switch'
                },
                provider: {
                  type: 'string',
                  label: '服务提供商',
                  default: 'volcengine',
                  component: 'Input'
                },
                wsUrl: {
                  type: 'string',
                  label: 'WebSocket地址',
                  default: 'wss://openspeech.bytedance.com/api/v3/tts/bidirection',
                  component: 'Input'
                },
                appKey: {
                  type: 'string',
                  label: 'AppKey',
                  default: '5231143210',
                  component: 'Input'
                },
                accessKey: {
                  type: 'string',
                  label: 'AccessKey',
                  default: 'hSkG2n1yavXry2N3DtQeoTohvWp3qTrR',
                  component: 'Input'
                },
                resourceId: {
                  type: 'string',
                  label: '资源ID',
                  default: 'seed-tts-2.0',
                  component: 'Input'
                },
                voiceType: {
                  type: 'string',
                  label: '语音类型',
                  default: 'zh_female_vv_uranus_bigtts',
                  component: 'Input'
                },
                encoding: {
                  type: 'string',
                  label: '编码格式',
                  default: 'pcm',
                  component: 'Input'
                },
                sampleRate: {
                  type: 'number',
                  label: '采样率',
                  default: 16000,
                  component: 'InputNumber'
                },
                speechRate: {
                  type: 'number',
                  label: '语速',
                  default: 5,
                  component: 'InputNumber'
                },
                loudnessRate: {
                  type: 'number',
                  label: '音量',
                  default: 0,
                  component: 'InputNumber'
                },
                emotion: {
                  type: 'string',
                  label: '情感',
                  default: 'happy',
                  component: 'Input'
                },
                chunkMs: {
                  type: 'number',
                  label: '分块大小（毫秒）',
                  default: 128,
                  component: 'InputNumber'
                },
                chunkDelayMs: {
                  type: 'number',
                  label: '分块延迟（毫秒）',
                  default: 5,
                  component: 'InputNumber'
                }
              }
            },
            asr: {
              type: 'object',
              label: '火山ASR配置',
              component: 'SubForm',
              fields: {
                enabled: {
                  type: 'boolean',
                  label: '启用ASR',
                  default: true,
                  component: 'Switch'
                },
                provider: {
                  type: 'string',
                  label: '服务提供商',
                  default: 'volcengine',
                  component: 'Input'
                },
                wsUrl: {
                  type: 'string',
                  label: 'WebSocket地址',
                  default: 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async',
                  component: 'Input'
                },
                appKey: {
                  type: 'string',
                  label: 'AppKey',
                  default: '5231143210',
                  component: 'Input'
                },
                accessKey: {
                  type: 'string',
                  label: 'AccessKey',
                  default: 'hSkG2n1yavXry2N3DtQeoTohvWp3qTrR',
                  component: 'Input'
                },
                resourceId: {
                  type: 'string',
                  label: '资源ID',
                  default: 'volc.bigasr.sauc.duration',
                  component: 'Input'
                },
                enableItn: {
                  type: 'boolean',
                  label: '启用逆文本规范化',
                  default: true,
                  component: 'Switch'
                },
                enablePunc: {
                  type: 'boolean',
                  label: '启用标点符号',
                  default: true,
                  component: 'Switch'
                },
                enableDdc: {
                  type: 'boolean',
                  label: '启用DDC',
                  default: false,
                  component: 'Switch'
                },
                showUtterances: {
                  type: 'boolean',
                  label: '显示话语',
                  default: true,
                  component: 'Switch'
                },
                resultType: {
                  type: 'string',
                  label: '结果类型',
                  default: 'full',
                  component: 'Input'
                },
                enableAccelerateText: {
                  type: 'boolean',
                  label: '启用加速文本',
                  default: true,
                  component: 'Switch'
                },
                accelerateScore: {
                  type: 'number',
                  label: '加速分数',
                  default: 15,
                  component: 'InputNumber'
                },
                persistentWs: {
                  type: 'boolean',
                  label: '持久化WebSocket',
                  default: true,
                  component: 'Switch'
                },
                idleCloseMs: {
                  type: 'number',
                  label: '空闲关闭时间（毫秒）',
                  default: 6000,
                  component: 'InputNumber'
                },
                endWindowSize: {
                  type: 'number',
                  label: '结束窗口大小',
                  default: 350,
                  component: 'InputNumber'
                },
                forceToSpeechTime: {
                  type: 'number',
                  label: '强制语音时间（毫秒）',
                  default: 500,
                  component: 'InputNumber'
                },
                maxAudioBufferSize: {
                  type: 'number',
                  label: '最大音频缓冲区大小',
                  default: 30,
                  component: 'InputNumber'
                },
                asrFinalTextWaitMs: {
                  type: 'number',
                  label: 'ASR最终文本等待时间（毫秒）',
                  default: 1200,
                  component: 'InputNumber'
                }
              }
            },
            responsePolish: {
              type: 'object',
              label: 'AI响应润色配置',
              component: 'SubForm',
              fields: {
                enabled: {
                  type: 'boolean',
                  label: '启用响应润色',
                  default: true,
                  component: 'Switch'
                },
                maxTokens: {
                  type: 'number',
                  label: '最大Token数',
                  min: 1,
                  default: 400,
                  component: 'InputNumber'
                },
                temperature: {
                  type: 'number',
                  label: '温度参数',
                  description: '控制润色的随机性，范围0-2',
                  min: 0,
                  max: 2,
                  step: 0.1,
                  default: 0.3,
                  component: 'InputNumber'
                },
                instructions: {
                  type: 'string',
                  label: '润色指令',
                  default: '你是QQ聊天润色器，只能做轻微整理：1. 删除舞台提示、括号或方括号里未执行的工具描述（例如[回复:xxx]、(正在... )等）2. 保留原意，语气自然，像正常聊天，尽量简短，用常用标点分句3. 不要添加新信息或Markdown，只输出纯文本',
                  component: 'Textarea'
                }
              }
            },
            reasoning: {
              type: 'object',
              label: 'AI推理调优配置',
              component: 'SubForm',
              fields: {
                enabled: {
                  type: 'boolean',
                  label: '启用推理调优',
                  default: false,
                  component: 'Switch'
                },
                maxIterations: {
                  type: 'number',
                  label: '最大迭代次数',
                  min: 1,
                  max: 10,
                  default: 3,
                  component: 'InputNumber'
                },
                temperature: {
                  type: 'number',
                  label: '温度参数',
                  description: '控制推理的随机性，范围0-2',
                  min: 0,
                  max: 2,
                  step: 0.1,
                  default: 0.8,
                  component: 'InputNumber'
                }
              }
            },
            workflows: {
              type: 'object',
              label: '工作流系统配置',
              component: 'SubForm',
              fields: {
                enabled: {
                  type: 'boolean',
                  label: '启用工作流',
                  default: true,
                  component: 'Switch'
                },
                allowMultiple: {
                  type: 'boolean',
                  label: '允许多个工作流',
                  default: true,
                  component: 'Switch'
                },
                defaultWorkflow: {
                  type: 'string',
                  label: '默认工作流',
                  default: 'device',
                  component: 'Input'
                }
              }
            }
          }
        }
      },

      renderer_puppeteer: {
        name: 'renderer_puppeteer',
        displayName: 'Puppeteer截图配置',
        description: 'Puppeteer渲染器配置，用于网页截图',
        filePath: (cfg) => {
          const port = cfg?._port || cfg?.server?.server?.port || 8086;
          return port ? `data/server_bots/${port}/renderers/puppeteer/config.yaml` : `renderers/puppeteer/config_default.yaml`;
        },
        fileType: 'yaml',
        schema: {
          fields: {
            headless: {
              type: 'string',
              label: '无头模式',
              description: '"new" 为新 headless 模式',
              default: 'new',
              component: 'Input'
            },
            chromiumPath: {
              type: 'string',
              label: 'Chromium路径',
              description: 'Chromium可执行文件路径（可选）',
              default: '',
              component: 'Input'
            },
            wsEndpoint: {
              type: 'string',
              label: 'WebSocket端点',
              description: '连接到远程浏览器（可选）',
              default: '',
              component: 'Input'
            },
            puppeteerTimeout: {
              type: 'number',
              label: '截图超时时间',
              description: '截图超时时间（毫秒）',
              min: 1000,
              default: 120000,
              component: 'InputNumber'
            },
            restartNum: {
              type: 'number',
              label: '重启阈值',
              description: '截图重启阈值',
              min: 1,
              default: 150,
              component: 'InputNumber'
            },
            viewport: {
              type: 'object',
              label: '视口设置',
              component: 'SubForm',
              fields: {
                width: {
                  type: 'number',
                  label: '宽度',
                  min: 1,
                  default: 1280,
                  component: 'InputNumber'
                },
                height: {
                  type: 'number',
                  label: '高度',
                  min: 1,
                  default: 720,
                  component: 'InputNumber'
                },
                deviceScaleFactor: {
                  type: 'number',
                  label: '设备缩放因子',
                  min: 0.1,
                  max: 5,
                  step: 0.1,
                  default: 1,
                  component: 'InputNumber'
                }
              }
            }
          }
        }
      },

      renderer_playwright: {
        name: 'renderer_playwright',
        displayName: 'Playwright截图配置',
        description: 'Playwright渲染器配置，用于网页截图',
        filePath: (cfg) => {
          const port = cfg?._port || cfg?.server?.server?.port || 8086;
          return port ? `data/server_bots/${port}/renderers/playwright/config.yaml` : `renderers/playwright/config_default.yaml`;
        },
        fileType: 'yaml',
        schema: {
          fields: {
            browserType: {
              type: 'string',
              label: '浏览器类型',
              enum: ['chromium', 'firefox', 'webkit'],
              default: 'chromium',
              component: 'Select'
            },
            headless: {
              type: 'boolean',
              label: '无头模式',
              default: true,
              component: 'Switch'
            },
            chromiumPath: {
              type: 'string',
              label: 'Chromium路径',
              description: 'Chromium可执行文件路径（可选）',
              default: '',
              component: 'Input'
            },
            channel: {
              type: 'string',
              label: '浏览器通道',
              description: '浏览器通道（可选）',
              default: '',
              component: 'Input'
            },
            wsEndpoint: {
              type: 'string',
              label: 'WebSocket端点',
              description: '连接到远程浏览器（可选）',
              default: '',
              component: 'Input'
            },
            playwrightTimeout: {
              type: 'number',
              label: '截图超时时间',
              description: '截图超时时间（毫秒）',
              min: 1000,
              default: 120000,
              component: 'InputNumber'
            },
            healthCheckInterval: {
              type: 'number',
              label: '健康检查间隔',
              description: '健康检查间隔（毫秒）',
              min: 1000,
              default: 60000,
              component: 'InputNumber'
            },
            maxRetries: {
              type: 'number',
              label: '连接重试次数',
              min: 0,
              default: 3,
              component: 'InputNumber'
            },
            retryDelay: {
              type: 'number',
              label: '重试延迟',
              description: '重试延迟（毫秒）',
              min: 0,
              default: 2000,
              component: 'InputNumber'
            },
            restartNum: {
              type: 'number',
              label: '重启阈值',
              description: '截图重启阈值',
              min: 1,
              default: 150,
              component: 'InputNumber'
            },
            viewport: {
              type: 'object',
              label: '视口设置',
              component: 'SubForm',
              fields: {
                width: {
                  type: 'number',
                  label: '宽度',
                  min: 1,
                  default: 1280,
                  component: 'InputNumber'
                },
                height: {
                  type: 'number',
                  label: '高度',
                  min: 1,
                  default: 720,
                  component: 'InputNumber'
                },
                deviceScaleFactor: {
                  type: 'number',
                  label: '设备缩放因子',
                  min: 0.1,
                  max: 5,
                  step: 0.1,
                  default: 1,
                  component: 'InputNumber'
                }
              }
            },
            contextOptions: {
              type: 'object',
              label: '上下文选项',
              component: 'SubForm',
              fields: {
                bypassCSP: {
                  type: 'boolean',
                  label: '绕过CSP',
                  default: true,
                  component: 'Switch'
                },
                reducedMotion: {
                  type: 'string',
                  label: '减少动画',
                  default: 'reduce',
                  component: 'Input'
                }
              }
            }
          }
        }
      }
    };
  }

  /**
   * 获取指定配置文件的实例
   * @param {string} name - 配置名称
   * @returns {ConfigBase}
   */
  getConfigInstance(name) {
    const configMeta = this.configFiles[name];
    if (!configMeta) {
      throw new Error(`未知的配置: ${name}`);
    }

    // 为 group 配置创建特殊实例，支持数字键转换
    if (name === 'group') {
      const GroupConfig = class extends ConfigBase {
        constructor(configMeta) {
          super(configMeta);
          // 设置转换函数
          if (configMeta.transformRead) {
            this.transformRead = configMeta.transformRead;
          }
          if (configMeta.transformWrite) {
            this.transformWrite = configMeta.transformWrite;
          }
        }
      };
      return new GroupConfig(configMeta);
    }

    // 为 renderer 配置创建特殊实例，支持读取默认配置
    if (name === 'renderer_puppeteer' || name === 'renderer_playwright') {
      const RendererConfig = class extends ConfigBase {
        async read(useCache = true) {
          const cfg = global.cfg || { _port: parseInt(process.env.SERVER_PORT || process.env.PORT || 8086) };
          const port = cfg?._port || cfg?.server?.server?.port || 8086;
          const type = name === 'renderer_puppeteer' ? 'puppeteer' : 'playwright';
          
          // 读取默认配置
          const defaultFile = path.join(process.cwd(), 'renderers', type, 'config_default.yaml');
          let defaultConfig = {};
          if (fsSync.existsSync(defaultFile)) {
            try {
              const content = await fs.readFile(defaultFile, 'utf8');
              defaultConfig = yaml.parse(content);
            } catch (error) {
              BotUtil.makeLog('error', `读取默认配置失败 [${name}]: ${error.message}`, 'RendererConfig');
            }
          }
          
          // 读取服务器配置
          const serverFile = path.join(process.cwd(), `data/server_bots/${port}/renderers/${type}/config.yaml`);
          let serverConfig = {};
          if (fsSync.existsSync(serverFile)) {
            try {
              const content = await fs.readFile(serverFile, 'utf8');
              serverConfig = yaml.parse(content);
            } catch (error) {
              BotUtil.makeLog('error', `读取服务器配置失败 [${name}]: ${error.message}`, 'RendererConfig');
            }
          } else if (port) {
            // 如果服务器配置文件不存在，创建它（从默认配置复制）
            const serverDir = path.dirname(serverFile);
            if (!fsSync.existsSync(serverDir)) {
              await fs.mkdir(serverDir, { recursive: true });
            }
            try {
              await fs.writeFile(serverFile, yaml.stringify(defaultConfig), 'utf8');
            } catch (error) {
              BotUtil.makeLog('error', `创建服务器配置失败 [${name}]: ${error.message}`, 'RendererConfig');
            }
          }
          
          // 合并配置（服务器配置覆盖默认配置）
          return { ...defaultConfig, ...serverConfig };
        }
        
        async write(data, options = {}) {
          const cfg = global.cfg || { _port: parseInt(process.env.SERVER_PORT || process.env.PORT || 8086) };
          const port = cfg?._port || cfg?.server?.server?.port || 8086;
          const type = name === 'renderer_puppeteer' ? 'puppeteer' : 'playwright';
          
          if (!port) {
            throw new Error('无法确定服务器端口，无法保存配置');
          }
          
          const serverFile = path.join(process.cwd(), `data/server_bots/${port}/renderers/${type}/config.yaml`);
          const serverDir = path.dirname(serverFile);
          
          if (!fsSync.existsSync(serverDir)) {
            await fs.mkdir(serverDir, { recursive: true });
          }
          
          const { backup = true } = options;
          if (backup && fsSync.existsSync(serverFile)) {
            await this.backup();
          }
          
          const content = yaml.stringify(data, {
            indent: 2,
            lineWidth: 0,
            minContentWidth: 0
          });
          
          await fs.writeFile(serverFile, content, 'utf8');
          BotUtil.makeLog('info', `配置已保存 [${name}]`, 'RendererConfig');
          return true;
        }
      };
      
      return new RendererConfig(configMeta);
    }

    return new ConfigBase(configMeta);
  }

  /**
   * 读取指定配置文件
   * @param {string} [name] - 子配置名称（可选，如果不提供则返回配置列表）
   * @returns {Promise<Object>}
   */
  async read(name) {
    // 如果没有提供子配置名称，返回配置列表信息
    if (!name) {
      return {
        name: this.name,
        displayName: this.displayName,
        description: this.description,
        configs: this.getConfigList()
      };
    }
    
    // 读取指定的子配置
    const instance = this.getConfigInstance(name);
    return await instance.read();
  }

  /**
   * 写入指定配置文件
   * @param {string} name - 子配置名称
   * @param {Object} data - 配置数据
   * @param {Object} options - 写入选项
   * @returns {Promise<boolean>}
   */
  async write(name, data, options = {}) {
    if (!name) {
      throw new Error('SystemConfig 写入需要指定子配置名称');
    }
    const instance = this.getConfigInstance(name);
    return await instance.write(data, options);
  }

  /**
   * 获取指定配置的值
   * @param {string} name - 配置名称
   * @param {string} keyPath - 键路径
   * @returns {Promise<any>}
   */
  async get(name, keyPath) {
    const instance = this.getConfigInstance(name);
    return await instance.get(keyPath);
  }

  /**
   * 设置指定配置的值
   * @param {string} name - 配置名称
   * @param {string} keyPath - 键路径
   * @param {any} value - 新值
   * @param {Object} options - 写入选项
   * @returns {Promise<boolean>}
   */
  async set(name, keyPath, value, options = {}) {
    const instance = this.getConfigInstance(name);
    return await instance.set(keyPath, value, options);
  }

  /**
   * 获取所有配置文件的结构
   * @returns {Object}
   */
  getStructure() {
    const structure = {
      name: this.name,
      displayName: this.displayName,
      description: this.description,
      configs: {}
    };

    for (const [name, meta] of Object.entries(this.configFiles)) {
      // 确保 schema 完整传递，包含所有字段定义和元数据
      structure.configs[name] = {
        ...meta,
        schema: meta.schema || { fields: meta.fields || {} },
        fields: meta.schema?.fields || meta.fields || {}
      };
    }

    return structure;
  }

  /**
   * 获取配置列表（用于API）
   * @returns {Array}
   */
  getConfigList() {
    return Object.entries(this.configFiles).map(([name, meta]) => ({
      name,
      displayName: meta.displayName,
      description: meta.description,
      filePath: meta.filePath,
      fileType: meta.fileType
    }));
  }
}