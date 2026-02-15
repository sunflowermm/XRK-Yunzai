FROM node:18-alpine

# 安装系统依赖 + Chromium + Playwright依赖 + 基本字体
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    git \
    bash \
    chromium \
    chromium-chromedriver \
    nss \
    freetype \
    harfbuzz \
    ttf-freefont \
    ttf-dejavu \
    font-noto \
    font-noto-cjk \
    # Playwright 依赖
    libc6-compat \
    libstdc++ \
    libgcc \
    libx11 \
    libxcomposite \
    libxdamage \
    libxext \
    libxfixes \
    libxrandr \
    libxrender \
    libxss \
    libxtst \
    ca-certificates \
    fonts-liberation \
    # 其他工具
    curl \
    wget \
  && npm install -g pnpm@latest pm2@latest

WORKDIR /app

# 仅复制包管理文件以利用缓存
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./

# 禁止 Puppeteer 在安装时下载浏览器；指定系统 Chromium 路径
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_BROWSERS_PATH=/usr/bin

# 安装依赖（若锁文件不一致则回退普通安装）
RUN pnpm install --frozen-lockfile --prod || pnpm install --prod

# 复制项目源码
COPY . .

# 预创建常用目录
RUN mkdir -p \
    logs \
    data \
    data/server_bots \
    config \
    config/default_config \
    config/pm2 \
    resources \
    renderers/playwright \
    renderers/puppeteer

# 运行时环境
ENV NODE_ENV=production \
    DISABLE_CONSOLE=true \
    USE_FILE_LOG=true \
    DEBUG=false \
    NODE_OPTIONS="--no-warnings --no-deprecation --max-old-space-size=1024" \
    # Redis 连接环境变量（可通过 docker-compose 覆盖）
    REDIS_HOST=redis \
    REDIS_PORT=6379

# 暴露端口段（支持多端口服务器）
EXPOSE 3000-3100

# 健康检查（检查应用是否正常运行）
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1) }).on('error', () => process.exit(1))" || exit 1

# 启动命令（使用 app.js 进行依赖检查和初始化）
CMD ["node", "--no-warnings", "--no-deprecation", "app.js"]