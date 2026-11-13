# Netflix Catalogue — addon Stremio

Addon Stremio **métadonnées uniquement** (aucun flux) : catalogue Netflix avec, pour chaque titre,
synopsis, année, classification (16+), genres, casting, **bande-annonce**, **épisodes avec synopsis, durée et images**.

Stack : Node.js · `stremio-addon-sdk` · Express · **SQLite** (`better-sqlite3`) · Docker.

## Sources de données
1. **Page Netflix** (`netflix.com/fr/title/<id>`) : titre, synopsis, casting, classification, épisodes (JSON-LD + `netflix.reactContext`).
2. **TMDB** (clé gratuite) : affiches verticales, fonds, logos, épisodes/stills de secours, trailers YouTube, et **catalogue automatique** des titres Netflix France.
3. **YouTube** (recherche) : filet de sécurité pour la bande-annonce.

> La vidéo de bande-annonce hébergée par Netflix n'est pas lisible dans Stremio : on fournit l'ID YouTube (`trailerStreams`).
> Le scraping de netflix.com va à l'encontre de leurs CGU et peut casser si la page change : à utiliser avec modération (le cache SQL limite les requêtes).

## Installation (VPS)
```bash
git clone https://github.com/Wallacecleaver/Netflix-catalogue-stremio.git && cd Netflix-catalogue-stremio
cp .env.example .env   # renseigne TMDB_API_KEY et ADMIN_TOKEN
docker compose up -d --build
```
Reverse proxy HTTPS obligatoire pour Stremio (exemple Caddy) :
```
netflix.mondomaine.fr {
  reverse_proxy 127.0.0.1:7000
}
```
Puis dans Stremio : *Addons → Install from URL* → `https://netflix.mondomaine.fr/manifest.json`.

## Ajouter un titre depuis sa page Netflix
```bash
docker compose exec netflix-catalogue node scripts/add.js https://www.netflix.com/fr/title/81944880
# ou en local : npm run add -- 81944880
```
Ou via `https://netflix.mondomaine.fr/admin` (protégé par `ADMIN_TOKEN`).

## Catalogue automatique
Avec `TMDB_API_KEY`, l'addon synchronise au démarrage puis toutes les `SYNC_EVERY_HOURS` h les titres Netflix de la région `REGION`.
Les fiches sont complétées (épisodes, casting, trailer) à la première ouverture. Manuel : `npm run sync`.

## Dernières sorties
Deux catalogues dédiés dans Stremio : **Netflix — Dernières sorties (films)** et **Netflix — Dernières sorties (séries)**.
Ils listent les titres sortis sur Netflix dans les `RECENT_DAYS` derniers jours (90 par défaut), du plus récent au plus ancien,
et acceptent le filtre par genre. La synchro récupère `RECENT_PAGES` pages TMDB par type (3 par défaut, 20 titres/page),
au démarrage puis à chaque cycle `SYNC_EVERY_HOURS`.

## Si le scraping Netflix ne remonte pas tout
```bash
npm run inspect -- 81944880
```
Sauvegarde la page dans `data/inspect-81944880.html` et affiche ce que le parseur a extrait (utile pour ajuster `src/netflix.js`).
Sans épisodes Netflix, ceux de TMDB sont utilisés.

## Tests
`npm test` : parseur + SQL + handlers Stremio, sans réseau.

## Structure
`src/netflix.js` scraper · `src/tmdb.js` · `src/youtube.js` · `src/enrich.js` fusion Netflix+TMDB · `src/sync.js` catalogue · `src/addon.js` manifest/handlers · `src/db.js` SQLite.

## Test en local (Windows / PC)
```powershell
git clone https://github.com/Wallacecleaver/Netflix-catalogue-stremio.git
cd Netflix-catalogue-stremio
npm install
copy .env.example .env      # optionnel : TMDB_API_KEY, ADMIN_TOKEN
npm run seed                # fiche de démo "Trouble échange"
npm start
```
Dans Stremio : *Addons → barre de recherche → coller* `http://localhost:7000/manifest.json`.
Test du scraping réel depuis ta connexion : `npm run inspect -- 81944880` puis `npm run add -- 81944880`.

## Si Netflix répond 500 / bloque Node
Enregistre la page depuis ton navigateur (Ctrl+S → « Page web, HTML uniquement », ou Ctrl+U puis copier dans un fichier `page.html`), puis :
```powershell
npm run inspect -- --file page.html
npm run add -- 81944880 --file page.html
```

## Bande-annonce de la page Netflix
La vidéo de la page (≈1 min 40) est enregistrée avec le titre. Ses liens Netflix expirent en quelques heures, donc Stremio reçoit une URL
stable de **ton** addon : `PUBLIC_URL/trailer/<id>/0.mp4`. À chaque lecture, l'addon renouvelle le lien Netflix si besoin et relaie la vidéo
(avec support des `Range`). Réglages dans `.env` : `PUBLIC_URL` (obligatoire sur le VPS, ex. `https://netflix.mondomaine.fr`) et
`TRAILER_PREFER=netflix|youtube` (ordre des bandes-annonces ; l'autre reste en secours).
Test direct : ouvre `http://localhost:7000/trailer/81944880/0.mp4` dans ton navigateur.
