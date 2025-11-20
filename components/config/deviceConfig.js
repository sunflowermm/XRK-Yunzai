/**
 * 设备管理器配置文件
 * 集中管理所有配置项，便于维护和扩展
 * 
 * 注意：AI、TTS、ASR配置已迁移到 config/default_config/kuizai.yaml
 * 请通过 lib/config/config.js 的 cfg.kuizai 访问
 */

// ==================== TTS事件定义 ====================
export const TTS_EVENTS = {
    START_CONNECTION: 1,
    FINISH_CONNECTION: 2,
    CONNECTION_STARTED: 50,
    CONNECTION_FAILED: 51,
    CONNECTION_FINISHED: 52,
    START_SESSION: 100,
    CANCEL_SESSION: 101,
    FINISH_SESSION: 102,
    SESSION_STARTED: 150,
    SESSION_CANCELED: 151,
    SESSION_FINISHED: 152,
    SESSION_FAILED: 153,
    TASK_REQUEST: 200,
    TTS_SENTENCE_START: 350,
    TTS_SENTENCE_END: 351,
    TTS_RESPONSE: 352
};

// ==================== 表情关键词映射 ====================
// 中文到英文的表情映射（统一使用）
export const EMOTION_KEYWORDS = {
    '开心': 'happy',
    '伤心': 'sad',
    '生气': 'angry',
    '惊讶': 'surprise',
    '害怕': 'surprise',  // 害怕映射到惊讶
    '爱': 'love',
    '酷': 'cool',
    '睡觉': 'sleep',
    '思考': 'think',
    '眨眼': 'wink',
    '大笑': 'laugh'
};

// 反向映射：英文到中文（用于显示）
export const EMOTION_NAMES = {
    'happy': '开心',
    'sad': '伤心',
    'angry': '生气',
    'surprise': '惊讶',
    'love': '爱',
    'cool': '酷',
    'sleep': '睡觉',
    'think': '思考',
    'wink': '眨眼',
    'laugh': '大笑'
};

// ==================== 支持的表情列表 ====================
export const SUPPORTED_EMOTIONS = [
    'happy', 'sad', 'angry', 'surprise', 'love',
    'cool', 'sleep', 'think', 'wink', 'laugh'
];