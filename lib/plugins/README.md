# lib/plugins

| 文件 | 职责 |
|------|------|
| `plugin.js` | 插件基类 |
| `loader.js` | 插件扫描与热重载 |
| `runtime.js` | 米游社 runtime（`e.runtime.getMysApi` 等） |
| `handler.js` | 插件 handler 注册 |
| **`config.js`** | **TRSS 兼容 `makeConfig()`** → `config/<name>.yaml` |

## 第三方插件配置

历史插件（如 zmd-plugin）使用：

```javascript
import makeConfig from '../../../lib/plugins/config.js';
const { config, configSave } = await makeConfig('my-plugin', { foo: 1 });
```

新插件请用 CommonConfig（`plugins/<名>/commonconfig/`）。**`config.js` 为兼容层，禁止删除。**
