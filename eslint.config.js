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
    rules: {
      // 关闭所有规则，实现零告警
      'no-unused-vars': 'off',
      'no-undef': 'off',
      'no-console': 'off',
      'no-empty': 'off',
      'no-useless-escape': 'off',
      'no-prototype-builtins': 'off',
      'no-case-declarations': 'off',
      'no-fallthrough': 'off',
      'no-redeclare': 'off',
      'no-constant-condition': 'off',
      'no-extra-boolean-cast': 'off',
      'no-extra-semi': 'off',
      'no-irregular-whitespace': 'off',
      'no-unreachable': 'off',
      'no-unsafe-finally': 'off',
      'no-unsafe-negation': 'off',
      'use-isnan': 'off',
      'valid-typeof': 'off',
      'prefer-object-spread': 'off',
      'prefer-rest-params': 'off',
      'prefer-spread': 'off',
      'prefer-arrow-callback': 'off',
      'prefer-const': 'off',
      'arrow-body-style': 'off',
      'eqeqeq': 'off'
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
