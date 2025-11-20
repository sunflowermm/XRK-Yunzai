/**
 * 表情处理工具
 * 统一管理表情的解析、转换和验证
 */

import { EMOTION_KEYWORDS, SUPPORTED_EMOTIONS } from '../config/deviceConfig.js';

/**
 * 将中文表情转换为英文表情代码
 * @param {string} emotion - 中文表情名称
 * @returns {string|null} 英文表情代码，如果无效则返回null
 */
export function normalizeEmotion(emotion) {
  if (!emotion) return null;
  
  const emotionStr = String(emotion).trim();
  if (!emotionStr) return null;
  
  // 如果已经是英文表情代码，直接验证
  if (SUPPORTED_EMOTIONS.includes(emotionStr.toLowerCase())) {
    return emotionStr.toLowerCase();
  }
  
  // 尝试从中文映射到英文
  const normalized = EMOTION_KEYWORDS[emotionStr];
  if (normalized && SUPPORTED_EMOTIONS.includes(normalized)) {
    return normalized;
  }
  
  return null;
}

/**
 * 验证表情是否有效
 * @param {string} emotion - 表情名称（中文或英文）
 * @returns {boolean} 是否有效
 */
export function isValidEmotion(emotion) {
  return normalizeEmotion(emotion) !== null;
}

/**
 * 从文本中解析表情标记
 * 支持格式：[开心]、[开心}、[惊讶] 等
 * @param {string} text - 包含表情标记的文本
 * @returns {{emotion: string|null, cleanText: string}} 解析结果
 */
export function parseEmotionFromText(text) {
  if (!text || typeof text !== 'string') {
    return { emotion: null, cleanText: text || '' };
  }
  
  // 支持的表情列表（中文）
  const emotionKeywords = Object.keys(EMOTION_KEYWORDS);
  const emotionPattern = emotionKeywords.join('|');
  
  // 匹配 [表情] 或 [表情} 格式（支持在文本开头或中间）
  // 先尝试匹配开头
  let regex = new RegExp(`^\\s*\\[(${emotionPattern})[\\]\\}]\\s*`, 'i');
  let match = regex.exec(text);
  
  // 如果开头没匹配到，尝试匹配任意位置（但只取第一个）
  if (!match) {
    regex = new RegExp(`\\[(${emotionPattern})[\\]\\}]`, 'i');
    match = regex.exec(text);
  }
  
  if (!match) {
    return { emotion: null, cleanText: text.trim() };
  }
  
  const chineseEmotion = match[1];
  const englishEmotion = normalizeEmotion(chineseEmotion);
  
  // 移除表情标记（支持任意位置）
  const cleanText = text.replace(regex, '').trim();
  
  return {
    emotion: englishEmotion,
    cleanText
  };
}

