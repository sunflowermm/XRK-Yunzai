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
// 中文到英文的表情映射（统一使用，支持多种同义词）
export const EMOTION_KEYWORDS = {
    // 基础表情
    '开心': 'happy',
    '高兴': 'happy',
    '快乐': 'happy',
    '愉快': 'happy',
    '兴奋': 'excited',
    '激动': 'excited',
    
    '伤心': 'sad',
    '难过': 'sad',
    '悲伤': 'sad',
    '沮丧': 'sad',
    '失落': 'sad',
    
    '生气': 'angry',
    '愤怒': 'angry',
    '恼火': 'angry',
    '烦躁': 'angry',
    
    '惊讶': 'surprise',
    '吃惊': 'surprise',
    '震惊': 'surprise',
    '意外': 'surprise',
    '害怕': 'surprise',  // 害怕映射到惊讶
    '恐惧': 'surprise',
    
    '爱': 'love',
    '喜欢': 'love',
    '爱心': 'love',
    '喜爱': 'love',
    
    '酷': 'cool',
    '帅气': 'cool',
    '潇洒': 'cool',
    
    '睡觉': 'sleep',
    '困': 'sleep',
    '疲惫': 'sleep',
    '累': 'sleep',
    '疲倦': 'sleep',
    
    '思考': 'think',
    '想': 'think',
    '考虑': 'think',
    '专注': 'think',
    '认真': 'think',
    
    '眨眼': 'wink',
    '调皮': 'wink',
    '顽皮': 'wink',
    
    '大笑': 'laugh',
    '笑': 'laugh',
    '哈哈': 'laugh',
    '搞笑': 'laugh',
    
    // 扩展表情
    '害羞': 'shy',
    '不好意思': 'shy',
    '腼腆': 'shy',
    
    '困惑': 'confused',
    '疑惑': 'confused',
    '不解': 'confused',
    '迷茫': 'confused',
    
    '骄傲': 'proud',
    '自豪': 'proud',
    '得意': 'proud',
    
    '无聊': 'bored',
    '无趣': 'bored',
    '乏味': 'bored',
    
    '担心': 'worried',
    '忧虑': 'worried',
    '焦虑': 'worried',
    
    '平静': 'calm',
    '安静': 'calm',
    '淡定': 'calm',
    
    '调皮': 'playful',
    '活泼': 'playful',
    '活跃': 'playful',
    
    '温柔': 'gentle',
    '温和': 'gentle',
    '柔和': 'gentle',
    
    '严肃': 'serious',
    '认真': 'serious',
    '正经': 'serious'
};

// 反向映射：英文到中文（用于显示）
export const EMOTION_NAMES = {
    'happy': '开心',
    'excited': '兴奋',
    'sad': '伤心',
    'angry': '生气',
    'surprise': '惊讶',
    'love': '爱',
    'cool': '酷',
    'sleep': '睡觉',
    'think': '思考',
    'wink': '眨眼',
    'laugh': '大笑',
    'shy': '害羞',
    'confused': '困惑',
    'proud': '骄傲',
    'bored': '无聊',
    'worried': '担心',
    'calm': '平静',
    'playful': '调皮',
    'gentle': '温柔',
    'serious': '严肃'
};

// ==================== 支持的表情列表 ====================
export const SUPPORTED_EMOTIONS = [
    // 基础表情
    'happy', 'excited', 'sad', 'angry', 'surprise', 'love',
    'cool', 'sleep', 'think', 'wink', 'laugh',
    // 扩展表情
    'shy', 'confused', 'proud', 'bored', 'worried',
    'calm', 'playful', 'gentle', 'serious'
];