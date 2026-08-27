FROM node:22-alpine
WORKDIR /app

# Copy application files
COPY package.json ./
COPY server/ ./server/
COPY scripts/ ./scripts/
COPY vendor/ ./vendor/
COPY styles/ ./styles/
COPY index.html ./

# Create data directory for session persistence
RUN mkdir -p /app/data

VOLUME ["/app/data"]
EXPOSE 8088

ENV NODE_ENV=production \
    PORT=8088 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data \
    ALTERO_API=http://altero:8000

CMD ["node", "scripts/dev-server.mjs"]
