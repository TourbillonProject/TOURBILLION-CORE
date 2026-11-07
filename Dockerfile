# TOURBILLION CORE — server + PWA in one image.
# Build:  docker build -t tourbillion-core .
# Run:    docker run -p 8787:8787 -v tc-data:/data --env-file .env tourbillion-core

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
COPY bridge/package.json bridge/
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY shared shared
COPY server server
COPY web web
RUN npm run build -w web && npm run build -w server

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    TC_DATA_DIR=/data \
    TC_PORT=8787 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
COPY bridge/package.json bridge/
# Runtime dependencies only, plus Chromium (+ system libraries) for the live remote browser.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && npm ci --omit=dev --no-audit --no-fund -w server \
 && npx playwright-core install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm \
 && mkdir -p /data && chown node:node /data
COPY --from=build /app/shared shared
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/server.js"]
