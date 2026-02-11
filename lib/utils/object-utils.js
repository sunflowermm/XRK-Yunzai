/**
 * 对象操作工具类
 * 提供对象类型判断、合并、深度克隆等常用操作
 */
export class ObjectUtils {
  /**
   * 判断是否为有效对象（非null、非数组的对象）
   * @param {any} value - 待判断的值
   * @returns {boolean}
   */
  static isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  /**
   * 判断是否为数组
   * @param {any} value - 待判断的值
   * @returns {boolean}
   */
  static isArray(value) {
    return Array.isArray(value);
  }

  /**
   * 判断是否为函数
   * @param {any} value - 待判断的值
   * @returns {boolean}
   */
  static isFunction(value) {
    return typeof value === 'function';
  }

  /**
   * 判断是否为字符串
   * @param {any} value - 待判断的值
   * @returns {boolean}
   */
  static isString(value) {
    return typeof value === 'string';
  }

  /**
   * 判断是否为数字
   * @param {any} value - 待判断的值
   * @returns {boolean}
   */
  static isNumber(value) {
    return typeof value === 'number' && !Number.isNaN(value);
  }

  /**
   * 判断是否为布尔值
   * @param {any} value - 待判断的值
   * @returns {boolean}
   */
  static isBoolean(value) {
    return typeof value === 'boolean';
  }

  /**
   * 深度合并对象（浅层合并，不递归）
   * @param {Object} target - 目标对象
   * @param {...Object} sources - 源对象
   * @returns {Object} 合并后的对象
   */
  static merge(target, ...sources) {
    if (!this.isPlainObject(target)) {
      target = {};
    }
    
    for (const source of sources) {
      if (!this.isPlainObject(source)) continue;
      
      for (const key in source) {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
          target[key] = source[key];
        }
      }
    }
    
    return target;
  }

  /**
   * 深度克隆对象（简单实现）
   * @param {any} obj - 待克隆的对象
   * @returns {any} 克隆后的对象
   */
  static clone(obj) {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }
    
    if (this.isArray(obj)) {
      return obj.map(item => this.clone(item));
    }
    
    const cloned = {};
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        cloned[key] = this.clone(obj[key]);
      }
    }
    
    return cloned;
  }

  /**
   * 获取对象的值（支持路径，如 'a.b.c'）
   * @param {Object} obj - 对象
   * @param {string} path - 路径
   * @param {any} defaultValue - 默认值
   * @returns {any}
   */
  static get(obj, path, defaultValue = undefined) {
    if (!this.isPlainObject(obj)) return defaultValue;
    
    const keys = path.split('.');
    let value = obj;
    
    for (const key of keys) {
      if (!this.isPlainObject(value) && !this.isArray(value)) {
        return defaultValue;
      }
      value = value[key];
      if (value === undefined) return defaultValue;
    }
    
    return value;
  }

  /**
   * 设置对象的值（支持路径）
   * @param {Object} obj - 对象
   * @param {string} path - 路径
   * @param {any} value - 值
   */
  static set(obj, path, value) {
    if (!this.isPlainObject(obj)) return;
    
    const keys = path.split('.');
    const lastKey = keys.pop();
    let current = obj;
    
    for (const key of keys) {
      if (!this.isPlainObject(current[key])) {
        current[key] = {};
      }
      current = current[key];
    }
    
    current[lastKey] = value;
  }
}
