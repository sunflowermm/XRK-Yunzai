FROM node:18-alpine

# 安装pnpm和必要的系统依赖
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    git \
    bash \
    && npm install -g pnpm pm2

# 设置工作目录
WORKDIR /app

# 复制package文件
COPY package*.json ./
COPY pnpm-lock.yaml* ./

# 安装依赖
RUN pnpm install --frozen-lockfile || pnpm install

# 复制项目文件
COPY . .

# 创建必要的目录
RUN mkdir -p logs data data/bots data/backups config config/default_config data/server_bots config/pm2 resources

# 设置环境变量
ENV NODE_ENV=production \
    DISABLE_CONSOLE=true \
    USE_FILE_LOG=true \
    DEBUG=false \
    NODE_OPTIONS="--no-warnings --no-deprecation"

# 暴露端口（根据需要调整）
EXPOSE 3000-3100

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "process.exit(0)" || exit 1

# 启动命令
CMD ["node", "--no-warnings", "--no-deprecation", "app.js"]