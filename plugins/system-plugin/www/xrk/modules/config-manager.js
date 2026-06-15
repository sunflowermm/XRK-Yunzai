/**
 * 配置表单工具函数（扁平化路径、嵌套读写、默认值）
 */
import { cloneValue, isSameValue } from './utils.js';

export function flattenObject(obj, prefix = '', out = {}) {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    if (prefix && Object.keys(obj).length === 0) {
      out[prefix] = {};
      return out;
    }
    Object.entries(obj).forEach(([key, val]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        flattenObject(val, path, out);
      } else {
        out[path] = val;
      }
    });
    return out;
  }
  if (prefix) out[prefix] = obj;
  return out;
}

export function unflattenObject(flat = {}) {
  const result = {};
  Object.entries(flat).forEach(([path, value]) => {
    const keys = path.split('.');
    let cursor = result;
    keys.forEach((key, idx) => {
      if (idx === keys.length - 1) {
        cursor[key] = cloneValue(value);
      } else {
        if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = {};
        cursor = cursor[key];
      }
    });
  });
  return result;
}

export function getNestedValue(obj = {}, path = '') {
  if (!path) return obj;
  return path.split('.').reduce((current, key) => (current ? current[key] : undefined), obj);
}

export function setNestedValue(source = {}, path = '', value) {
  if (!path) return cloneValue(value);
  const clone = Array.isArray(source) ? [...source] : { ...source };
  const keys = path.split('.');
  let cursor = clone;
  keys.forEach((key, idx) => {
    if (idx === keys.length - 1) {
      cursor[key] = cloneValue(value);
    } else {
      if (!cursor[key] || typeof cursor[key] !== 'object') {
        cursor[key] = {};
      }
      cursor = cursor[key];
    }
  });
  return clone;
}

export function combineConfigPath(base, tail) {
  if (!base) return tail;
  if (!tail) return base;
  return `${base}.${tail}`;
}

export function normalizeFieldValue(value, meta, typeHint) {
  const type = (meta?.type ?? typeHint ?? '').toLowerCase();
  if (type === 'number') return value === null || value === '' ? null : Number(value);
  if (type === 'boolean') {
    if (typeof value === 'string') {
      const normalized = value.toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
      if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    }
    return !!value;
  }
  if (type === 'array<object>' || (type === 'array' && meta?.itemType === 'object')) return Array.isArray(value) ? value : [];
  if (type === 'array' && Array.isArray(value)) return value;
  if (type === 'array' && typeof value === 'string') return value ? value.split(',').map(v => v.trim()).filter(Boolean) : [];
  return value;
}

export function castValue(value, type) {
  switch ((type ?? '').toLowerCase()) {
    case 'number': return Number(value);
    case 'boolean': return value === 'true' || value === true;
    default: return value;
  }
}

export function normalizeTemplatePath(path = '') {
  return path.replace(/\[\d+\]/g, '[]');
}

export function buildDefaultsFromFields(fields = {}, cloneValueFn = cloneValue) {
  // 与 lib/commonconfig/config-utils.js buildDefaultsFromSchema 语义对齐（前端无法直接 import lib）
  const result = {};
  Object.entries(fields).forEach(([key, schema]) => {
    if (schema.type === 'object' && schema.fields) {
      result[key] = buildDefaultsFromFields(schema.fields, cloneValueFn);
      return;
    }
    if (schema.type === 'array') {
      if (schema.itemType === 'object') {
        result[key] = [];
      } else {
        result[key] = Array.isArray(schema.default) ? [...schema.default] : [];
      }
      return;
    }
    if (Object.hasOwn(schema, 'default')) {
      result[key] = cloneValueFn(schema.default);
    }
  });
  return result;
}

export function formatGroupLabel(label) {
  if (!label || label === '基础') return '基础设置';
  return label.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

/**
 * 按 flat-structure 补齐缺失的 schema 默认值（object / array / subform）
 * 后端 read() 已通过 mergeConfigLayers 合并；此处兜底 flat 路径与脏状态检测。
 */
export function fillMissingSchemaDefaults(flatSchema, values, cloneValueFn = cloneValue) {
  const filled = { ...(values ?? {}) };
  if (!Array.isArray(flatSchema)) return filled;

  for (const field of flatSchema) {
    const path = field?.path;
    if (!path || path.includes('[]') || Object.hasOwn(filled, path)) continue;

    const meta = field.meta ?? {};
    const component = String(meta.component ?? field.component ?? '').toLowerCase();
    const type = String(meta.type ?? field.type ?? '').toLowerCase();
    const isArrayType = type === 'array' || type === 'array<object>' || type.startsWith('array');
    const isObjectLike = type === 'object' || type === 'map';
    const isSubForm = component === 'subform';

    if (isArrayType) {
      filled[path] = Object.hasOwn(meta, 'default') || Object.hasOwn(field, 'default')
        ? cloneValueFn(meta.default ?? field.default)
        : [];
      continue;
    }

    if (!isObjectLike && !isSubForm) continue;

    if (Object.hasOwn(meta, 'default') || Object.hasOwn(field, 'default')) {
      filled[path] = cloneValueFn(meta.default ?? field.default);
    } else if (isObjectLike) {
      filled[path] = {};
    }
  }

  return filled;
}
