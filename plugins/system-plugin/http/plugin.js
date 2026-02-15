/**
 * 插件管理API（数据源：主进程 Bot.PluginsLoader，由 bot.js 在 load() 后挂载）
 * www/xrk 首页用 GET /api/plugins/summary
 */
function getPluginListAndStats(Bot) {
  const PluginsLoader = Bot.PluginsLoader;
  if (!PluginsLoader) {
    Bot.makeLog('warn', 'Bot.PluginsLoader 未挂载，返回空统计', 'Plugin API');
    return { allPlugins: [], list: [], totalPlugins: 0, withRules: 0, withTasks: 0, taskCount: 0, totalLoadTime: 0 };
  }
  const loadStats = PluginsLoader.pluginLoadStats || {};
  const stats = PluginsLoader.getPluginStats?.() ?? {};
  const priority = PluginsLoader.priority || [];
  const extended = PluginsLoader.extended || [];
  const allPlugins = [...priority, ...extended];

  const totalPlugins = (stats.priority ?? loadStats.totalPlugins ?? 0) + (stats.extended ?? loadStats.extendedCount ?? 0);
  const taskCount = stats.task ?? loadStats.taskCount ?? (PluginsLoader.task || []).length;
  const totalLoadTime = loadStats.totalLoadTime ?? stats.totalLoadTime ?? 0;

  const list = [];
  let withRules = 0;
  let withTasks = 0;
  for (const p of allPlugins) {
    try {
      const plugin = new p.class();
      if (plugin.rule && plugin.rule.length) withRules++;
      if (plugin.task) withTasks++;
      list.push({
        key: p.key,
        name: plugin.name || p.key,
        priority: p.priority,
        dsc: plugin.dsc || '暂无描述',
        rule: plugin.rule && plugin.rule.length || 0,
        task: plugin.task ? 1 : 0
      });
    } catch (e) {
      Bot.makeLog('error', `插件初始化失败: ${p.key}`, 'Plugin API', e);
    }
  }
  return { allPlugins, list, totalPlugins, withRules, withTasks, taskCount, totalLoadTime };
}

export default {
  name: 'plugin',
  dsc: '插件管理API',
  priority: 80,

  routes: [
    {
      method: 'GET',
      path: '/api/plugins',
      handler: async (req, res, Bot) => {
        const { list } = getPluginListAndStats(Bot);
        res.json({ success: true, plugins: list });
      }
    },

    {
      method: 'POST',
      path: '/api/plugin/:key/reload',
      handler: async (req, res, Bot) => {
        try {
          const { key } = req.params;
          if (!key) {
            return res.status(400).json({ success: false, message: '缺少插件key参数' });
          }
          const PluginsLoader = Bot.PluginsLoader;
          if (!PluginsLoader) return res.status(503).json({ success: false, message: 'PluginsLoader 未就绪' });
          await PluginsLoader.changePlugin(decodeURIComponent(key));
          res.json({ success: true, message: '插件重载成功' });
        } catch (error) {
          res.status(500).json({ success: false, message: '插件重载失败', error: error.message });
        }
      }
    },

    {
      method: 'GET',
      path: '/api/plugins/tasks',
      handler: async (req, res, Bot) => {
        const taskList = Bot.PluginsLoader?.task ?? [];
        const tasks = taskList.map(t => ({
          name: t.name,
          cron: t.cron,
          nextRun: t.job && t.job.nextInvocation ? t.job.nextInvocation() : null
        }));
        res.json({ success: true, tasks });
      }
    },

    {
      method: 'GET',
      path: '/api/plugins/summary',
      handler: async (req, res, Bot) => {
        try {
          res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
          res.set('Pragma', 'no-cache');
          const { allPlugins, totalPlugins, withRules, withTasks, totalLoadTime } = getPluginListAndStats(Bot);
          res.json({
            success: true,
            summary: {
              totalPlugins,
              withRules,
              withTasks,
              taskCount: withTasks,
              totalLoadTime
            },
            plugins: allPlugins.map(p => ({ key: p.key, name: p.name || p.key, priority: p.priority }))
          });
        } catch (error) {
          res.status(500).json({ success: false, message: '获取插件摘要失败', error: error.message });
        }
      }
    },

    {
      method: 'GET',
      path: '/api/plugins/stats',
      handler: async (req, res, Bot) => {
        try {
          const { totalPlugins, withRules, withTasks, taskCount, totalLoadTime } = getPluginListAndStats(Bot);
          res.json({
            success: true,
            stats: { total: totalPlugins, withRules, withTasks, taskCount, totalLoadTime }
          });
        } catch (error) {
          res.status(500).json({ success: false, message: '获取插件统计失败', error: error.message });
        }
      }
    }
  ]
};
