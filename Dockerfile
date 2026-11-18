FROM node:22-bookworm-slim
WORKDIR /app
# ffmpeg sert à remuxer la vidéo et la piste audio séparée des bandes-annonces Apple TV (sinon : pas de son).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
# better-sqlite3 v13 embarque des binaires précompilés (linux-x64 / linuxmusl inclus) : aucune compilation requise.
# Le npm 10 fourni avec node:22 lance quand même un `node-gyp rebuild` (échec : pas de Python dans l'image slim),
# donc on désactive les scripts d'installation. Le require ci-dessous vérifie que le binaire SQLite se charge.
RUN npm ci --omit=dev --ignore-scripts \
 && node -e "const D=require('better-sqlite3');const db=new D(':memory:');db.prepare('select 1').get();db.close();console.log('better-sqlite3 OK')"
COPY src ./src
COPY scripts ./scripts
ENV NODE_ENV=production DB_PATH=/app/data/stockage.db HLS_CACHE_DIR=/app/data/hls PORT=7000
# Le conteneur tourne sans privilèges : l'utilisateur node possède le volume de données.
RUN mkdir -p /app/data /app/data/hls && chown -R node:node /app/data
VOLUME /app/data
USER node
EXPOSE 7000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.js"]
