import BotUtil from '../common/util.js';

/**
 * 通用记忆系统（底层基础）
 * 面向多场景调用，支持场景隔离
 */
export class MemorySystem {
  constructor(options = {}) {
    this.enabled = redis !== null && redis !== undefined;
    this.baseKey = options.baseKey || 'ai:memory';
    this.masterKey = `${this.baseKey}:master`;
    this.maxPerOwner = options.maxPerOwner || 60;
    this.layerTTL = {
      long: options.longTTL || (3 * 24 * 60 * 60 * 1000),
      short: options.shortTTL || (24 * 60 * 60 * 1000),
      master: Infinity
    };
  }

  /**
   * 检查是否启用
   */
  isEnabled() {
    return !!this.enabled;
  }

  /**
   * 规范化层级
   */
  normalizeLayer(layer) {
    if (!layer) return 'long';
    const map = {
      long: 'long',
      '长期': 'long',
      '长期记忆': 'long',
      short: 'short',
      '短期': 'short',
      '临时': 'short',
      master: 'master',
      '主人': 'master'
    };
    return map[layer.toLowerCase()] || 'long';
  }

  /**
   * 生成所有者键（场景隔离）
   * @param {string} ownerId - 所有者ID（如 userId, groupId, deviceId等）
   * @param {string} scene - 场景标识（如 'group', 'private', 'device'等）
   */
  ownerKey(ownerId, scene = null) {
    if (scene) {
      return `${this.baseKey}:${scene}:${ownerId}`;
    }
    return `${this.baseKey}:owner:${ownerId}`;
  }

  /**
   * 从事件对象提取场景信息
   * @param {Object} e - 事件对象
   * @returns {Object} { ownerId, scene }
   */
  extractScene(e) {
    if (!e) {
      return { ownerId: 'global', scene: 'global' };
    }

    // 群聊场景
    if (e.group_id) {
      return {
        ownerId: `group:${e.group_id}`,
        scene: 'group'
      };
    }

    // 私聊场景
    if (e.user_id) {
      return {
        ownerId: String(e.user_id),
        scene: 'private'
      };
    }

    // 设备场景
    if (e.device_id) {
      return {
        ownerId: String(e.device_id),
        scene: 'device'
      };
    }

    // 默认全局场景
    return { ownerId: 'global', scene: 'global' };
  }

  /**
   * 初始化主人记忆
   */
  async initMasters(masterList = []) {
    if (!this.enabled) return;
    await redis.del(this.masterKey).catch(() => {});
    if (!masterList.length) return;
    
    const payloads = masterList.map(qq => JSON.stringify({
      id: `master_${qq}`,
      layer: 'master',
      content: `QQ:${qq} 是真正的主人`,
      createdAt: Date.now(),
      metadata: { qq, scene: 'master' }
    }));
    
    await redis.rPush(this.masterKey, payloads).catch(() => {});
  }

  /**
   * 获取主人记忆
   */
  async getMasterMemories() {
    if (!this.enabled) return [];
    const raw = await redis.lRange(this.masterKey, 0, -1).catch(() => []);
    return raw.map(item => {
      try { return JSON.parse(item); } catch { return null; }
    }).filter(Boolean);
  }

  /**
   * 记住信息
   * @param {Object} params - 记忆参数
   * @param {string} params.ownerId - 所有者ID
   * @param {string} params.scene - 场景标识
   * @param {string} params.layer - 层级（long/short/master）
   * @param {string} params.content - 记忆内容
   * @param {Object} params.metadata - 元数据
   * @param {string} params.authorId - 作者ID
   */
  async remember({ ownerId, scene, layer = 'long', content, metadata = {}, authorId }) {
    if (!this.enabled || !content?.trim()) return false;

    const normalizedLayer = this.normalizeLayer(layer);
    const key = this.ownerKey(ownerId, scene);
    const now = Date.now();
    const ttl = this.layerTTL[normalizedLayer] || this.layerTTL.long;
    
    const memory = {
      id: `mem_${now}_${Math.random().toString(36).slice(2, 8)}`,
      ownerId,
      scene: scene || 'global',
      layer: normalizedLayer,
      content: content.trim(),
      metadata: {
        ...metadata,
        scene: scene || 'global'
      },
      authorId,
      createdAt: now,
      expireAt: normalizedLayer === 'master' ? Infinity : (now + ttl)
    };

    await redis.zAdd(key, [{ score: memory.createdAt, value: JSON.stringify(memory) }]).catch(() => {});
    
    if (normalizedLayer !== 'master') {
      await redis.zRemRangeByScore(key, 0, now - ttl).catch(() => {});
    }

    const count = await redis.zCard(key).catch(() => 0);
    if (count > this.maxPerOwner) {
      await redis.zRemRangeByRank(key, 0, count - this.maxPerOwner - 1).catch(() => {});
    }

    if (normalizedLayer !== 'master' && ttl !== Infinity) {
      await redis.expire(key, Math.ceil((ttl * 2) / 1000)).catch(() => {});
    }
    
    BotUtil.makeLog('info', `[记忆] (${normalizedLayer}) ${scene || 'global'}:${ownerId}: ${memory.content}`, 'MemorySystem');
    return memory;
  }

  /**
   * 获取记忆（场景隔离）
   * @param {string} ownerId - 所有者ID
   * @param {string} scene - 场景标识（必须匹配，否则不返回）
   * @param {Object} options - 选项
   */
  async getMemories(ownerId, scene, { limit = 6, layers = ['long', 'short'] } = {}) {
    if (!this.enabled) return [];
    
    const key = this.ownerKey(ownerId, scene);
    const raw = await redis.zRange(key, -limit * 3, -1).catch(() => []);
    const now = Date.now();
    const items = [];

    for (let i = raw.length - 1; i >= 0; i--) {
      try {
        const mem = JSON.parse(raw[i]);
        
        // 场景隔离：只返回匹配场景的记忆
        if (mem.scene && mem.scene !== scene) {
          continue;
        }
        
        // 检查过期
        if (mem.expireAt && mem.expireAt < now && mem.expireAt !== Infinity) {
          await redis.zRem(key, raw[i]).catch(() => {});
          continue;
        }
        
        if (layers.includes(mem.layer)) {
          items.push(mem);
        }
        
        if (items.length >= limit) break;
      } catch {
        continue;
      }
    }

    return items;
  }

  /**
   * 删除记忆
   * @param {string} ownerId - 所有者ID
   * @param {string} scene - 场景标识
   * @param {string} memoryId - 记忆ID（可选，不提供则删除所有）
   * @param {string} content - 记忆内容关键词（可选，用于模糊匹配）
   */
  async forget(ownerId, scene, memoryId = null, content = null) {
    if (!this.enabled) return false;

    const key = this.ownerKey(ownerId, scene);
    
    if (memoryId) {
      // 精确删除
      const raw = await redis.zRange(key, 0, -1).catch(() => []);
      for (const item of raw) {
        try {
          const mem = JSON.parse(item);
          if (mem.id === memoryId) {
            await redis.zRem(key, item).catch(() => {});
            BotUtil.makeLog('info', `[记忆删除] ${scene}:${ownerId}: ${mem.content}`, 'MemorySystem');
            return true;
          }
        } catch {
          continue;
        }
      }
      return false;
    }
    
    if (content) {
      // 模糊匹配删除
      const raw = await redis.zRange(key, 0, -1).catch(() => []);
      let deleted = 0;
      for (const item of raw) {
        try {
          const mem = JSON.parse(item);
          if (mem.content && mem.content.includes(content)) {
            await redis.zRem(key, item).catch(() => {});
            deleted++;
            BotUtil.makeLog('info', `[记忆删除] ${scene}:${ownerId}: ${mem.content}`, 'MemorySystem');
          }
        } catch {
          continue;
        }
      }
      return deleted > 0;
    }
    
    // 删除所有记忆
    await redis.del(key).catch(() => {});
    BotUtil.makeLog('info', `[记忆清空] ${scene}:${ownerId}`, 'MemorySystem');
    return true;
  }

  /**
   * 构建记忆摘要（场景隔离）
   * @param {Object} e - 事件对象
   * @param {Object} options - 选项
   */
  async buildSummary(e, { preferUser = false } = {}) {
    if (!this.enabled) return '';
    
    const { ownerId, scene } = this.extractScene(e);
    const userId = e?.user_id ? String(e.user_id) : null;
    const groupId = e?.group_id ? `group:${e.group_id}` : null;

    const [master, userMemories, groupMemories] = await Promise.all([
      this.getMasterMemories(),
      userId && scene !== 'group' ? this.getMemories(userId, 'private', { 
        limit: preferUser ? 6 : 4 
      }) : [],
      groupId && scene === 'group' ? this.getMemories(groupId, 'group', { 
        limit: 4 
      }) : []
    ]);

    const lines = [];
    if (master?.length) {
      lines.push(`主人：${master.map(m => m.content).join('；')}`);
    }
    if (userMemories?.length && scene !== 'group') {
      lines.push(`当前用户：${userMemories.map(m => m.content).join('；')}`);
    }
    if (groupMemories?.length && scene === 'group') {
      lines.push(`当前群：${groupMemories.map(m => m.content).join('；')}`);
    }

    return lines.join('\n');
  }
}

