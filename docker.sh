#!/bin/bash

# XRK-Yunzai Docker 启动脚本
# 用于在 Docker 容器内启动应用

set -e  # 遇到错误立即退出

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 日志函数
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# 设置环境变量
export NODE_ENV=${NODE_ENV:-production}
export DISABLE_CONSOLE=${DISABLE_CONSOLE:-true}
export USE_FILE_LOG=${USE_FILE_LOG:-true}
export DEBUG=${DEBUG:-false}
export NODE_OPTIONS="${NODE_OPTIONS:---no-warnings --no-deprecation --max-old-space-size=1024}"

# Redis 连接配置（从环境变量读取，默认连接本地 Redis）
export REDIS_HOST=${REDIS_HOST:-redis}
export REDIS_PORT=${REDIS_PORT:-6379}
export REDIS_DB=${REDIS_DB:-0}

log_info "环境配置:"
log_info "  NODE_ENV: $NODE_ENV"
log_info "  REDIS_HOST: $REDIS_HOST"
log_info "  REDIS_PORT: $REDIS_PORT"

# 创建必要的目录
log_info "创建必要的目录..."
mkdir -p \
    logs \
    data \
    data/server_bots \
    config \
    config/default_config \
    config/pm2 \
    resources

# 检查 Redis 连接（可选，如果 Redis 不可用会降级运行）
if command -v redis-cli &> /dev/null; then
    log_info "检查 Redis 连接..."
    if redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" ping &> /dev/null; then
        log_info "Redis 连接成功"
    else
        log_warn "Redis 连接失败，应用将以降级模式运行（部分功能可能不可用）"
    fi
else
    log_warn "未找到 redis-cli，跳过 Redis 连接检查"
fi

# 启动应用
log_info "启动应用..."
exec node $NODE_OPTIONS app.js "$@"