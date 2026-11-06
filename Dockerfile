FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
ENV NODE_ENV=production DB_PATH=/app/data/netflix.db PORT=7000
VOLUME /app/data
EXPOSE 7000
CMD ["node", "src/index.js"]
