/**
 * 测试环境引导（轻量）
 * 设置 XRK_TEST，避免部分路径依赖完整 Bot 启动。
 */
export function bootstrapTestEnv() {
  process.env.XRK_TEST = '1';
}
