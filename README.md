# Stockage DB — Serveur API & Relais MP4

Serveur backend qui **stocke, convertit et expose par API des bandes-annonces MP4** (Netflix, Apple TV+, liens directs, instance amont).
Il ne contient aucun manifest Stremio : tout passe par son **API REST (`/api/v1/*`)**, son **relais vidéo MP4/HLS** et son **Dashboard Admin (`/admin`)** pour alimenter `vf-trailer-wallace` ou tout autre client externe.

> Les anciennes bases `./data/netflix.db` sont automatiquement migrées vers `./data/stockage.db` au démarrage.

Stack : Node.js ≥ 20 · Express · SQLite (`better-sqlite3`) · `ffmpeg` · Docker.

---

## Ce qu'il fait

| | |
|---|---|
| **Stocke** | synopsis, année, classification, genres, casting, épisodes, affiches et bandes-annonces par saison |
| **Relaie** | `/trailer/<id>/<n>.mp4` renouvelle le lien Netflix signé à chaque lecture ; `/apple/<id>/<n>.mp4` et `/media/<id>/<n>.mp4` convertissent le HLS en MP4 (avec le son) |
| **Trouve** | un titre absent de la base est résolu à la volée : TMDB → JustWatch → page Netflix → Apple TV+ → YouTube |
| **Expose** | API REST complète (`/api/v1/trailers`, `/api/v1/trailers/batch`, `/api/v1/search`, `/api/v1/title/:id`, `/api/v1/trailers/submit`, `/api/v1/openapi.json`) avec clés scopées et quotas personnalisables |

## Installation

**Docker (VPS)**

```bash
git clone https://github.com/Wallacecleaver/stockage-db.git && cd stockage-db
cp .env.example .env      # renseigne ADMIN_TOKEN, PUBLIC_URL et TMDB_API_KEY
docker compose up -d --build
```

Derrière un reverse proxy HTTPS (Caddy) :

```
stockage.mondomaine.fr {
  reverse_proxy 127.0.0.1:7000
}
```

Puis ouvre `https://stockage.mondomaine.fr/admin` et génère ta clé API dans l'onglet **API & Fédération**.

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
docker compose exec stockage-db node scripts/add.js 81944880   # un titre à la main
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

`https://stockage.mondomaine.fr/admin` — mot de passe = `ADMIN_TOKEN`. Sept onglets :

| Onglet | Rôle |
|---|---|
| **Stockage** | couverture réelle, état des sources, et les tâches : collecter → enrichir → brancher |
| **Recherche** | trouve un titre par son nom (JustWatch, Apple TV) puis l'ajoute |
| **Ajouter** | ajout direct par URL ou ID : Netflix, Prime Video, Apple TV, et **n'importe quelle vidéo par son URL** ; derniers ajouts en bas |
| **Titres** | liste filtrable, avec les sources et la présence d'un ID IMDb |
| **API** | gestion des clés API de fédération (création, libellé, dernière utilisation, révocation) |
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
| `PORT` (7000) · `DB_PATH` (`./data/stockage.db`) | écoute et base SQLite |

**Catalogues**

| Variable | Rôle |
|---|---|
| `REGION` (FR) · `TMDB_LANG` (fr-FR) · `NETFLIX_COUNTRY` (fr) | région et langues |
| `CATALOG_PROVIDERS` (`8,337`) | plateformes listées par TMDB : `8` Netflix, `337` Apple TV+, `2` Apple TV, `119` Prime ; `all` = tout TMDB |
| `SYNC_PAGES` (5) · `SYNC_EVERY_HOURS` (24) | ampleur et fréquence de la synchro |
| `NETFLIX_REFRESH_HOURS` (4) | relecture automatique d'une page Netflix ouverte (nouveau teaser / nouvelle saison) |
| `RECENT_DAYS` (90) · `RECENT_PAGES` (3) | fenêtre des « dernières sorties » |
| `HARVEST_COUNTRIES` (`FR,US,GB,CA`) | pays moissonnés (l'ID Netflix est le même partout, on fait l'union) |
| `RESOLVE_ENABLED` (1) | résolution à la demande à l'ouverture d'une fiche inconnue |

**Bandes-annonces**

| Variable | Rôle |
|---|---|
| `APPLETV_ENABLED` (1) | bandes-annonces Apple TV |
| `HLS_MAX_HEIGHT` (720) · `HLS_MAX_MB` (60) · `HLS_CACHE_DAYS` (7) | conversion HLS → MP4 et cache disque |
| `HLS_MAX_DISK_MB` (2048) · `HLS_MAX_CONCURRENT` (2) | plafond du cache disque et conversions ffmpeg simultanées |
| `FFMPEG_PATH` | chemin de `ffmpeg` s'il n'est pas dans le `PATH` — sans lui, les vidéos Apple sont muettes |
| `YOUTUBE_SEARCH` (1) | chercher sur YouTube quand TMDB n'a aucune vidéo |
| `YOUTUBE_AS_SOURCE` (0) | proposer YouTube **en plus** de Netflix/Apple (1080p au lieu du 432p Netflix) |
| `BRAVE_API_KEY` | inutile en pratique : JustWatch suffit, Brave n'est qu'un secours |

**Fédération**

| Variable | Rôle |
|---|---|
| `API_KEY` | clé historique exigée par `/api/trailers` - préfère les clés de l'onglet API (sans clé, l'API est fermée ; `ALLOW_OPEN_API=1` l'ouvre sans clé) |
| `ALLOW_OPEN_API` | `1` = ouvrir `/api/trailers` sans clé (déconseillé) |
| `UPSTREAM_URL` · `UPSTREAM_API_KEY` | instance amont dont on récupère les bandes-annonces |
| `TRUST_PROXY_HOPS` (`1` en Docker) | nombre de reverse proxies de confiance (IP réelle, limiteurs, anti-brute-force) |
| `ALLOW_PRIVATE_URLS` | `1` = autoriser les URL internes dans le relais/fédération (amont Docker uniquement) |

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

### Ajouter une vidéo d'une autre plateforme

Plutôt qu'un scraper par site, l'onglet **Ajouter** accepte n'importe quelle **URL de vidéo publique** (MP4 ou
HLS `.m3u8`) pour un titre déjà en base :

```bash
curl -X POST https://stockage.mondomaine.fr/admin/add/trailer \
  -H "x-admin-token: $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"id":"81944880","url":"https://exemple/bande-annonce.mp4","title":"Bande-annonce VF"}'
```

Le fichier est relayé par `/media/<id>/<n>.mp4` ; un HLS est converti en MP4 comme pour Apple TV, avec le
même cache disque. C'est ce qui permet de couvrir Arte, Dailymotion, un MP4 de distributeur… sans écrire de
code par plateforme. **Aucun DRM** : un flux protégé (Disney+, Max, Prime) échouera — l'addon ne contourne
rien.

## API

**Fédération** — fermée par défaut : tant qu'aucune clé n'existe, `/api/trailers` et `/api/status` répondent
`403`. Les clés se gèrent dans l'onglet **API** du dashboard : jusqu'à 5 clés avec un libellé, date de création
et de dernière utilisation, révocation individuelle. Une clé (`sdb_…`) n'est affichée qu'une fois à la création
(seule son empreinte SHA-256 est stockée) et s'envoie en `Authorization: Bearer <clé>`, `x-api-key` ou `?key=`.
L'ancienne variable `API_KEY` continue de fonctionner. `ALLOW_OPEN_API=1` rouvre volontairement l'API sans clé
(déconseillé).

```bash
curl -H "Authorization: Bearer VOTRE_CLE" "https://stockage.mondomaine.fr/api/trailers?imdb=tt7777777"
curl -H "Authorization: Bearer VOTRE_CLE" "https://stockage.mondomaine.fr/api/trailers?tmdb=777&type=movie"
curl -H "Authorization: Bearer VOTRE_CLE" "https://stockage.mondomaine.fr/api/trailers?netflix=77777777"
curl -H "Authorization: Bearer VOTRE_CLE" "https://stockage.mondomaine.fr/api/status"
```

Réponse : `{ found, pending, title: {…}, trailers: [{ title, url, runtime, source }] }`.
Un titre inconnu déclenche la résolution à la demande (réponse au plus tard après 5 s, `pending: true`
si elle continue en arrière-plan).

La liste `trailers` contient **toutes les sources relayables** de la fiche, dans cet ordre : Netflix
(`/trailer/…`), instance amont, **Apple TV** (`/apple/…`, HLS converti en MP4) et liens ajoutés à la main
(`/media/…`). C'est ce qui permet à une instance cliente (par exemple `vf-trailer-wallace`) de trouver une
bande-annonce même pour une série qui n'existe que sur Apple TV.

Ajoute `&debug=1` pour savoir pourquoi une fiche ne donne rien : la réponse contient alors la fiche trouvée
(`id`, `imdb_id`, `tmdb_id`, `netflix_id`), le nombre de bandes-annonces par source et l'état de la
résolution. Chaque appel est aussi journalisé (source `federation`).

En ligne de commande, depuis le conteneur (`docker` n'y existe pas) :

```bash
npm run api-check -- tt26598805              # la fiche est-elle en base ? que contient-elle ?
npm run api-check -- 81763154 --type movie   # par ID Netflix
npm run api-check -- tt26598805 --url https://stockage.mondomaine.fr --key <clé>
```

Il affiche la fiche, ses identifiants, les bandes-annonces par source et une conclusion :
fiche absente, recherche en cours, ou fiche présente sans bande-annonce.

**Supervision** — `GET /health` renvoie la version, l'uptime et le total de titres. `GET /api/v1/status` (avec clé API) renvoie l'état détaillé des sources et capacités.

## Tests

```bash
npm test              # parseurs, fusion, SQL, anti-SSRF, API v1 et dashboard — sans réseau externe
npm run test:search   # recherche des IDs (JustWatch, secours web) + API iTunes
npm run test:youtube  # extraction YouTube, notation, refus du bruit
```

L'image Docker embarque `test/` : ces commandes fonctionnent aussi dans le conteneur.

## Limites et bon usage

- **Scraping** : `netflix.com` et `tv.apple.com` sont lus à contre-courant de leurs CGU. À usage personnel
  et modéré ; le cache SQLite limite fortement les requêtes.
- **Fragilité** : les parseurs dépendent du HTML et du JSON embarqués. En cas de changement, `npm run
  inspect`, `npm run inspect-appletv` et `npm run inspect-prime -- <url|id>` affichent ce qui a été lu.
- **Quotas** : JustWatch pour les IDs, TMDB pour les métadonnées, YouTube pour le repli (1 recherche à la
  fois, espacées d'1,2 s).
- **Couverture** : beaucoup de titres n'ont aucune bande-annonce exploitable — c'est normal, le serveur ne
  fabrique rien.

## Dépannage

| Symptôme | Piste |
|---|---|
| `/admin` répond 503 | `ADMIN_TOKEN` absent du `.env` |
| `/api/v1/trailers` répond 403 ou 401 | Crée une clé API dans `/admin` → onglet **API & Fédération** |
| Les bandes-annonces ne se lisent pas | `PUBLIC_URL` doit être l'adresse publique réellement accessible par les clients |
| Vidéos Apple muettes | `ffmpeg` absent : installe-le ou renseigne `FFMPEG_PATH` |
| Recherche Apple TV en erreur 400 | les paramètres du client web Apple ont changé : recopie `v`, `utscf` et `utsk` depuis tv.apple.com (F12 → Réseau) dans `APPLETV_API_VERSION`, `APPLETV_UTSCF`, `APPLETV_UTSK` |
| Vérifier un relais à la main | ouvre `PUBLIC_URL/trailer/<id_netflix>/0.mp4` dans un navigateur |
| Recherche : « réseau injoignable » | JustWatch est tombé ; DuckDuckGo est bloqué (ECONNRESET), Brave nécessite une clé |
| Un titre n'est jamais trouvé | pas sur Netflix dans `REGION`, ou sorti trop récemment pour être indexé |
| Aucune source sur une fiche | le titre n'a ni bande-annonce Netflix/Apple ni clé YouTube : lance `npm run netflix-trailers` puis `npm run vf` |

## Structure

```
src/index.js            point d'entrée HTTP + planificateur de synchro
src/app.js              routes Express : API v1, dashboard, relais MP4/HLS, /health
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
