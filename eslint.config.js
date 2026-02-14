import importPlugin from 'eslint-plugin-import';

const r = 'readonly';

export default [
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        process: r, Buffer: r, __dirname: r, __filename: r, console: r,
        global: r, module: r, require: r, exports: r,
        setTimeout: r, setInterval: r, setImmediate: r, clearTimeout: r, clearInterval: r,
        Promise: r, Map: r, Set: r, WeakMap: r, WeakSet: r, Symbol: r, Proxy: r, Reflect: r,
        fetch: r, URL: r, URLSearchParams: r, AbortSignal: r, AbortController: r,
        Bot: r, redis: r, logger: r, plugin: r, Renderer: r, segment: r
      }
    },
    plugins: { import: importPlugin },
    rules: {
      'import/no-unresolved': 'error',
      'no-undef': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
    }
  },
  {
    ignores: [
      'node_modules/**', 'data/**', 'logs/**', 'temp/**', '*.min.js',
      'dist/**', 'build/**', 'coverage/**', '.git/**', 'www/**',
      'renderers/**', 'lib/modules/**'
    ]
  }
];
