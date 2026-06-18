#!/usr/bin/env node
/**
 * 从 NTQQ 本地 emoji 缓存导入表情包到 resources/aiimages/{分类}/
 * 文件夹名 = md5(搜索关键词)，见 emoji-related/emoji/words.json
 * 同一 GIF（文件名即内容 hash）在同一分类内只保留一份，后导入的源覆盖先前的。
 *
 * 用法:
 *   node scripts/import-qq-emojis.mjs [--dry-run]
 *   node scripts/import-qq-emojis.mjs --qq-emoji-dir <path>   # 可多次指定，后者覆盖前者
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMOTION_TYPES } from '../lib/utils/emotion-categories.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_QQ_EMOJI_DIRS = [
  String.raw`C:\Users\sunflowerss\Documents\Tencent Files\1814632762\nt_qq\nt_data\Emoji\emoji-related\emoji`,
  String.raw`C:\Users\sunflowerss\Downloads\emoji-related\emoji-related\emoji`
];
const OUT_DIR = path.join(PROJECT_ROOT, 'resources', 'aiimages');
const MAX_PER_CATEGORY = 160;
const MAX_PER_PACK = 24;

/** 本机已下载表情包搜索词 → 情绪分类（精确映射） */
const KEYWORD_TO_CATEGORY = {
  '!': '开心', '!!!': '惊讶', '!!!!': '惊讶', '。。。': '无语', '?': '疑惑', '???': '疑惑',
  '520': '庆祝', '6': '惊讶', '666': '惊讶', '6666': '惊讶', '66666': '惊讶', '666666': '惊讶', 'zzz': '睡',
  '啊': '惊讶', '啊啊啊啊啊': '惊讶', '哎': '无语', '安': '晚安', '笨猪': '鄙视', '别慌': '害怕', '别怕': '害怕',
  '不给': '生气', '不好': '伤心', '不可以': '生气', '不玩': '无语', '不行': '生气', '不需要': '无语', '不要': '生气',
  '不知道': '疑惑', '吃完了吗': '疑惑', '吃了吗': '疑惑', '冲': '加油', '大妈': '吃瓜', '大帅哥': '得意', '大象': '可爱', '当然': '开心',
  '端午': '庆祝', '对': '开心', '对啊': '开心', '对不起': '抱歉', '对不起嘛': '抱歉', '服了': '无语', '复习': '摸鱼', '上课': '摸鱼',
  '感谢': '谢谢', '哥们': '开心', '鸽': '摸鱼', '给我': '生气', '哈哈哈': '大笑', '哈哈哈哈': '大笑', '哈哈': '大笑', '哈': '大笑',
  '哈哈哈哈哈哈哈哈': '大笑', '寒假': '摸鱼', '好': '开心', '好啊': '开心', '好吧': '无语', '好得很': '得意', '好吃': '开心',
  '好的': '开心', '好的好的': '开心', '好厉害': '开心', '很漂亮': '开心', '回我': '疑惑', '急': '加油', '假的': '惊讶',
  '救命': '害怕', '救我': '害怕', '就不': '生气', '就是': '无语', '绝交': '伤心', '绝交吧': '伤心', '看不见我': '害羞',
  '看见了': '开心', '可莉': '可爱', '可以': '开心', '可以可以': '开心', '快吃': '加油', '来': '开心', '乐': '大笑', '溜': '摸鱼', '鹿': '可爱',
  '萝莉': '可爱', '绿': '生气', '妈呀': '惊讶', '马上': '加油', '没关系': '抱歉', '没关系的': '抱歉', '没事': '无语',
  '没事的': '无语', '没有': '无语', '喵': '可爱', '喵喵喵': '可爱', '嗯': '无语', '嗯哼': '无语', '嗯嗯': '无语', '额': '无语',
  '你们加油': '加油', '你啥意思': '疑惑', '你有病吧': '鄙视', '努力': '加油', '哦': '无语', '跑路': '摸鱼', '呸': '生气', '碰瓷': '鄙视',
  '欺负': '委屈', '气死了': '生气', '气死我': '生气', '切': '鄙视', '求': '委屈', '求你了': '委屈', '求求了': '委屈', '确实': '开心',
  '让你不理我': '生气', '任性': '得意', '啥': '疑惑', '啥玩意': '疑惑', '啥意思': '疑惑', '上': '加油', '什么': '疑惑', '生日': '庆祝',
  '睡觉': '睡', '睡觉觉': '睡', '死开': '生气', '搜嘎': '开心', '算了': '无语', '随便': '无语', '兔子': '可爱', '哇塞': '惊讶',
  '晚安': '晚安', '早': '晚安', '为啥': '疑惑', '为啥啊': '疑惑', '为什么': '疑惑', '喂': '疑惑', '我不会啊': '委屈', '我错了': '抱歉',
  '我的乖乖': '可爱', '我的眼睛': '害羞', '我服了': '无语', '我看看': '吃瓜', '我努力': '加油', '我去': '惊讶', '我受不了了': '伤心', '我忘了': '疑惑',
  '我也是': '委屈', '我在': '开心', '我知道': '开心', '呜呜呜': '伤心', '喜欢': '喜欢', '下班': '摸鱼', '下班了吗': '摸鱼',
  '咸鱼': '摸鱼', '羡慕': '委屈', '相信你': '开心', '小菜鸡': '鄙视', '小丑': '无语', '晓得': '开心', '笑死': '大笑',
  '笑死了': '大笑', '笑死我了': '大笑', '绷不住': '大笑', '行': '开心', '有道理': '开心', '有钱人': '得意', '有人吗?': '疑惑', '原神': '吃瓜',
  '晕倒': '害怕', '咋': '疑惑', '在': '疑惑', '在么': '疑惑', '怎么可能': '惊讶', '不会吧': '惊讶', '怎么样': '疑惑', '怎么这样': '伤心',
  '真的': '惊讶', '真实': '无语', '知道': '开心', '植物大战僵尸': '吃瓜', '抓': '生气', '踢了': '生气', '奇怪了': '疑惑', 'ok': '开心',
  '想看': '疑惑', '吃': '开心', '吃吃': '开心', '点外卖': '吃瓜', '帅': '得意', '神了': '惊讶', '卑鄙': '鄙视', '小短腿': '可爱'
};

/** 关键词规则兜底（精确表未命中时） */
const KEYWORD_RULES = [
  ['晚安', '晚安'], ['睡觉', '睡'], ['困', '睡'], ['zzz', '睡'], ['早', '晚安'],
  ['摸鱼', '摸鱼'], ['划水', '摸鱼'], ['下班', '摸鱼'], ['咸鱼', '摸鱼'], ['溜', '摸鱼'], ['上课', '摸鱼'], ['复习', '摸鱼'],
  ['加油', '加油'], ['冲', '加油'], ['奋斗', '加油'], ['努力', '加油'],
  ['庆祝', '庆祝'], ['撒花', '庆祝'], ['恭喜', '庆祝'], ['520', '庆祝'], ['生日', '庆祝'],
  ['谢谢', '谢谢'], ['感谢', '谢谢'], ['多谢', '谢谢'],
  ['抱歉', '抱歉'], ['对不起', '抱歉'], ['我错了', '抱歉'], ['不好意思', '抱歉'],
  ['比心', '爱心'], ['爱你', '爱心'], ['love', '爱心'], ['喜欢', '喜欢'], ['爱心', '爱心'],
  ['吃瓜', '吃瓜'], ['八卦', '吃瓜'], ['看看', '吃瓜'], ['外卖', '吃瓜'],
  ['鄙视', '鄙视'], ['差劲', '鄙视'], ['白眼', '鄙视'], ['切', '鄙视'], ['卑鄙', '鄙视'],
  ['害羞', '害羞'], ['脸红', '害羞'],
  ['疑惑', '疑惑'], ['为什么', '疑惑'], ['为啥', '疑惑'], ['什么', '疑惑'], ['???', '疑惑'], ['忘了', '疑惑'], ['奇怪', '疑惑'],
  ['委屈', '委屈'], ['可怜', '委屈'], ['求', '委屈'], ['呜呜', '伤心'],
  ['得意', '得意'], ['骄傲', '得意'], ['帅', '得意'],
  ['尴尬', '尴尬'], ['糗', '尴尬'], ['绷不住', '大笑'],
  ['无语', '无语'], ['呵呵', '无语'], ['emm', '无语'], ['算了', '无语'], ['。。。', '无语'], ['嗯', '无语'],
  ['可爱', '可爱'], ['卖萌', '可爱'], ['喵', '可爱'],
  ['生气', '生气'], ['怒', '生气'], ['气死', '生气'], ['不要', '生气'], ['不行', '生气'], ['踢', '生气'],
  ['害怕', '害怕'], ['吓', '害怕'], ['救命', '害怕'], ['救我', '害怕'], ['别慌', '害怕'],
  ['惊讶', '惊讶'], ['震惊', '惊讶'], ['我去', '惊讶'], ['666', '惊讶'], ['哇', '惊讶'], ['神了', '惊讶'],
  ['伤心', '伤心'], ['哭', '伤心'], ['泪', '伤心'], ['绝交', '伤心'], ['不好', '伤心'],
  ['大笑', '大笑'], ['哈哈', '大笑'], ['笑死', '大笑'],
  ['开心', '开心'], ['好的', '开心'], ['可以', '开心'], ['行', '开心'], ['对', '开心'], ['ok', '开心'], ['吃', '开心']
];

function md5(text) {
  return crypto.createHash('md5').update(text, 'utf8').digest('hex');
}

function loadWordToPackMap(emojiDirs) {
  const map = new Map();
  for (const dir of emojiDirs) {
    const wordsPath = path.join(dir, 'words.json');
    if (!fs.existsSync(wordsPath)) continue;
    const words = JSON.parse(fs.readFileSync(wordsPath, 'utf8')).words;
    for (const word of words) {
      map.set(md5(word), word);
    }
  }
  return map;
}

function categorizeKeyword(keyword) {
  if (KEYWORD_TO_CATEGORY[keyword]) return KEYWORD_TO_CATEGORY[keyword];
  const k = String(keyword).toLowerCase();
  for (const [pattern, category] of KEYWORD_RULES) {
    if (k.includes(pattern.toLowerCase()) || keyword.includes(pattern)) {
      if (EMOTION_TYPES.includes(category)) return category;
    }
  }
  return null;
}

/** 目标文件名：GIF 自身 hash，同图重复导入时覆盖 */
function destFileName(gifBaseName) {
  return /\.gif$/i.test(gifBaseName) ? gifBaseName : `${gifBaseName}.gif`;
}

const LEGACY_DEST_RE = /^.+\_[a-f0-9]{8}\_\d+\.gif$/i;
const HASH_DEST_RE = /^[a-f0-9]{32}\.gif$/i;

/** 移除旧版 keyword_pack_index.gif 命名，避免与 hash 去重文件并存 */
function cleanLegacyDestFiles(dryRun) {
  if (!fs.existsSync(OUT_DIR)) return 0;
  let removed = 0;
  for (const cat of fs.readdirSync(OUT_DIR, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    for (const f of fs.readdirSync(path.join(OUT_DIR, cat.name))) {
      if (!LEGACY_DEST_RE.test(f) || HASH_DEST_RE.test(f)) continue;
      const p = path.join(OUT_DIR, cat.name, f);
      if (!dryRun) fs.unlinkSync(p);
      removed += 1;
    }
  }
  return removed;
}

function parseArgs(argv) {
  const opts = { dryRun: false, qqEmojiDirs: [...DEFAULT_QQ_EMOJI_DIRS] };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--dry-run') opts.dryRun = true;
    else if (argv[i] === '--qq-emoji-dir') opts.qqEmojiDirs.push(argv[++i]);
  }
  opts.qqEmojiDirs = [...new Set(opts.qqEmojiDirs.filter((d) => d && fs.existsSync(d)))];
  return opts;
}

function importFromSource(emojiDir, wordByPack, opts, stats, unmapped, copied, seenByCategory) {
  const packDirs = fs.readdirSync(emojiDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  let overwritten = 0;
  let deduped = 0;

  for (const packHash of packDirs) {
    const keyword = wordByPack.get(packHash);
    if (!keyword) {
      unmapped.push({ source: emojiDir, packHash, reason: 'unknown keyword' });
      continue;
    }
    const category = categorizeKeyword(keyword);
    if (!category) {
      unmapped.push({ source: emojiDir, packHash, keyword, reason: 'no category rule' });
      continue;
    }

    const gifs = fs.readdirSync(path.join(emojiDir, packHash))
      .filter((f) => /\.gif$/i.test(f))
      .slice(0, MAX_PER_PACK);

    if (!gifs.length) continue;

    const outCatDir = path.join(OUT_DIR, category);
    if (!opts.dryRun) fs.mkdirSync(outCatDir, { recursive: true });

    if (stats[category].files >= MAX_PER_CATEGORY) {
      stats[category].skipped += gifs.length;
      continue;
    }

    stats[category].packs += 1;
    const seen = seenByCategory.get(category) || new Set();
    seenByCategory.set(category, seen);

    for (const gif of gifs) {
      if (stats[category].files >= MAX_PER_CATEGORY) {
        stats[category].skipped += 1;
        continue;
      }

      const fileName = destFileName(gif);
      const dest = path.join(outCatDir, fileName);
      const existed = seen.has(fileName) || fs.existsSync(dest);

      if (seen.has(fileName)) deduped += 1;
      else stats[category].files += 1;

      if (!opts.dryRun) fs.copyFileSync(path.join(emojiDir, packHash, gif), dest);
      if (existed) overwritten += 1;

      seen.add(fileName);
      copied.push({
        category,
        keyword,
        source: path.basename(emojiDir),
        dest: path.relative(PROJECT_ROOT, dest),
        overwrite: existed
      });
    }
  }

  return { packCount: packDirs.length, overwritten, deduped };
}

function main() {
  const opts = parseArgs(process.argv);
  if (!opts.qqEmojiDirs.length) {
    console.error('未找到可用的 QQ emoji 目录');
    process.exit(1);
  }

  const wordByPack = loadWordToPackMap(opts.qqEmojiDirs);
  const legacyRemoved = cleanLegacyDestFiles(opts.dryRun);
  const stats = Object.fromEntries(EMOTION_TYPES.map((t) => [t, { packs: 0, files: 0, skipped: 0 }]));
  const unmapped = [];
  const copied = [];
  const seenByCategory = new Map();
  const sourceReports = [];

  for (const emojiDir of opts.qqEmojiDirs) {
    sourceReports.push({
      dir: emojiDir,
      ...importFromSource(emojiDir, wordByPack, opts, stats, unmapped, copied, seenByCategory)
    });
  }

  console.log(JSON.stringify({
    dryRun: opts.dryRun,
    legacyRemoved,
    sources: sourceReports,
    mappedKeywords: wordByPack.size,
    imported: copied.filter((c) => !c.overwrite).length,
    overwritten: copied.filter((c) => c.overwrite).length,
    totalWritten: copied.length,
    unmappedCount: unmapped.length,
    byCategory: stats,
    sampleUnmapped: unmapped.slice(0, 10)
  }, null, 2));
}

main();
