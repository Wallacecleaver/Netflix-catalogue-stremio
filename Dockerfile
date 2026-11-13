FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
# better-sqlite3 v13 embarque des binaires précompilés (linux-x64 / linuxmusl inclus) : aucune compilation requise.
# Le npm 10 fourni avec node:22 lance quand même un `node-gyp rebuild` (échec : pas de Python dans l'image slim),
# donc on désactive les scripts d'installation. Le require ci-dessous vérifie que le binaire SQLite se charge.
RUN npm ci --omit=dev --ignore-scripts \
 && node -e "const D=require('better-sqlite3');const db=new D(':memory:');db.prepare('select 1').get();db.close();console.log('better-sqlite3 OK')"
COPY src ./src
COPY scripts ./scripts
ENV NODE_ENV=production DB_PATH=/app/data/netflix.db PORT=7000
VOLUME /app/data
EXPOSE 7000
CMD ["node", "src/index.js"]
