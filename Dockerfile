FROM node:24-alpine

ARG TRAEKD_UID=1000
ARG TRAEKD_GID=1000

WORKDIR /app
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev
COPY . .
RUN deluser node && delgroup node \
    && addgroup -S -g "$TRAEKD_GID" traekd && adduser -S -D -H -u "$TRAEKD_UID" -G traekd traekd \
    && mkdir -p /var/lib/traekd && chown -R traekd:traekd /app /var/lib/traekd

USER traekd
ENV NODE_ENV=production \
    SERVER_HOST=0.0.0.0 \
    TRAEKD_DATA_DIR=/var/lib/traekd
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "server/index.js"]
