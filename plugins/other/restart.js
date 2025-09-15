import { createRequire } from 'module';

const require = createRequire(import.meta.url);

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
   * 执行重启操作
   * @returns {Promise<boolean>} 操作是否成功
   */
  async restart() {
    const currentUin = this.e?.self_id || this.e?.bot?.uin || Bot.uin || '';

    await this.e.reply('开始执行重启，请稍等...');
    const data = JSON.stringify({
      uin: currentUin,
      isGroup: !!this.e.isGroup,
      id: this.e.isGroup ? this.e.group_id : this.e.user_id,
      time: new Date().getTime(),
    });

    await redis.set(`${this.key}:${currentUin}`, data, { EX: 300 });
    setTimeout(() => process.exit(1), 1000);
    return true;
  }

  /**
   * 执行关机操作
   * @returns {Promise<boolean>} 操作是否成功
   */
  async stop() {
    const currentUin = this.e?.self_id;
    try {
      await this.e.reply('关机成功，已停止运行');
      await redis.set(`${this.shutdownKey}:${currentUin}`, 'true');
      return true;
    } catch (error) {
      logger.error(`关机失败: ${error}`);
      await this.e.reply(`关机失败: ${error}`);
      return false;
    }
  }

  /**
   * 执行开机操作
   * @returns {Promise<boolean>} 操作是否成功
   */
  async start() {
    const currentUin = this.e?.self_id || this.e?.bot?.uin || Bot.uin || '';
    const isShutdown = await redis.get(`${this.shutdownKey}:${currentUin}`);

    if (isShutdown !== 'true') {
      await this.e.reply('机器人已经处于开机状态');
      return false;
    }

    await redis.del(`${this.shutdownKey}:${currentUin}`);
    await this.e.reply('开机成功，恢复正常运行');
    return true;
  }
}