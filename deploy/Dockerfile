FROM node:24-bookworm-slim
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY server/ ./
RUN mkdir -p /data /backups && chown -R node:node /app /data /backups
USER node
ENV HOST=0.0.0.0 PORT=8787 DB_PATH=/data/chat.db BACKUP_DIR=/backups
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node","scripts/healthcheck.mjs"]
CMD ["node","index.mjs"]
