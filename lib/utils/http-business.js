/**
 * HTTP业务层工具模块
 * 提供重定向、CDN、反向代理增强等功能的统一实现
 * 
 * @module http-business
 * @description 使用Node.js 24.12新特性优化，提供完整的HTTP业务层能力
 */

import crypto from 'node:crypto';
import BotUtil from '../common/util.js';

const URLPatternClass = globalThis.URLPattern || null;

/**
 * 重定向管理器
 * 支持多种重定向类型：301(永久), 302(临时), 307(临时保持方法), 308(永久保持方法)
 */
export class RedirectManager {
  constructor(config = {}) {
    this.rules = [];
    this.config = config;
    this._compileRules();
  }

  /**
   * 编译重定向规则（使用Node.js 24.12 URLPattern API）
   */
  _compileRules() {
    const redirectConfig = this.config.redirects || [];
    
    for (const rule of redirectConfig) {
      try {
        let pattern;
        if (URLPatternClass) {
          pattern = new URLPatternClass({ 
            pathname: rule.from,
            ...(rule.hostname && { hostname: rule.hostname })
          });
        } else {
          pattern = {
            pathname: rule.from,
            test: (url) => {
              const pathname = url.pathname || '';
              if (rule.from.endsWith('*')) {
                const prefix = rule.from.slice(0, -1);
                return pathname.startsWith(prefix);
              }
              const regex = new RegExp('^' + rule.from.replace(/\*/g, '.*') + '$');
              return pathname === rule.from || regex.test(pathname);
            }
          };
        }
        
        this.rules.push({
          pattern,
          to: rule.to,
          status: rule.status || 301,
          preserveQuery: rule.preserveQuery !== false,
          preservePath: rule.preservePath !== false,
          condition: rule.condition ? new Function('req', 'return ' + rule.condition) : null
        });
      } catch (err) {
        BotUtil.makeLog('warn', `[重定向] 规则编译失败: ${rule.from} -> ${rule.to}`, 'RedirectManager', err);
      }
    }
    
    this.rules.sort((a, b) => {
      const aSpecificity = this._getPatternSpecificity(a.pattern);
      const bSpecificity = this._getPatternSpecificity(b.pattern);
      return bSpecificity - aSpecificity;
    });
  }

  /**
   * 获取模式的特异性（用于优先级排序）
   */
  _getPatternSpecificity(pattern) {
    // 简单实现：路径越具体（越少通配符），优先级越高
    const pathname = pattern.pathname || '';
    const wildcards = (pathname.match(/\*/g) || []).length;
    return 100 - wildcards * 10;
  }

  /**
   * 检查并执行重定向
   * @param {Object} req - Express请求对象
   * @param {Object} res - Express响应对象
   * @returns {boolean} 是否执行了重定向
   */
  check(req, res) {
    if (res.headersSent) return false;

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    
    for (const rule of this.rules) {
      try {
        if (rule.condition && !rule.condition(req)) {
          continue;
        }

        let match;
        if (typeof rule.pattern.test === 'function') {
          match = rule.pattern.test({
            pathname: url.pathname,
            hostname: url.hostname
          });
        } else {
          match = url.pathname === rule.pattern.pathname || 
                  (rule.pattern.pathname.endsWith('*') && 
                   url.pathname.startsWith(rule.pattern.pathname.slice(0, -1)));
        }

        if (!match) continue;

        let targetUrl = rule.to;
        
        if (targetUrl.includes('$')) {
          targetUrl = url.pathname.replace(rule.pattern.pathname, targetUrl);
        }

        if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
          const protocol = req.protocol || 'http';
          const host = req.headers.host || 'localhost';
          targetUrl = `${protocol}://${host}${targetUrl.startsWith('/') ? '' : '/'}${targetUrl}`;
        }

        if (rule.preserveQuery && url.search) {
          const targetUrlObj = new URL(targetUrl);
          url.searchParams.forEach((value, key) => {
            targetUrlObj.searchParams.append(key, value);
          });
          targetUrl = targetUrlObj.toString();
        }

        res.redirect(rule.status, targetUrl);
        return true;
      } catch (err) {
        BotUtil.makeLog('warn', `[重定向] 执行失败: ${rule.from} -> ${rule.to}`, 'RedirectManager', err);
      }
    }

    return false;
  }
}

/**
 * HTTP业务层工具类
 * 统一管理重定向、CDN、反向代理等功能
 */
export class HTTPBusinessLayer {
  constructor(config = {}) {
    this.config = config;
    this.redirectManager = new RedirectManager(config);
  }

  /**
   * 处理重定向
   */
  handleRedirect(req, res) {
    return this.redirectManager.check(req, res);
  }
}

export default HTTPBusinessLayer;
