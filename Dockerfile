FROM node:24-bookworm-slim

# System Chromium instead of Puppeteer's download (smaller image, gets security updates via apt).
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    CHROME_PATH=/usr/bin/chromium \
    NODE_ENV=production \
    DB_PATH=/app/data/prices.db

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY bin ./bin
COPY src ./src
COPY examples ./examples

RUN useradd -m tracker && mkdir -p /app/data && chown -R tracker /app
USER tracker
VOLUME ["/app/data"]
EXPOSE 8080
ENV HEALTH_PORT=8080
HEALTHCHECK --interval=5m --timeout=5s CMD node -e "fetch('http://localhost:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "node", "bin/price-tracker.js"]
CMD ["start"]
