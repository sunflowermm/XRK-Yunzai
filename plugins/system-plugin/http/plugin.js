import PluginsLoader from '../../../lib/plugins/loader.js';

/**
 * 插件管理API
 * 提供插件列表查询、重载、任务管理等功能
 */
export default {
  name: 'plugin',
  dsc: '插件管理API',
  priority: 80,

  routes: [
    {
      method: 'GET',
      path: '/api/plugins',
      handler: async (req, res, Bot) => {
        if (!Bot.checkApiAuthorization(req)) {
          return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        const plugins = [];
        const priorityPlugins = PluginsLoader.priority || [];
        const extendedPlugins = PluginsLoader.extended || [];
        const allPlugins = [...priorityPlugins, ...extendedPlugins];
        
        for (const p of allPlugins) {
          try {
            const plugin = new p.class();
            plugins.push({
              key: p.key,
              name: plugin.name || p.key,
              priority: p.priority,
              dsc: plugin.dsc || '暂无描述',
              rule: plugin.rule && plugin.rule.length || 0,
              task: plugin.task ? 1 : 0
            });
          } catch (error) {
            logger.error(`[Plugin API] 初始化插件失败: ${p.key}`, error);
          }
        }

        res.json({ success: true, plugins });
      }
    },

    {
      method: 'POST',
      path: '/api/plugin/:key/reload',
      handler: async (req, res, Bot) => {
        if (!Bot.checkApiAuthorization(req)) {
          return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        try {
          const { key } = req.params;
          if (!key) {
            return res.status(400).json({ 
              success: false, 
              message: '缺少插件key参数' 
            });
          }

          await PluginsLoader.changePlugin(decodeURIComponent(key));
          
          res.json({ success: true, message: '插件重载成功' });
        } catch (error) {
          res.status(500).json({ 
            success: false, 
            message: '插件重载失败',
            error: error.message 
          });
        }
      }
    },

    {
      method: 'GET',
      path: '/api/plugins/tasks',
      handler: async (req, res, Bot) => {
        if (!Bot.checkApiAuthorization(req)) {
          return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        const taskList = PluginsLoader.task || [];
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
        if (!Bot.checkApiAuthorization(req)) {
          return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        try {
          const priorityPlugins = PluginsLoader.priority || [];
          const extendedPlugins = PluginsLoader.extended || [];
          const allPlugins = [...priorityPlugins, ...extendedPlugins];
          
          // 从插件加载统计中获取加载时间
          const loadStats = PluginsLoader.pluginLoadStats || {};
          const totalLoadTime = loadStats.totalLoadTime || 0;
          
          let totalPlugins = 0;
          let withRules = 0;
          let withTasks = 0;

          for (const p of allPlugins) {
            try {
              const plugin = new p.class();
              totalPlugins++;
              if (plugin.rule && plugin.rule.length) withRules++;
              if (plugin.task) withTasks++;
            } catch (error) {
              // 忽略初始化失败的插件
            }
          }

          res.json({
            success: true,
            summary: {
              totalPlugins,
              withRules,
              withTasks,
              taskCount: withTasks,
              totalLoadTime: totalLoadTime
            },
            plugins: allPlugins.map(p => ({
              key: p.key,
              name: p.name || p.key,
              priority: p.priority
            }))
          });
        } catch (error) {
          res.status(500).json({
            success: false,
            message: '获取插件摘要失败',
            error: error.message
          });
        }
      }
    },

    {
      method: 'GET',
      path: '/api/plugins/stats',
      handler: async (req, res, Bot) => {
        if (!Bot.checkApiAuthorization(req)) {
          return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        try {
          const priorityPlugins = PluginsLoader.priority || [];
          const extendedPlugins = PluginsLoader.extended || [];
          const allPlugins = [...priorityPlugins, ...extendedPlugins];
          const loadStats = PluginsLoader.pluginLoadStats || {};
          let withRules = 0;
          let withTasks = 0;

          for (const p of allPlugins) {
            try {
              const plugin = new p.class();
              if (plugin.rule && plugin.rule.length) withRules++;
              if (plugin.task) withTasks++;
            } catch (_) {}
          }

          res.json({
            success: true,
            stats: {
              total: allPlugins.length,
              withRules,
              withTasks,
              taskCount: (PluginsLoader.task || []).length,
              totalLoadTime: loadStats.totalLoadTime || 0
            }
          });
        } catch (error) {
          res.status(500).json({
            success: false,
            message: '获取插件统计失败',
            error: error.message
          });
        }
      }
    }
  ]
};