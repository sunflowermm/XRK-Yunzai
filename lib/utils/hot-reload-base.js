import chokidar from 'chokidar';
import path from 'path';
import BotUtil from '../common/util.js';

/**
 * 热重载基类
 * 提供文件监视和热重载功能
 */
export class HotReloadBase {
  constructor(options = {}) {
    this.loggerName = options.loggerName || 'HotReload';
    this.watcher = null;
  }

  /**
   * 获取文件键名（用于标识文件）
   * @param {string} filePath - 文件路径
   * @returns {string} 文件键名
   */
  getFileKey(filePath) {
    return path.basename(filePath, path.extname(filePath));
  }

  /**
   * 启动文件监视
   * @param {boolean} enable - 是否启用
   * @param {Object} options - 选项
   * @param {Array<string>} options.dirs - 要监视的目录数组
   * @param {Function} options.onAdd - 文件添加回调
   * @param {Function} options.onChange - 文件变更回调
   * @param {Function} options.onUnlink - 文件删除回调
   */
  async watch(enable, options = {}) {
    if (!enable) {
      if (this.watcher) {
        await this.watcher.close();
        this.watcher = null;
      }
      return;
    }

    if (this.watcher) {
      return;
    }

    const { dirs = [], onAdd, onChange, onUnlink } = options;

    if (dirs.length === 0) {
      return;
    }

    try {
      this.watcher = chokidar.watch(dirs, {
        ignored: /(^|[\/\\])\../,
        persistent: true,
        ignoreInitial: true
      });

      if (onAdd) {
        this.watcher.on('add', async (filePath) => {
          try {
            await onAdd(filePath);
          } catch (error) {
            BotUtil.makeLog('error', `文件添加处理失败: ${filePath}`, this.loggerName, error);
          }
        });
      }

      if (onChange) {
        this.watcher.on('change', async (filePath) => {
          try {
            await onChange(filePath);
          } catch (error) {
            BotUtil.makeLog('error', `文件变更处理失败: ${filePath}`, this.loggerName, error);
          }
        });
      }

      if (onUnlink) {
        this.watcher.on('unlink', async (filePath) => {
          try {
            await onUnlink(filePath);
          } catch (error) {
            BotUtil.makeLog('error', `文件删除处理失败: ${filePath}`, this.loggerName, error);
          }
        });
      }

      BotUtil.makeLog('info', `文件监视已启动: ${dirs.join(', ')}`, this.loggerName);
    } catch (error) {
      BotUtil.makeLog('error', '启动文件监视失败', this.loggerName, error);
    }
  }
}

export default HotReloadBase;
