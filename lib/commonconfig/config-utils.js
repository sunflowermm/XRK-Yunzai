/**
 * 配置管理工具函数
 * 提供数据清理、合并、验证等通用功能
 */

const BOOLEAN_TRUE_SET = new Set(['true', '1', 'yes', 'on']);
const BOOLEAN_FALSE_SET = new Set(['false', '0', 'no', 'off', '']);

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

  for (const [key, newValue] of Object.entries(source || {})) {
    const fieldSchema = fields[key];
    const existingValue = target?.[key];

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
    if (isNewValueEmpty && !isExistingValueEmpty) {
      continue;
    }

    // 处理嵌套对象
    if (expectedType === 'object' && fieldSchema.fields) {
      merged[key] = deepMergeConfig(
        isPlainObject(existingValue) ? existingValue : {},
        isPlainObject(newValue) ? newValue : {},
        { fields: fieldSchema.fields }
      );
      continue;
    }

    merged[key] = newValue;
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
      return typeof value === 'string' && value.trim() === '';
    case 'number':
    case 'boolean':
      return value === null || value === undefined;
    case 'object':
      return !isPlainObject(value) || Object.keys(value).length === 0;
    default:
      return value === null || value === undefined || value === '';
  }
}

/**
 * 清理配置数据（类型转换）
 * @param {Object} data - 原始数据
 * @param {Object} configOrSchema - 配置对象（包含schema）或直接传schema
 * @returns {Object} 清理后的数据
 */
export function cleanConfigData(data, configOrSchema) {
  if (!isPlainObject(data) && !Array.isArray(data)) {
    return data;
  }

  const schema = configOrSchema?.schema || configOrSchema;
  if (!schema || !schema.fields) {
    return cloneConfigValue(data);
  }

  return normalizeBySchema(data, schema.fields);
}

/**
 * 转换值的类型
 * @param {*} value - 原始值
 * @param {string} expectedType - 期望的类型
 * @param {Object} fieldSchema - 字段schema
 * @returns {*} 转换后的值
 */
export function convertValueType(value, expectedType, fieldSchema = {}) {
  const converters = {
    array: convertToArray,
    boolean: convertToBoolean,
    number: convertToNumber,
    object: convertToObject,
    string: convertToString
  };

  const converter = converters[expectedType];
  return converter ? converter(value, fieldSchema) : value;
}

function normalizeBySchema(data, fields) {
  if (Array.isArray(data)) {
    return data.map(item => isPlainObject(item) ? normalizeBySchema(item, fields) : item);
  }

  const normalized = { ...data };

  for (const [field, fieldSchema] of Object.entries(fields)) {
    if (!(field in normalized)) {
      continue;
    }

    normalized[field] = convertValueType(normalized[field], fieldSchema.type, fieldSchema);
  }

  return normalized;
}

/**
 * 转换为数组
 */
function convertToArray(value, fieldSchema = {}) {
  const ensureArray = (val) => {
    if (Array.isArray(val)) {
      return val;
    }

    if (typeof val === 'string') {
      // 优先尝试 JSON，再退回到分隔符
      try {
        const parsed = JSON.parse(val);
        if (Array.isArray(parsed)) {
          return parsed;
        }
      } catch {
        const segments = val
          .split(/[\r\n,]/)
          .map(segment => segment.trim())
          .filter(Boolean);
        if (segments.length) {
          return segments;
        }
      }
      return [];
    }

    if (val === null || val === undefined || val === '') {
      return [];
    }

    return [val];
  };

  const arrayValue = ensureArray(value);

  if (fieldSchema.itemType === 'object' && fieldSchema.itemSchema?.fields) {
    return arrayValue.map(item => {
      if (!isPlainObject(item)) {
        return {};
      }
      return normalizeBySchema(item, fieldSchema.itemSchema.fields);
    });
  }

  if (fieldSchema.itemType && fieldSchema.itemType !== 'object') {
    return arrayValue.map(item => convertValueType(item, fieldSchema.itemType, fieldSchema.itemSchema || {}));
  }

  return arrayValue;
}

/**
 * 转换为布尔值
 */
function convertToBoolean(value, fieldSchema = {}) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (BOOLEAN_TRUE_SET.has(normalized)) {
      return true;
    }
    if (BOOLEAN_FALSE_SET.has(normalized)) {
      return false;
    }
  }

  if (value === null || value === undefined) {
    return fieldSchema.default ?? false;
  }

  return Boolean(value);
}

/**
 * 转换为数字
 */
function convertToNumber(value, fieldSchema = {}) {
  if (typeof value === 'number' && !Number.isNaN(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') {
      return fieldSchema.default ?? null;
    }
    const numValue = Number(trimmed);
    return Number.isNaN(numValue) ? fieldSchema.default ?? null : numValue;
  }

  if (value === null || value === undefined || value === '') {
    return fieldSchema.default ?? null;
  }

  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }

  const numValue = Number(value);
  return Number.isNaN(numValue) ? fieldSchema.default ?? null : numValue;
}

/**
 * 转换为对象
 */
function convertToObject(value, fieldSchema = {}) {
  if (!isPlainObject(value)) {
    if (value === null || value === undefined || value === '') {
      return fieldSchema.default ?? {};
    }
    return {};
  }

  if (!fieldSchema.fields) {
    return { ...value };
  }

  return normalizeBySchema(value, fieldSchema.fields);
}

/**
 * 转换为字符串
 */
function convertToString(value) {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  return String(value);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneConfigValue(value) {
  if (Array.isArray(value)) {
    return value.map(item => cloneConfigValue(item));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, cloneConfigValue(val)]));
  }
  return value;
}

