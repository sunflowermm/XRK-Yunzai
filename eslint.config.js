import importPlugin from 'eslint-plugin-import';

export default [
  {
    languageOptions: {
      ecmaVersion: 2022, // 支持 ES2022 语法（包括类字段、可选链、动态 import 等）
      sourceType: 'module',
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: {
          globalReturn: false,
          jsx: false
        }
      },
      globals: {
        // Node.js globals
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        console: 'readonly',
        global: 'readonly',
        module: 'readonly',
        require: 'readonly',
        exports: 'readonly',
        // ES2018+ globals
        Promise: 'readonly',
        Map: 'readonly',
        Set: 'readonly',
        WeakMap: 'readonly',
        WeakSet: 'readonly',
        Symbol: 'readonly',
        Proxy: 'readonly',
        Reflect: 'readonly',
        // Project globals
        Bot: 'readonly',
        redis: 'readonly',
        logger: 'readonly',
        plugin: 'readonly',
        Renderer: 'readonly',
        segment: 'readonly'
      }
    },
    plugins: {
      import: importPlugin
    },
    rules: {
      // 关键规则：用于提前发现这类路径/未定义问题
      'import/no-unresolved': 'error',
      'no-undef': 'error',
      // 其他规则保持宽松，避免一次性出现过多告警
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
    }
  },
  {
    ignores: [
      'node_modules/**',
      'data/**',
      'logs/**',
      'temp/**',
      '*.min.js',
      'dist/**',
      'build/**',
      'coverage/**',
      '.git/**',
      'www/**',
      'renderers/**',
      'lib/modules/**'
    ]
  }
]
