/**
 * FrontendLauncher（与 XRK-AGT 对齐）
 */
import path from 'path';
import { spawn } from 'child_process';
import BotUtil from '../util.js';

const pluginsRoot = path.join(process.cwd(), 'plugins');

/**
 * @type {Map<string, { config: object, process?: import('child_process').ChildProcess, status: string, restarts: number, startedAt?: number }>}
 */
const apps = new Map();

let initialized = false;
let initializing = null;

/**
 * 获取主服务端口（用于透传给前端）
 * @returns {number}
 */
function getMainPort() {
  try {
    const cfg = global.cfg;
    const port = cfg?.bot?.server?.port ?? process.env.XRK_SERVER_PORT;
    if (Number.isFinite(Number(port))) return Number(port);
  } catch {}
  return 8086;
}

/**
 * 获取主服务 URL
 * @returns {string}
 */
function getMainOrigin() {
  try {
    const cfg = global.cfg;
    const url = cfg?.server?.server?.url;
    if (url && typeof url === 'string' && /^https?:\/\//i.test(url)) return url.replace(/\/$/, '');
  } catch {}
  const port = getMainPort();
  return `http://127.0.0.1:${port}`;
}

/**
 * 发现所有 sign.json 配置
 * @private
 * @returns {Promise<Array<object>>}
 */
async function discoverConfigs() {
  const pattern = path.posix.join('plugins', '*', 'www', '**', 'sign.json');
  const files = await BotUtil.glob(pattern, {
    cwd: process.cwd(),
    absolute: true,
    ignore: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/out/**'
    ]
  });

  if (!files || files.length === 0) return [];

  const configs = [];

  for (const file of files) {
    try {
      const raw = await BotUtil.readFile(file, 'utf8');
      const json = JSON.parse(raw);

      if (json && json.enabled === false) {
        BotUtil.makeLog('debug', `跳过禁用的前端 sign.json: ${file}`, 'Frontend');
        continue;
      }

      const dir = path.dirname(file);
      const relFromPlugins = path.relative(pluginsRoot, dir).replace(/\\/g, '/');
      const pluginName = relFromPlugins.split('/')[0] || '';
      const id = String(json.id || path.basename(dir));

      const port = Number(json.port);
      const command = json.command && String(json.command).trim();

      if (!command || !Number.isFinite(port) || port <= 0) {
        BotUtil.makeLog('warn', `sign.json 缺少必要字段(command/port): ${file}`, 'Frontend');
        continue;
      }

      const args = Array.isArray(json.args) ? json.args.map(a => String(a)) : [];
      const cwd = json.cwd ? path.resolve(process.cwd(), json.cwd) : dir;

      const publicPath =
        (json.publicPath && String(json.publicPath).trim()) ||
        (pluginName ? `/plugins/${pluginName}/${id}` : `/${id}`);

      const proxyCfg = json.proxy && typeof json.proxy === 'object' ? json.proxy : {};
      const mountPath =
        proxyCfg.mount && String(proxyCfg.mount).trim() ? String(proxyCfg.mount).trim() : `/${id}`;

      const env = json.env && typeof json.env === 'object' ? json.env : {};
      const autoRestart = json.autoRestart !== false;

      configs.push({
        id,
        name: json.name || id,
        description: json.description || '',
        pluginName,
        signFile: file,
        cwd,
        command,
        args,
        port,
        publicPath,
        mountPath,
        env,
        autoRestart
      });
    } catch (err) {
      BotUtil.makeLog('warn', `解析 sign.json 失败: ${file} - ${err.message}`, 'Frontend');
    }
  }

  return configs;
}

/**
 * 启动单个前端项目
 * @private
 * @param {object} config
 */
function startApp(config) {
  if (apps.has(config.id)) return;

  const mainOrigin = getMainOrigin();

  const childEnv = {
    ...process.env,
    ...config.env,
    PORT: String(config.port),
    VITE_XRK_MAIN_ORIGIN: mainOrigin,
    VITE_XRK_PUBLIC_PATH: config.mountPath || config.publicPath || '/',
    VITE_XRK_CORE_NAME: config.pluginName || '',
    VITE_XRK_APP_ID: config.id
  };

  const cmd = config.command;
  const args = config.args || [];
  const useShell =
    process.platform === 'win32' && !/[\\/]/.test(cmd);

  const child = spawn(cmd, args, {
    cwd: config.cwd,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: useShell
  });

  const appInfo = {
    config,
    process: child,
    status: 'starting',
    restarts: 0,
    startedAt: Date.now()
  };

  apps.set(config.id, appInfo);

  const baseInfo = `${config.id} (${cmd} ${args.join(' ')}) @ ${config.cwd}`;
  const targetUrl = `http://127.0.0.1:${config.port}`;

  BotUtil.makeLog(
    'info',
    `启动前端项目: ${baseInfo} -> ${targetUrl} ${config.publicPath}`,
    'Frontend'
  );

  const handleOutput = (data, stream) => {
    const text = data?.toString?.() || '';
    if (!text) return;
    const trimmed = text.length > 400 ? `${text.slice(0, 400)}...` : text;
    BotUtil.makeLog('debug', `[${config.id}] ${stream}: ${trimmed}`, 'Frontend');
  };

  if (child.stdout) child.stdout.on('data', data => handleOutput(data, 'stdout'));
  if (child.stderr) child.stderr.on('data', data => handleOutput(data, 'stderr'));

  child.on('error', err => {
    appInfo.status = 'error';
    BotUtil.makeLog('error', `前端项目进程错误: ${config.id} - ${err.message}`, 'Frontend');
  });

  child.on('exit', (code, signal) => {
    appInfo.status = 'stopped';
    const reason = code !== null ? `退出码=${code}` : `信号=${signal || 'unknown'}`;
    BotUtil.makeLog(
      code === 0 ? 'info' : 'warn',
      `前端项目已退出: ${config.id} (${reason})`,
      'Frontend'
    );

    if (!config.autoRestart) return;
    if (appInfo.restarts >= 3) {
      BotUtil.makeLog('warn', `前端项目重启次数已达上限，停止重启: ${config.id}`, 'Frontend');
      return;
    }

    appInfo.restarts += 1;
    const delay = 1000 * appInfo.restarts;
    BotUtil.makeLog('info', `准备重启前端项目(${appInfo.restarts}): ${config.id}, ${delay}ms 后`, 'Frontend');
    setTimeout(() => {
      apps.delete(config.id);
      startApp(config);
    }, delay);
  });
}

/**
 * 内部初始化
 * @private
 */
async function doInit() {
  const startTime = Date.now();
  const configs = await discoverConfigs();

  if (configs.length === 0) {
    BotUtil.makeLog('info', '未发现启用的 sign.json 前端项目，跳过启动', 'Frontend');
    return apps;
  }

  BotUtil.makeLog('info', `发现前端项目 ${configs.length} 个，开始启动...`, 'Frontend');
  for (const appConfig of configs) startApp(appConfig);

  const used = BotUtil.getTimeDiff ? BotUtil.getTimeDiff(startTime) : `${Date.now() - startTime}ms`;
  BotUtil.makeLog('info', `前端项目启动完成: ${apps.size} 个, 耗时 ${used}`, 'Frontend');
  return apps;
}

/**
 * 初始化并启动所有前端项目（幂等）
 * @returns {Promise<Map<string, object>>}
 */
export async function init() {
  if (initialized) return apps;
  if (initializing) return initializing;

  initializing = doInit()
    .catch(err => {
      BotUtil.makeLog('error', `前端项目初始化失败: ${err.message}`, 'Frontend');
      return apps;
    })
    .finally(() => {
      initialized = true;
      initializing = null;
    });

  return initializing;
}

/**
 * 获取已发现的前端项目（不会重复扫描）
 * @returns {Promise<Map<string, object>>}
 */
export async function getApps() {
  await init();
  return apps;
}

export default { init, getApps, apps };
