import PluginsLoader from '../plugins/loader.js';

export default {
  name: 'plugin',
  description: '插件管理API',

  routes: [
    {
      method: 'GET',
      path: '/api/plugins',
      handler: async (req, res, Bot) => {
        if (!Bot.checkApiAuthorization(req)) {
          return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        const plugins = [];
        const priorityPlugins = PluginsLoader.priority ? PluginsLoader.priority : [];
        const extendedPlugins = PluginsLoader.extended ? PluginsLoader.extended : [];
        const allPlugins = [...priorityPlugins, ...extendedPlugins];
        
        for (const p of allPlugins) {
          try {
            const plugin = new p.class();
            plugins.push({
              key: p.key,
              name: plugin.name ? plugin.name : p.key,
              priority: p.priority,
              dsc: plugin.dsc ? plugin.dsc : '暂无描述',
              rule: plugin.rule?.length ? plugin.rule.length : 0,
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

        const taskList = PluginsLoader.task ? PluginsLoader.task : [];
        const tasks = taskList.map(t => ({
          name: t.name,
          cron: t.cron,
          nextRun: t.job?.nextInvocation ? t.job.nextInvocation() : null
        }));

        res.json({ success: true, tasks });
      }
    }
  ]
};