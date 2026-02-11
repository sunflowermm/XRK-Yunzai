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
    } else {
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
      // 数组类型：空数组也是有效值，只有 null/undefined 才是空值
      return false;
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
 * 应用默认值到配置数据
 * @param {Object} data - 配置数据
 * @param {Object} schema - 配置schema
 * @returns {Object} 应用默认值后的数据
 */
export function applyDefaults(data, schema) {
  if (!schema || !schema.fields) {
    return data || {};
  }

  const result = data ? { ...data } : {};
  const fields = schema.fields;

  for (const [field, fieldSchema] of Object.entries(fields)) {
    const currentValue = result[field];
    const hasDefault = 'default' in fieldSchema;
    
    // 如果字段不存在或为空值，且有默认值，则应用默认值
    if ((currentValue === undefined || isValueEmpty(currentValue, fieldSchema.type)) && hasDefault) {
      result[field] = cloneConfigValue(fieldSchema.default);
    }
    // 如果字段存在但类型是对象，递归应用默认值
    else if (fieldSchema.type === 'object' && fieldSchema.fields && isPlainObject(currentValue)) {
      result[field] = applyDefaults(currentValue, { fields: fieldSchema.fields });
    }
    // 如果字段是数组，且数组项是对象类型，递归处理
    else if (fieldSchema.type === 'array' && fieldSchema.itemType === 'object' && fieldSchema.itemSchema?.fields) {
      if (Array.isArray(currentValue)) {
        result[field] = currentValue.map(item => 
          isPlainObject(item) 
            ? applyDefaults(item, { fields: fieldSchema.itemSchema.fields })
            : item
        );
      }
    }
  }

  return result;
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
    // 只处理存在的字段，不存在的字段在 applyDefaults 中处理
    if (!(field in normalized)) {
      continue;
    }

    // 类型转换
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
      // 如果字符串解析后为空，返回空数组（这是有效值）
      return [];
    }

    if (val === null || val === undefined || val === '') {
      // null/undefined/空字符串返回空数组（默认值在 applyDefaults 中处理）
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

/**
 * 扁平化配置结构（用于前端编辑）
 * @param {Object} schema - 配置schema
 * @param {string} prefix - 路径前缀
 * @returns {Array} 扁平化的字段列表
 */
export function flattenStructure(schema, prefix = '') {
  if (!schema || !schema.fields) {
    return [];
  }

  const result = [];
  const fields = schema.fields;

  for (const [key, fieldSchema] of Object.entries(fields)) {
    const path = prefix ? `${prefix}.${key}` : key;
    
    // 构建完整的元数据对象，包含所有前端需要的属性
    const baseMeta = fieldSchema.meta || {};
    const enumValue = fieldSchema.enum || baseMeta.enum;
    const optionsValue = fieldSchema.options || baseMeta.options || enumValue;
    
    const meta = {
      ...baseMeta,
      label: fieldSchema.label || fieldSchema.displayName || fieldSchema.name || baseMeta.label || key,
      component: fieldSchema.component || baseMeta.component,
      description: fieldSchema.description || baseMeta.description || '',
      group: fieldSchema.group || baseMeta.group,
      // 确保 enum 和 options 都在 meta 中，前端从这里读取
      enum: enumValue,
      options: optionsValue,
      // 传递其他可能需要的元数据
      placeholder: fieldSchema.placeholder || baseMeta.placeholder,
      readonly: fieldSchema.readonly !== undefined ? fieldSchema.readonly : baseMeta.readonly,
      min: fieldSchema.min !== undefined ? fieldSchema.min : baseMeta.min,
      max: fieldSchema.max !== undefined ? fieldSchema.max : baseMeta.max,
      pattern: fieldSchema.pattern || baseMeta.pattern,
      step: fieldSchema.step !== undefined ? fieldSchema.step : baseMeta.step,
      itemType: fieldSchema.itemType || baseMeta.itemType,
      itemSchema: fieldSchema.itemSchema || baseMeta.itemSchema
    };
    
    const fieldInfo = {
      path,
      key,
      type: fieldSchema.type || 'string',
      displayName: meta.label || key,
      description: meta.description || '',
      default: fieldSchema.default,
      required: fieldSchema.required || false,
      // 为了兼容性，也在顶层保留这些字段
      options: optionsValue,
      enum: enumValue,
      min: fieldSchema.min,
      max: fieldSchema.max,
      pattern: fieldSchema.pattern,
      component: meta.component,
      meta
    };

    // 如果是对象类型且有嵌套字段，递归处理
    if (fieldSchema.type === 'object' && fieldSchema.fields) {
      result.push(fieldInfo);
      const nested = flattenStructure({ fields: fieldSchema.fields }, path);
      result.push(...nested);
    } else if (fieldSchema.type === 'array' && fieldSchema.itemType === 'object' && fieldSchema.itemSchema?.fields) {
      // 数组对象类型：添加数组字段和嵌套字段
      result.push(fieldInfo);
      const nested = flattenStructure({ fields: fieldSchema.itemSchema.fields }, `${path}[]`);
      result.push(...nested);
    } else {
      result.push(fieldInfo);
    }
  }

  return result;
}

/**
 * 扁平化配置数据
 * @param {Object} data - 配置数据
 * @param {string} prefix - 路径前缀
 * @returns {Object} 扁平化的数据对象
 */
export function flattenData(data, prefix = '') {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return {};
  }

  const result = {};

  for (const [key, value] of Object.entries(data)) {
    const path = prefix ? `${prefix}.${key}` : key;

    if (isPlainObject(value)) {
      // 递归处理嵌套对象
      const nested = flattenData(value, path);
      Object.assign(result, nested);
    } else if (Array.isArray(value)) {
      // 数组：直接存储，前端处理
      result[path] = value;
    } else {
      // 基本类型：直接存储
      result[path] = value;
    }
  }

  return result;
}

/**
 * 将扁平化数据还原为嵌套对象
 * @param {Object} flatData - 扁平化的数据
 * @returns {Object} 嵌套对象
 */
export function unflattenData(flatData) {
  if (!flatData || typeof flatData !== 'object') {
    return {};
  }

  const result = {};

  for (const [path, value] of Object.entries(flatData)) {
    const keys = path.split('.');
    let current = result;

    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      // 处理数组索引，如 domains[0]
      const arrayMatch = key.match(/^(.+?)\[(\d+)\]$/);
      if (arrayMatch) {
        const [, arrayKey, index] = arrayMatch;
        if (!current[arrayKey]) current[arrayKey] = [];
        if (!current[arrayKey][parseInt(index)]) current[arrayKey][parseInt(index)] = {};
        current = current[arrayKey][parseInt(index)];
      } else {
        if (!current[key]) current[key] = {};
        current = current[key];
      }
    }

    const lastKey = keys[keys.length - 1];
    const arrayMatch = lastKey.match(/^(.+?)\[(\d+)\]$/);
    if (arrayMatch) {
      const [, arrayKey, index] = arrayMatch;
      if (!current[arrayKey]) current[arrayKey] = [];
      current[arrayKey][parseInt(index)] = value;
    } else {
      current[lastKey] = value;
    }
  }

  return result;
}

