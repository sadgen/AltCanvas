FROM node:22-alpine
WORKDIR /app

# Copy package definition
COPY package.json ./

# Copy backend server modules
COPY server/ ./server/
COPY scripts/ ./scripts/

# Copy static assets and frontend UI
COPY styles/ ./styles/
COPY index.html test-reader.html ./

# Copy only the compiled vendor distributions
COPY vendor/reader/build/web/ ./vendor/reader/build/web/
COPY vendor/web-library/build/ ./vendor/web-library/build/

# Create data directory for encrypted sessions and the independent Canvas database
RUN mkdir -p /app/data && chown -R node:node /app

VOLUME ["/app/data"]
EXPOSE 8088

ENV NODE_ENV=production \
    PORT=8088 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data \
    ALTERO_API=http://altero:8000

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8088/auth/session').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "scripts/dev-server.mjs"]
