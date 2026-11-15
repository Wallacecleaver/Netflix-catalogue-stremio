# W stockage bande annonce — addon Stremio

Un addon Stremio qui **stocke et relaie des bandes-annonces**. Aucun film, aucune série, aucun catalogue :
pour chaque titre, il garde la bande-annonce Netflix et Apple TV, et la propose comme source sur n'importe
quelle fiche Stremio dont l'ID IMDb est connu — films, séries, épisodes.

> Le nom affiché est **W stockage bande annonce**. Le dépôt, l'image Docker et l'identifiant d'addon
> (`community.wallacecleaver.netflix-catalogue`) gardent leur ancien nom pour ne pas casser les
> installations existantes.

Stack : Node.js ≥ 20 · `stremio-addon-sdk` · Express · SQLite (`better-sqlite3`) · Docker.

---

## Ce qu'il fait

| | |
|---|---|
| **Stocke** | synopsis, année, classification, genres, casting, épisodes, affiches et bandes-annonces |
| **Relaie** | `/trailer/<id>/<n>.mp4` renouvelle le lien Netflix signé à chaque lecture ; `/apple/<id>/<n>.mp4` convertit le HLS Apple en MP4 (avec le son) |
| **Trouve** | un titre absent de la base est résolu à la volée : TMDB → JustWatch → page Netflix → Apple TV → YouTube |
| **Partage** | une instance peut exposer ses bandes-annonces à une autre (`/api/trailers`) |

## Installation

**Docker (VPS)**

```bash
git clone https://github.com/Wallacecleaver/Netflix-catalogue-stremio.git && cd Netflix-catalogue-stremio
cp .env.example .env      # renseigne ADMIN_TOKEN et TMDB_API_KEY
docker compose up -d --build
```

Le reverse proxy HTTPS est obligatoire pour Stremio :

```
netflix.mondomaine.fr {
  reverse_proxy 127.0.0.1:7000
}
```

Puis dans Stremio : *Addons → Install from URL* → `https://netflix.mondomaine.fr/manifest.json`.

**En local (Windows/macOS/Linux)**

```bash
npm ci
copy .env.example .env    # ou : cp .env.example .env
npm run seed              # une fiche de démo
npm start                 # http://localhost:7000
```

## Comment la base se remplit

Quatre étapes, dans cet ordre. Les trois premières sont dans l'onglet **Stockage** du dashboard
(`/admin`), chacune a son équivalent en ligne de commande.

**1 · Collecter** — lister les titres et récupérer les IDs Netflix.

```bash
npm run harvest                          # tout le catalogue Netflix des pays configurés (JustWatch)
npm run harvest:recent                   # seulement les sorties récentes
npm run sync                             # titres des plateformes TMDB (Netflix, Apple TV+…)
docker compose exec netflix-catalogue node scripts/add.js 81944880   # un titre à la main
```

**2 · Lire les pages** — c'est ce qui donne vraiment les vidéos : le moissonnage ne pose que les
`netflix_id`, et une fiche sans page lue n'a aucune bande-annonce.

```bash
npm run netflix-trailers                 # ≈ 1,2 s par page ; reprise possible, arrêtable
npm run netflix-trailers -- --limit 50   # pour tester
```

**3 · Compléter les identifiants** — sans ID IMDb, un titre n'apparaît sur aucune fiche Stremio.

```bash
npm run netflix-ids                      # nom → ID Netflix (JustWatch) pour les fiches non liées
npm run vf                               # TMDB : ID IMDb, affiche, synopsis, genres, bande-annonce YouTube
```

**4 · Apple TV (optionnel)** — bandes-annonces du catalogue Apple, converties en MP4.

Depuis le dashboard, la même chose en un clic, avec progression et bouton d'arrêt.

## Dashboard

`https://netflix.mondomaine.fr/admin` — mot de passe = `ADMIN_TOKEN`. Six onglets :

| Onglet | Rôle |
|---|---|
| **Stockage** | couverture réelle, état des sources, et les tâches : collecter → enrichir → brancher |
| **Recherche** | trouve un titre par son nom (JustWatch, Apple TV) puis l'ajoute |
| **Ajouter** | ajout direct par URL ou ID : Netflix, Prime Video, Apple TV ; derniers ajouts en bas |
| **Titres** | liste filtrable, avec les sources et la présence d'un ID IMDb |
| **Paramètres** | toutes les variables ci-dessous, filtrables, persistées en base |
| **Journal** | les 2 000 derniers événements, filtrables par niveau et par texte |

Les valeurs enregistrées depuis le dashboard vivent dans SQLite (`./data`) et survivent aux
redéploiements. Priorité : **dashboard > `.env` > valeur par défaut**.

## Configuration

Toutes ces variables sont aussi modifiables dans **Paramètres**. Les valeurs entre parenthèses sont les
défauts.

**Essentiel**

| Variable | Rôle |
|---|---|
| `ADMIN_TOKEN` | mot de passe du dashboard — **obligatoire**, sinon `/admin` répond 503 |
| `TMDB_API_KEY` | clé TMDB v3 ou jeton v4 — active la synchro, les IDs IMDb et les bandes-annonces YouTube |
| `PUBLIC_URL` | adresse publique (`https://…`) servant les relais `/trailer/…` |
| `PORT` (7000) · `DB_PATH` (`./data/netflix.db`) | écoute et base SQLite |

**Catalogues**

| Variable | Rôle |
|---|---|
| `REGION` (FR) · `TMDB_LANG` (fr-FR) · `NETFLIX_COUNTRY` (fr) | région et langues |
| `CATALOG_PROVIDERS` (`8,337`) | plateformes listées par TMDB : `8` Netflix, `337` Apple TV+, `2` Apple TV, `119` Prime ; `all` = tout TMDB |
| `SYNC_PAGES` (5) · `SYNC_EVERY_HOURS` (24) | ampleur et fréquence de la synchro |
| `RECENT_DAYS` (90) · `RECENT_PAGES` (3) | fenêtre des « dernières sorties » |
| `HARVEST_COUNTRIES` (`FR,US,GB,CA`) | pays moissonnés (l'ID Netflix est le même partout, on fait l'union) |
| `RESOLVE_ENABLED` (1) | résolution à la demande à l'ouverture d'une fiche inconnue |

**Bandes-annonces**

| Variable | Rôle |
|---|---|
| `APPLETV_ENABLED` (1) | bandes-annonces Apple TV |
| `HLS_MAX_HEIGHT` (720) · `HLS_MAX_MB` (60) · `HLS_CACHE_DAYS` (7) | conversion HLS → MP4 et cache disque |
| `FFMPEG_PATH` | chemin de `ffmpeg` s'il n'est pas dans le `PATH` — sans lui, les vidéos Apple sont muettes |
| `YOUTUBE_SEARCH` (1) | chercher sur YouTube quand TMDB n'a aucune vidéo |
| `YOUTUBE_AS_SOURCE` (0) | proposer YouTube **en plus** de Netflix/Apple (1080p au lieu du 432p Netflix) |
| `BRAVE_API_KEY` | inutile en pratique : JustWatch suffit, Brave n'est qu'un secours |

**Fédération**

| Variable | Rôle |
|---|---|
| `API_KEY` | clé exigée par `/api/trailers` (vide = API ouverte) |
| `UPSTREAM_URL` · `UPSTREAM_API_KEY` | instance amont dont on récupère les bandes-annonces |

## D'où viennent les vidéos, et en quelle qualité

| Source | Mécanisme | Qualité |
|---|---|---|
| **Netflix** | lien signé en clair, renouvelé à chaque lecture | **768×432** (≈ 1,26 Mb/s) — mesuré, aucune variante dans la page |
| **Apple TV** | HLS non chiffré, segments recollés en MP4 par ffmpeg | jusqu'à `HLS_MAX_HEIGHT` (720p par défaut) |
| **YouTube** | clé `ytId` de TMDB, ou recherche filtrée strictement | selon la vidéo, souvent 1080p |

La bande-annonce YouTube sert de **repli** (bouton « Bande-annonce » et source quand rien d'autre
n'existe) ; `YOUTUBE_AS_SOURCE=1` l'ajoute à côté de Netflix pour avoir le choix.

**Prime Video** ne peut pas être relayé : sa page n'expose aucun flux, seulement une enveloppe chiffrée
(JWE). L'addon stocke donc les métadonnées, et la bande-annonce vient de TMDB/YouTube.

## API

**Fédération** (`x-api-key: …` ou `?key=` si `API_KEY` est défini)

```bash
curl "https://netflix.mondomaine.fr/api/trailers?imdb=tt7777777"
curl "https://netflix.mondomaine.fr/api/trailers?tmdb=777&type=movie"
curl "https://netflix.mondomaine.fr/api/trailers?netflix=77777777"
curl "https://netflix.mondomaine.fr/api/status"
```

Réponse : `{ found, pending, title: {…}, trailers: [{ title, url, runtime, source }] }`.
Un titre inconnu déclenche la résolution à la demande (réponse au plus tard après 5 s, `pending: true`
si elle continue en arrière-plan).

**Supervision** — `GET /health` renvoie la version, l'uptime, les compteurs par source, le travail
restant et l'état des sources. `GET /manifest.json` est mis en cache 5 min.

## Tests

```bash
npm test              # parseurs, fusion, SQL, handlers Stremio — sans réseau
npm run test:search   # recherche des IDs (JustWatch, secours web) + API iTunes
npm run test:youtube  # extraction YouTube, notation, refus du bruit
```

## Limites et bon usage

- **Scraping** : `netflix.com` et `tv.apple.com` sont lus à contre-courant de leurs CGU. À usage personnel
  et modéré ; le cache SQLite limite fortement les requêtes.
- **Fragilité** : les parseurs dépendent du HTML et du JSON embarqués. En cas de changement, `npm run
  inspect`, `npm run inspect-appletv` et `npm run inspect-prime -- <url|id>` affichent ce qui a été lu.
- **Quotas** : JustWatch pour les IDs, TMDB pour les métadonnées, YouTube pour le repli (1 recherche à la
  fois, espacées d'1,2 s).
- **Couverture** : beaucoup de titres n'ont aucune bande-annonce exploitable — c'est normal, l'addon ne
  fabrique rien.

## Dépannage

| Symptôme | Piste |
|---|---|
| `/admin` répond 503 | `ADMIN_TOKEN` absent du `.env` |
| Stremio refuse d'installer l'addon | HTTPS obligatoire pour un addon distant |
| Les bandes-annonces ne se lisent pas | `PUBLIC_URL` doit être l'adresse réellement accessible par Stremio |
| Vidéos Apple muettes | `ffmpeg` absent : installe-le ou renseigne `FFMPEG_PATH` |
| Recherche Apple TV en erreur 400 | les paramètres du client web Apple ont changé : recopie `v`, `utscf` et `utsk` depuis tv.apple.com (F12 → Réseau) dans `APPLETV_API_VERSION`, `APPLETV_UTSCF`, `APPLETV_UTSK` |
| Vérifier un relais à la main | ouvre `PUBLIC_URL/trailer/<id_netflix>/0.mp4` dans un navigateur |
| Recherche : « réseau injoignable » | JustWatch est tombé ; DuckDuckGo est bloqué (ECONNRESET), Brave nécessite une clé |
| Un titre n'est jamais trouvé | pas sur Netflix dans `REGION`, ou sorti trop récemment pour être indexé |
| Aucune source sur une fiche | le titre n'a ni bande-annonce Netflix/Apple ni clé YouTube : lance `npm run netflix-trailers` puis `npm run vf` |

## Structure

```
src/addon.js            manifest, handlers meta et stream
src/app.js              routes Express : dashboard, relais, API, /health
src/netflix.js          scraper de la page Netflix
src/primevideo.js       parseur de la page Prime Video (métadonnées)
src/appletv.js          recherche Apple TV + HLS → MP4 (src/hls.js)
src/youtube.js          recherche YouTube (dernier recours)
src/justwatch.js        nom → ID Netflix, et catalogue paginé
src/tmdb.js             métadonnées, IDs IMDb, vidéos
src/enrich.js           fusion Netflix + TMDB
src/link.js             liage des IDs et lecture des pages
src/netflix-trailers.js tâche « remplir les bandes-annonces Netflix »
src/sync.js · src/harvest.js   catalogues TMDB et JustWatch
src/resolve.js          résolution à la demande d'une fiche inconnue
src/federation.js       API/partage entre instances
src/db.js               SQLite, schéma et requêtes
src/admin.html          dashboard (une page, sans build)
scripts/                CLI : add, sync, harvest, netflix-ids, netflix-trailers, vf, inspect…
```

## Licence et mentions

Aucune licence déclarée : tous droits réservés. Ce produit utilise l'API TMDB mais n'est ni approuvé ni
certifié par TMDB.
