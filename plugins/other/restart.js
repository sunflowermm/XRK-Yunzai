import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * 重启与关机插件
 * 提供机器人的重启、关机和开机功能
 */
export class Restart extends plugin {
  constructor(e = '') {
    super({
      name: '重启与关机',
      dsc: '#重启 #关机 #停机 #开机',
      event: 'message',
      priority: 10,
      rule: [
        { reg: '^#重启$', fnc: 'restart', permission: 'master' },
        { reg: '^#(停机|关机)$', fnc: 'stop', permission: 'master' },
        { reg: '^#开机$', fnc: 'start', permission: 'master' },
      ],
    });

    if (e) this.e = e;
    this.key = 'Yz:restart';
    this.shutdownKey = 'Yz:shutdown';
    this.isServerMode = process.argv.includes('server');
  }

  /**
   * 初始化方法
   * 监听机器人上线事件，用于重启后发送提示消息
   */
  init() {
    Bot.once('online', this.restartMsg.bind(this));
  }

  /**
   * 重启后发送提示消息
   * 从Redis读取重启信息并发送到原会话
   */
  async restartMsg(e) {
    const currentUin = e?.self_id || Bot.uin[0];
    if (!currentUin) {
      logger.debug('无法获取机器人QQ号，跳过重启消息发送');
      return;
    }
    
    let restart = await redis.get(`${this.key}:${currentUin}`);
    if (!restart) {
      logger.debug('没有检测到重启信息，机器人正常启动');
      return;
    }
    
    try {
      restart = JSON.parse(restart);
      let time = restart.time || new Date().getTime();
      time = (new Date().getTime() - time) / 1000;
      
      let msg = `重启成功，耗时${time.toFixed(2)}秒`;
      
      if (restart.isGroup) {
        await Bot[currentUin].pickGroup(restart.id).sendMsg(msg);
      } else {
        await Bot[currentUin].pickUser(restart.id).sendMsg(msg);
      }
      await redis.del(`${this.key}:${currentUin}`);
      logger.mark(`[重启消息][${currentUin}] 重启消息发送成功`);
    } catch (error) {
      logger.error(`发送重启消息失败：${error}`);
    }
  }

  /**
   * 执行重启操作
   * 保存当前会话信息并重启进程
   * @returns {Promise<boolean>} 操作是否成功
   */
  async restart() {
    const currentUin = this.e?.self_id || this.e?.bot?.uin || Bot.uin || '';

    await this.e.reply('开始执行重启，请稍等...');
    
    // 保存重启信息，用于重启后恢复会话
    const data = JSON.stringify({
      uin: currentUin,
      isGroup: !!this.e.isGroup,
      id: this.e.isGroup ? this.e.group_id : this.e.user_id,
      time: new Date().getTime(),
    });

    // 设置5分钟过期时间，防止重启失败后残留数据
    await redis.set(`${this.key}:${currentUin}`, data, { EX: 300 });
    
    // 延迟1秒后退出进程，让消息发送完成
    setTimeout(() => process.exit(1), 1000);
    return true;
  }

  /**
   * 执行关机操作
   * 设置关机标志，阻止机器人响应所有消息
   * @returns {Promise<boolean>} 操作是否成功
   */
  async stop() {
    const currentUin = this.e?.self_id || this.e?.bot?.uin || Bot.uin || '';
    
    try {
      // 设置关机标志，不设置过期时间，需要手动开机
      await redis.set(`${this.shutdownKey}:${currentUin}`, 'true');
      await this.e.reply('关机成功，已停止运行。发送"#开机"可恢复运行');
      
      logger.mark(`[关机][${currentUin}] 机器人已关机`);
      return true;
    } catch (error) {
      logger.error(`[关机失败][${currentUin}]: ${error.message}`);
      await this.e.reply(`关机失败: ${error.message}`);
      return false;
    }
  }

  /**
   * 执行开机操作
   * 清除关机标志，恢复机器人正常运行
   * @returns {Promise<boolean>} 操作是否成功
   */
  async start() {
    const currentUin = this.e?.self_id || this.e?.bot?.uin || Bot.uin || '';
    
    // 检查是否处于关机状态
    const isShutdown = await redis.get(`${this.shutdownKey}:${currentUin}`);

    if (isShutdown !== 'true') {
      await this.e.reply('机器人已经处于开机状态');
      return false;
    }

    // 删除关机标志
    await redis.del(`${this.shutdownKey}:${currentUin}`);
    await this.e.reply('开机成功，恢复正常运行');
    
    logger.mark(`[开机][${currentUin}] 机器人已开机`);
    return true;
  }
}