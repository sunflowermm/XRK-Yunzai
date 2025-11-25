/**
 * 配置管理工具函数
 * 提供数据清理、合并、验证等通用功能
 */

/**
 * 深度合并两个对象
 * @param {Object} target - 目标对象（原有配置）
 * @param {Object} source - 源对象（新配置）
 * @param {Object} schema - 配置schema（用于判断字段类型）
 * @returns {Object} 合并后的对象
 */
export function deepMergeConfig(target, source, schema = {}) {
  const merged = { ...target };
  const fields = schema?.fields || {};

  for (const [key, newValue] of Object.entries(source)) {
    const fieldSchema = fields[key];
    const existingValue = target[key];

    // 如果字段不存在于schema中，直接使用新值
    if (!fieldSchema) {
      merged[key] = newValue;
      continue;
    }

    const expectedType = fieldSchema.type;

    // 判断新值是否为"空值"
    const isNewValueEmpty = isValueEmpty(newValue, expectedType);
    const isExistingValueEmpty = isValueEmpty(existingValue, expectedType);

    // 如果新值是空值，且原有值不是空值，保留原有值
    // 这样可以避免前端没有正确收集到值时，错误地清空原有配置
    if (isNewValueEmpty && !isExistingValueEmpty) {
      // 保留原有值
      continue;
    }

    // 处理嵌套对象
    if (expectedType === 'object' && fieldSchema.fields) {
      if (newValue && typeof newValue === 'object' && !Array.isArray(newValue)) {
        merged[key] = deepMergeConfig(
          existingValue && typeof existingValue === 'object' && !Array.isArray(existingValue) 
            ? existingValue 
            : {},
          newValue,
          { fields: fieldSchema.fields }
        );
      } else {
        merged[key] = newValue;
      }
    } else {
      // 其他类型：使用新值
      merged[key] = newValue;
    }
  }

  return merged;
}

/**
 * 判断值是否为空
 * @param {*} value - 要判断的值
 * @param {string} expectedType - 期望的类型
 * @returns {boolean}
 */
export function isValueEmpty(value, expectedType) {
  if (value === null || value === undefined) {
    return true;
  }

  switch (expectedType) {
    case 'array':
      return Array.isArray(value) && value.length === 0;
    case 'string':
      return typeof value === 'string' && value === '';
    case 'number':
      return value === null || value === undefined;
    case 'boolean':
      return value === null || value === undefined;
    case 'object':
      return value === null || value === undefined || 
             (typeof value === 'object' && Object.keys(value).length === 0);
    default:
      return value === null || value === undefined || value === '';
  }
}

/**
 * 清理配置数据（类型转换）
 * @param {Object} data - 原始数据
 * @param {Object} config - 配置对象（包含schema）
 * @returns {Object} 清理后的数据
 */
export function cleanConfigData(data, config) {
  if (!data || typeof data !== 'object') {
    return data;
  }

  const cleaned = Array.isArray(data) ? [...data] : { ...data };
  const schema = config?.schema;

  if (schema && schema.fields) {
    for (const [field, fieldSchema] of Object.entries(schema.fields)) {
      // 只处理已存在的字段，进行类型转换
      if (!(field in cleaned)) {
        continue;
      }
      
      let value = cleaned[field];
      const expectedType = fieldSchema.type;
      
      // 类型转换：确保类型匹配schema定义
      cleaned[field] = convertValueType(value, expectedType, fieldSchema);
    }
  }

  return cleaned;
}

/**
 * 转换值的类型
 * @param {*} value - 原始值
 * @param {string} expectedType - 期望的类型
 * @param {Object} fieldSchema - 字段schema
 * @returns {*} 转换后的值
 */
export function convertValueType(value, expectedType, fieldSchema) {
  switch (expectedType) {
    case 'array':
      return convertToArray(value, fieldSchema);
    case 'boolean':
      return convertToBoolean(value, fieldSchema);
    case 'number':
      return convertToNumber(value, fieldSchema);
    case 'object':
      return convertToObject(value, fieldSchema);
    case 'string':
      return convertToString(value);
    default:
      return value;
  }
}

/**
 * 转换为数组
 */
function convertToArray(value, fieldSchema) {
  if (Array.isArray(value)) {
    // 已经是数组，递归处理数组中的对象
    if (fieldSchema.itemType === 'object' && fieldSchema.itemSchema) {
      return value.map(item => {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          return cleanConfigData(item, { schema: { fields: fieldSchema.itemSchema.fields || {} } });
        }
        return item;
      });
    }
    return value;
  }

  // 不是数组，尝试转换
  if (value === null || value === undefined || value === '') {
    return [];
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  // 其他类型转换为空数组
  return [];
}

/**
 * 转换为布尔值
 */
function convertToBoolean(value, fieldSchema) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    if (value === 'true' || value === '1' || value === 'on') {
      return true;
    }
    if (value === 'false' || value === '0' || value === 'off' || value === '') {
      return false;
    }
    return fieldSchema.default !== undefined ? fieldSchema.default : false;
  }

  if (value === null || value === undefined) {
    return fieldSchema.default !== undefined ? fieldSchema.default : false;
  }

  return Boolean(value);
}

/**
 * 转换为数字
 */
function convertToNumber(value, fieldSchema) {
  if (typeof value === 'number') {
    return value;
  }

  if (typeof value === 'string') {
    const numValue = Number(value);
    if (!isNaN(numValue) && value.trim() !== '') {
      return numValue;
    }
    if (value === '') {
      return null;
    }
    return fieldSchema.default !== undefined ? fieldSchema.default : null;
  }

  if (value === null || value === undefined || value === '') {
    return null;
  }

  const numValue = Number(value);
  return !isNaN(numValue) ? numValue : (fieldSchema.default !== undefined ? fieldSchema.default : null);
}

/**
 * 转换为对象
 */
function convertToObject(value, fieldSchema) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return cleanConfigData(value, { schema: { fields: fieldSchema.fields || {} } });
  }

  if (value === null || value === undefined || value === '') {
    return fieldSchema.default !== undefined ? fieldSchema.default : {};
  }

  return {};
}

/**
 * 转换为字符串
 */
function convertToString(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

