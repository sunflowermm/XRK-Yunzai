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
   * 浅合并若干普通对象到新对象（忽略非对象；用于 headers/extraBody/proxy 等）
   * @param {...Object} sources
   * @returns {Object}
   */
  static shallowMergePlain(...sources) {
    const out = {};
    for (const src of sources) {
      if (this.isPlainObject(src)) Object.assign(out, src);
    }
    return out;
  }

  /**
   * 深度合并不修改 target（返回新对象）
   * @param {Object} target
   * @param {Object} source
   * @returns {Object}
   */
  static deepMergeImmutable(target, source) {
    const output = { ...target };
    if (!this.isPlainObject(target) || !this.isPlainObject(source)) return output;

    for (const key of Object.keys(source)) {
      output[key] = this.isPlainObject(source[key]) && this.isPlainObject(target[key])
        ? this.deepMergeImmutable(target[key], source[key])
        : source[key];
    }
    return output;
  }

  /**
   * 深度合并到 target（可变，修改 target 本身）
   * @param {Object} target
   * @param {...Object} sources
   * @returns {Object}
   */
  static deepMerge(target, ...sources) {
    if (!sources.length) return target;

    const source = sources.shift();
    if (this.isPlainObject(target) && this.isPlainObject(source)) {
      for (const key of Object.keys(source)) {
        if (this.isPlainObject(source[key])) {
          if (!this.isPlainObject(target[key])) target[key] = {};
          this.deepMerge(target[key], source[key]);
        } else {
          target[key] = source[key];
        }
      }
    }

    return this.deepMerge(target, ...sources);
  }

  /**
   * 递归克隆（不处理循环引用）
   * @param {any} obj
   * @returns {any}
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
}
