# W stockage bande annonce — addon Stremio

> Le nom affiché est **W stockage bande annonce**. Le nom technique du dépôt, de l'image Docker et l'identifiant
> de l'addon (`community.wallacecleaver.netflix-catalogue`) restent inchangés pour ne pas casser les installations existantes.

Addon Stremio **de stockage de bandes-annonces** (aucun film/épisode, **aucun catalogue**). Il stocke pour chaque titre ses bandes-annonces
**Netflix** et **Apple TV**, et les propose comme flux sur n'importe quelle fiche Stremio dont l'ID IMDb est connu
(film, série, épisodes), plus sur les anciennes fiches `nflx:`. Il garde aussi, pour chaque titre,
synopsis, année, classification (16+), genres, casting, **bande-annonce**, **épisodes avec synopsis, durée et images**.

Stack : Node.js · `stremio-addon-sdk` · Express · **SQLite** (`better-sqlite3`) · Docker.

## Sources de données
1. **Page Netflix** (`netflix.com/fr/title/<id>`) : titre, synopsis, casting, classification, épisodes (JSON-LD + `netflix.reactContext`).
2. **TMDB** (clé gratuite) : affiches verticales, fonds, logos, épisodes/stills de secours, liste automatique des titres des plateformes choisies (synchronisation) et bande-annonce YouTube de secours.
3. **JustWatch** (API GraphQL publique) : correspondance nom → **ID Netflix** (la recherche netflix.com redirige vers `/login`, elle ne permet pas de découvrir les IDs).
4. **JustWatch** (déjà utilisé pour le liage) : recherche nom → ID Netflix pour l'onglet **Recherche** et la résolution à la demande — gratuit et sans clé. Un moteur de recherche web (Brave Search, clé facultative, ou DuckDuckGo) ne sert plus que de secours si JustWatch est indisponible.
5. **API iTunes Search** (publique, sans clé) : secours pour retrouver une fiche tv.apple.com quand l'API web de tv.apple.com ne renvoie rien — l'URL renvoyée contient déjà l'ID `umc.cmc.*`.
6. **Autre instance** (optionnel) : API de fédération pour récupérer les bandes-annonces par TMDB/IMDb.

> La bande-annonce de la page Netflix est relayée par ton addon (`PUBLIC_URL/trailer/<id>/<n>.mp4`) : Stremio reçoit une URL
> stable, et le lien signé Netflix est renouvelé à chaque lecture.
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
Ou via l'onglet **Ajouter** du dashboard (`https://netflix.mondomaine.fr/admin`, protégé par `ADMIN_TOKEN`).

## Dashboard d'administration
`https://netflix.mondomaine.fr/admin` (ou juste `/`, qui redirige) — mot de passe : la valeur `ADMIN_TOKEN` du `.env`.

Six onglets : **Stockage** (couverture des bandes-annonces, état des sources — TMDB, JustWatch, Apple TV, ffmpeg —, puis les trois étapes *collecter → enrichir → brancher Stremio*), **Recherche** (tape un titre : liens Netflix trouvés via JustWatch et titres Apple TV via l'API iTunes, puis « Ajouter » pour stocker la bande-annonce après vérification à l'œil), **Ajouter** (ajout direct, sans passer par la recherche : URL ou ID Netflix, URL ou ID Prime Video, et recherche par titre ou URL `tv.apple.com` pour Apple TV), **Titres** (liste filtrable par source de bande-annonce), **Paramètres** et **Journal**. Détail historique :

**Vue d'ensemble**
- Statistiques : titres, films, séries, épisodes, sorties récentes, **IDs Netflix liés**, taille de la base, uptime.
- Configuration actuelle (lecture seule) avec la provenance de chaque valeur.
- Actions : synchronisation TMDB complète + dernières sorties, ajout/rafraîchissement d'un titre Netflix, **liage des IDs Netflix** (progression en direct).
- Liens Stremio : manifest, `/health`, relais bande-annonce.

**Paramètres**
- Toutes les variables du `.env` sont **modifiables** : port, URL publique, clé TMDB, région/langue/pays, pages et fréquences de synchro, fenêtre des nouveautés, cache, clé API et instance amont, mot de passe admin.
- Les valeurs sont validées (nombres, listes) et enregistrées dans la table `settings` de SQLite, donc **persistées dans le volume `./data`** et conservées à chaque redéploiement. Le conteneur ne voyant pas le `.env` de l'hôte, c'est la base qui porte les surcharges.
- Priorité : **dashboard > `.env` > valeur par défaut**. Le bouton ↺ d'un champ restaure la valeur du `.env` ; la provenance est affichée pour chaque paramètre.
- `PORT`, `DB_PATH` et `SYNC_EVERY_HOURS` sont marqués **⟳ redémarrage** : ils ne s'appliquent qu'après `docker compose restart`.
- Modifier `ADMIN_TOKEN` prend effet immédiatement et met à jour la session du dashboard ; les autres sessions devront se reconnecter.
- Sécurité : 10 essais échoués par minute et par IP maximum (protection basique contre le bruteforce).

## Synchronisation TMDB
Avec `TMDB_API_KEY`, l'addon synchronise au démarrage puis toutes les `SYNC_EVERY_HOURS` h les titres Netflix et Apple TV+ de la région `REGION`.
Les plateformes listées se règlent avec `CATALOG_PROVIDERS` (identifiants TMDB : `8` Netflix, `337` Apple TV+, `2` Apple TV, `119` Prime Video, combinables `8,337` ; `all` = tout TMDB sans filtre, réservé à un usage ponctuel avec `SYNC_PAGES` élevé).
Les fiches sont complétées (épisodes, casting, trailer) à la première ouverture. Manuel : `npm run sync`.

## Association des IDs Netflix (JustWatch)
Chaque fiche du catalogue reçoit son `netflix_id`, ses bandes-annonces Netflix (jusqu'à plusieurs par titre) et les identifiants TMDB/IMDb manquants.
La correspondance passe par **JustWatch** (nom + année + type + offre Netflix réelle).
- Dans le dashboard : bouton **Lier les titres manquants**, avec progression en direct et bouton d'arrêt.
- Automatiquement après chaque synchronisation TMDB, puis au démarrage s'il reste des fiches non liées.
- En ligne de commande : `npm run netflix-ids -- --limit 50` (tout par défaut).

Chaque titre est stocké avec `netflix_id`, `name`, `tmdb_id`, `tmdb_type`, `imdb_id`.
Export JSON depuis le dashboard (**Exporter les IDs**) ; le relais `/trailer/<id>/...` recherche la fiche par `netflix_id`
(et non par ID Stremio), donc les fiches venues des catalogues TMDB diffusent aussi la bande-annonce Netflix.

## Moissonnage complet des IDs Netflix
`npm run harvest` liste **tout** le catalogue Netflix de la région `REGION` (films + séries) via les offres JustWatch :
l'ID Netflix est lu directement dans l'URL de l'offre, sans appariement par nom. Le catalogue est découpé par type et par année
de sortie (plus de limite de pagination), puis chaque titre est enregistré (nouvelle fiche, ou lié à la fiche TMDB existante).
```bash
npm run harvest                          # tout le catalogue
npm run harvest:recent                   # dernières sorties (année précédente, en cours et suivante)
npm run harvest -- --from 2020 --to 2026 # plage d'années
npm run harvest -- --type series         # movie | series
npm run harvest -- --dry                 # ne touche pas à la base, exporte seulement
```
Dans le dashboard (`/admin`), la carte **Moissonnage du catalogue Netflix** lance la même chose en un clic (tout le catalogue ou seulement les dernières sorties),
avec barre de progression (année en cours, IDs vus / nouveaux / liés / déjà connus), bouton d'arrêt et résumé final. Les erreurs vont dans le **Journal** (source `harvest`).

Sortie : `data/netflix-ids.json` et `data/netflix-ids.csv` (`netflix_id, name, type, year, tmdb_id, imdb_id`).
Ensuite `npm run netflix-ids` complète TMDB/IMDb, bandes-annonces et épisodes. Pour garder les « Dernières sorties » à jour,
planifie `npm run harvest:recent` (cron) en plus de la synchro TMDB.

## Remplir les bandes-annonces Netflix

Le moissonnage et le liage ne posent que les `netflix_id`. Cette tâche lit ensuite la page Netflix de chaque
titre déjà lié qui n'a pas encore de bande-annonce, et stocke la vidéo, les épisodes et le casting — c'est
elle qui fait passer la couverture de quelques pour cent à l'essentiel du catalogue.

```bash
npm run netflix-trailers                  # tout le gisement (≈ 1,2 s par page)
npm run netflix-trailers -- --limit 50    # pour tester
```

Dans le dashboard : carte **Bandes-annonces Netflix** (progression, bouton d'arrêt, compteur « pages à lire »).
Une page lue sans bande-annonce n'est pas relue avant 7 jours ; 8 échecs consécutifs arrêtent la tâche
(Netflix bloque). Le Journal (source `netflix`) garde la trace des erreurs.

## Catalogue mondial et bandes-annonces VF
- **Plusieurs pays** : `HARVEST_COUNTRIES` (défaut `FR,US,GB,CA`, modifiable dans *Paramètres*) ou `npm run harvest -- --countries FR,US,DE`.
  L'ID Netflix est identique dans tous les pays : le moissonnage fait l'union dédoublonnée, donc les titres exclusifs aux États-Unis sont inclus.
- **Liaison TMDB / IMDb** : `npm run vf` (ou le bouton du dashboard) interroge TMDB, une requête par titre, pour retrouver l'ID IMDb et compléter affiche, fond, synopsis et genres. Nécessite `TMDB_API_KEY`.
- Les titres sans résultat sont revérifiés après 14 jours.
- Ordre conseillé : `npm run harvest` → `npm run vf` → `npm run netflix-ids` (bande-annonce Netflix, casting, épisodes).

## Journal d'événements
Un journal persistant capture les actions clés (liage, synchronisation, erreurs de bande-annonce, etc.).
- Accessible depuis le dashboard via l'onglet **Journal**.
- Filtrable par niveau (`error`, `warn`, `info`) et recherche libre.
- API : `GET /admin/api/logs`, `POST /admin/api/logs/clear`.
- Historique conservé en base SQLite (`logs`), limité à 2000 entrées.

## API de fédération (partage de bandes-annonces)
Une instance peut **exposer** ses bandes-annonces, et une autre peut les **récupérer automatiquement** par TMDB/IMDb.

### Instance source
Dans le `.env` (ou l'onglet Paramètres) :
```env
# Facultatif : sans API_KEY, l'API est ouverte (seule l'URL sert de secret)
API_KEY=
PUBLIC_URL=https://netflix.mondomaine.fr
```
Si `API_KEY` est vide, l'API répond **sans clé** : une autre instance n'a besoin que de l'URL.
Si `API_KEY` est renseignée, la clé est exigée en en-tête `x-api-key` (ou `?key=` en dépannage) :
```bash
# Par IMDb
curl -H "x-api-key: une-longue-cle-secrete" \
  "https://netflix.mondomaine.fr/api/trailers?imdb=tt7777777"

# Par TMDB (type facultatif : movie ou series)
curl -H "x-api-key: une-longue-cle-secrete" \
  "https://netflix.mondomaine.fr/api/trailers?tmdb=777&type=movie"

# Par ID Netflix
curl -H "x-api-key: une-longue-cle-secrete" \
  "https://netflix.mondomaine.fr/api/trailers?netflix=77777777"

# État de l'instance
curl -H "x-api-key: une-longue-cle-secrete" \
  "https://netflix.mondomaine.fr/api/status"
```
Réponse :
```json
{
  "found": true,
  "title": {
    "id": "nflx:mv-777", "name": "Film lié", "type": "movie", "year": 2024,
    "netflix_id": "77777777", "tmdb_id": 777, "tmdb_type": "movie", "imdb_id": "tt7777777"
  },
  "trailers": [
    { "title": "Bande-annonce", "url": "https://netflix.mondomaine.fr/trailer/77777777/0.mp4",
      "runtime": 120, "source": "netflix" }
  ]
}
```
Si aucune fiche ne correspond : `{ "found": false, "trailers": [] }`.

> Sans `API_KEY`, les exemples `curl` ci-dessus fonctionnent sans l'en-tête `x-api-key`.

### Instance qui récupère
Dans son `.env` (ou l'onglet Paramètres) :
```env
UPSTREAM_URL=https://netflix.mondomaine.fr
UPSTREAM_API_KEY=une-longue-cle-secrete
```
Quand une fiche possède un `imdb_id` ou un `tmdb_id` mais **aucune bande-annonce**, l'addon interroge l'instance amont
au moment de l'ouverture de la fiche (et lors d'une demande de flux), puis stocke les URLs reçues.
- Si la fiche a un `netflix_id`, les URLs sont relayées par **son propre** `/trailer/...`.
- Sinon, l'URL de l'instance amont est utilisée directement.
- Nouvelle tentative au bout de 6 h en cas d'échec.

> L'API ne renvoie que les bandes-annonces Netflix déjà associées dans la base.
> `PUBLIC_URL` doit être l'URL publique réellement accessible par l'autre instance.

## Recherche automatique (à l'ouverture d'une fiche)
Quand Stremio demande les flux d'une fiche (ID IMDb `tt…`) que l'addon ne connaît pas encore, il la résout tout seul :
1. **TMDB** : IMDb → titre, année, type (+ bande-annonce VF au passage) ;
2. **Web** : recherche de l'ID Netflix via **JustWatch** (gratuit, sans clé) — un moteur de recherche (Brave si clé, sinon DuckDuckGo) ne sert que si JustWatch tombe ;
3. **Page Netflix** : lecture de la page, vérification du nom, du type et de l'année (pour une série, l'année Netflix est celle de la dernière saison), puis stockage de sa bande-annonce ;
4. **Apple TV** : recherche par titre.
Chaque titre n'est cherché qu'une fois (cache SQLite : 30 jours si trouvé, 7 jours sinon). Les recherches sont espacées d'une seconde (`resolve.js`) et mises en pause 10 min en cas d'échec.
Si la recherche dépasse 15 s, elle continue en arrière-plan : la bande-annonce apparaîtra à la prochaine ouverture de la fiche.
La même résolution est déclenchée par l'API `GET /api/trailers?imdb=tt…&type=movie|series` (utilisée par vf-trailer-wallace) : attente de 5 s au plus,
puis `pending: true` dans la réponse si la recherche continue en arrière-plan. Garde-fou : 20 nouvelles recherches par minute au maximum.
Nécessite `TMDB_API_KEY` ; `RESOLVE_ENABLED=0` désactive. Code : `src/resolve.js`. Les onglets Recherche / Titres du dashboard restent utiles pour ajouter ou vérifier à la main.

## Bandes-annonces Apple TV
Pour chaque titre, l'addon cherche une bande-annonce sur **tv.apple.com** (API web non documentée) : recherche par titre exact (+ année et type), puis lecture
de la page. La bande-annonce (« Bandes-annonces » de la page) et, à défaut, l'aperçu `og:video` sont des flux **HLS (.m3u8)**.
- Lancement : bouton **Apple TV** du dashboard (titres jamais vérifiés), ou automatiquement à la première ouverture d'une fiche. Test : `npm run inspect-appletv -- "Ted Lasso" series`.
- Si l'API web ne renvoie rien (paramètres périmés), le secours passe par l'**API iTunes Search** (publique, sans clé) : l'URL renvoyée contient déjà le type et l'ID `umc.cmc.*` de la fiche.
- Le HLS Apple n'est **pas chiffré** (les clés FairPlay de la page ne servent qu'à l'app Apple) : l'addon télécharge les segments et les recolle en vrai **MP4**,
  mis en cache sur disque (`HLS_CACHE_DIR`, 7 jours), puis le sert comme le relais Netflix : `PUBLIC_URL/apple/<id>/<n>.mp4`, avec support des `Range`.
  Le résultat se lit donc partout (Stremio PC/mobile **et** Stremio Web, navigateur, VLC).
- **Le son** : Apple sépare l'image et l'audio en deux flux HLS. L'addon prend la piste de la langue de `TMDB_LANG` (`fr-FR` par défaut, sinon VO),
  en évitant les pistes d'audio-description, et recolle le tout avec **ffmpeg** (`-c copy`, sans réencodage). Sans ffmpeg, la bande-annonce reste
  **muette** et le journal l'indique. Installation : `apt install ffmpeg` (Debian/Ubuntu), `brew install ffmpeg` (macOS), `winget install Gyan.FFmpeg`
  (Windows), ou `FFMPEG_PATH` dans `.env` vers le binaire. L'image Docker l'installe déjà.
- Première lecture : la conversion prend quelques secondes (téléchargement de ~20-50 Mo). Elle est lancée en tâche de fond dès l'affichage de la liste des flux.
  Réglages : `HLS_MAX_HEIGHT` (720 par défaut), `HLS_MAX_MB` (60), `HLS_CACHE_DAYS` (7).
- Résultat mis en cache 30 jours (sans résultat : 7 jours).
- Apple TV ne couvre que son catalogue (Apple Originals et chaînes) : beaucoup de titres Netflix n'y sont pas.
- Si la recherche renvoie une erreur 400, recopie `v`, `utscf` et `utsk` depuis la requête `/api/uts/v3/search` de tv.apple.com (F12 → Réseau)
  dans `APPLETV_API_VERSION`, `APPLETV_UTSCF`, `APPLETV_UTSK`. `APPLETV_ENABLED=0` désactive tout.
- `src/appletv.js` (recherche) et `src/hls.js` (HLS → MP4). Le scraping de tv.apple.com peut aller à l'encontre de leurs CGU : à utiliser avec modération.

## Si le scraping Netflix ne remonte pas tout
```bash
npm run inspect -- 81944880
```
Sauvegarde la page dans `data/inspect-81944880.html` et affiche ce que le parseur a extrait (utile pour ajuster `src/netflix.js`).
Sans épisodes Netflix, ceux de TMDB sont utilisés.

## Tests
`npm test` : parseur + SQL + handlers Stremio, sans réseau.
`npm run test:search` : recherche des IDs (JustWatch, secours web) + API iTunes, réseau simulé, 10 cas.

## Structure
`src/netflix.js` scraper · `src/justwatch.js` correspondance nom → ID Netflix · `src/link.js` liage en arrière-plan · `src/tmdb.js` · `src/enrich.js` fusion Netflix+TMDB · `src/sync.js` catalogue · `src/federation.js` API/partage des bandes-annonces · `src/addon.js` manifest/handlers · `src/db.js` SQLite.

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
(avec support des `Range`). La bande-annonce est aussi exposée comme ressource `stream`, donc elle apparaît également dans la liste des flux.
Réglages dans `.env` : `PUBLIC_URL` (obligatoire sur le VPS, ex. `https://netflix.mondomaine.fr`).
Test direct : ouvre `http://localhost:7000/trailer/81944880/0.mp4` dans ton navigateur.

> **Qualité** : Netflix ne sert ses bandes-annonces qu'en **768×432** (≈ 1,26 Mb/s) — vérifié sur plusieurs
> titres, et la page n'expose aucune variante (`playableVideo` ne contient qu'une `url`). Le relais ne
> recompresse rien : c'est la source. Pour avoir mieux, `YOUTUBE_AS_SOURCE=1` ajoute la vidéo YouTube de
> TMDB (1080p) **à côté** de Netflix, sur les fiches qui ont déjà une bande-annonce Netflix/Apple.

## Prime Video (métadonnées)

`src/primevideo.js` lit une page `https://www.primevideo.com/-/fr/detail/<id>` (JSON embarqué `dv-web-page-hydration-data`) :
titre, synopsis, genres, casting, épisodes, visuels. La bande-annonce n'est stockée que comme référence (`extra.primeTrailer`) :
son flux est protégé (DRM + jeton lié à la session) et n'est pas lisible directement. Vérifié : la page ne contient aucun
`.m3u8`/`.mp4`, et l'`playbackEnvelope` est un JWE chiffré (`A256KW` / `A256CBC-HS512`) — contrairement à Netflix (lien signé
mais clair) et Apple TV (HLS non chiffré), il n'y a rien à relayer.

En pratique la fiche Prime a quand même une bande-annonce : la clé YouTube de TMDB (`trailer_yt`, remplie à l'import, ou
`vf_trailer` par la tâche « IDs IMDb / TMDB ») est exposée comme bouton **Bande-annonce** de la fiche Stremio, uniquement
lorsque le titre n'a aucune bande-annonce Netflix/Apple.

- Déboguer : `npm run inspect-prime -- <url|id>` ou `npm run inspect-prime -- --file page.html`
- Ajouter en base : onglet **Ajouter** du dashboard, ou `npm run add -- https://www.primevideo.com/-/fr/detail/<id>` (id stocké : `prime:<id>`)
- Sur le VPS : `docker compose exec netflix-catalogue node scripts/add.js <url>`
