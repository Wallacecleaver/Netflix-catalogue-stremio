# Netflix Catalogue — addon Stremio

Addon Stremio **métadonnées + bande-annonce en flux** (aucun film/épisode) : catalogue Netflix avec, pour chaque titre,
synopsis, année, classification (16+), genres, casting, **bande-annonce**, **épisodes avec synopsis, durée et images**.

Stack : Node.js · `stremio-addon-sdk` · Express · **SQLite** (`better-sqlite3`) · Docker.

## Sources de données
1. **Page Netflix** (`netflix.com/fr/title/<id>`) : titre, synopsis, casting, classification, épisodes (JSON-LD + `netflix.reactContext`).
2. **TMDB** (clé gratuite) : affiches verticales, fonds, logos, épisodes/stills de secours, trailers YouTube, et **catalogue automatique** des titres Netflix France.
3. **JustWatch** (API GraphQL publique) : correspondance nom → **ID Netflix** (la recherche netflix.com redirige vers `/login`, elle ne permet pas de découvrir les IDs).
4. **YouTube** (recherche) : filet de sécurité pour la bande-annonce.

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
Ou via `https://netflix.mondomaine.fr/admin` (protégé par `ADMIN_TOKEN`).

## Dashboard d'administration
`https://netflix.mondomaine.fr/admin` (ou juste `/`, qui redirige) — mot de passe : la valeur `ADMIN_TOKEN` du `.env`.

Deux onglets :

**Vue d'ensemble**
- Statistiques : titres, films, séries, épisodes, sorties récentes, **IDs Netflix liés**, taille de la base, uptime.
- Configuration actuelle (lecture seule) avec la provenance de chaque valeur.
- Actions : synchronisation TMDB complète + dernières sorties, ajout/rafraîchissement d'un titre Netflix, **liage des IDs Netflix** (progression en direct).
- Liens Stremio : manifest, `/health`, relais bande-annonce.

**Paramètres**
- Toutes les variables du `.env` sont **modifiables** : port, URL publique, clé TMDB, région/langue/pays, pages et fréquences de synchro, fenêtre des nouveautés, cache, préférence de bande-annonce, mot de passe admin.
- Les valeurs sont validées (nombres, listes) et enregistrées dans la table `settings` de SQLite, donc **persistées dans le volume `./data`** et conservées à chaque redéploiement. Le conteneur ne voyant pas le `.env` de l'hôte, c'est la base qui porte les surcharges.
- Priorité : **dashboard > `.env` > valeur par défaut**. Le bouton ↺ d'un champ restaure la valeur du `.env` ; la provenance est affichée pour chaque paramètre.
- `PORT`, `DB_PATH` et `SYNC_EVERY_HOURS` sont marqués **⟳ redémarrage** : ils ne s'appliquent qu'après `docker compose restart`.
- Modifier `ADMIN_TOKEN` prend effet immédiatement et met à jour la session du dashboard ; les autres sessions devront se reconnecter.
- Sécurité : 10 essais échoués par minute et par IP maximum (protection basique contre le bruteforce).

## Catalogue automatique
Avec `TMDB_API_KEY`, l'addon synchronise au démarrage puis toutes les `SYNC_EVERY_HOURS` h les titres Netflix de la région `REGION`.
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

## Catalogue mondial et bandes-annonces VF
- **Plusieurs pays** : `HARVEST_COUNTRIES` (défaut `FR,US,GB,CA`, modifiable dans *Paramètres*) ou `npm run harvest -- --countries FR,US,DE`.
  L'ID Netflix est identique dans tous les pays : le moissonnage fait l'union dédoublonnée, donc les titres exclusifs aux États-Unis sont inclus.
- **Bande-annonce VF** : `npm run vf` (ou le bouton du dashboard) interroge TMDB, une requête par titre, et retient la bande-annonce YouTube marquée en français.
  La même requête complète affiche, fond, synopsis, genres et IMDb des fiches moissonnées. Nécessite `TMDB_API_KEY`.
  Résultat : flux **« Netflix VF »** (YouTube) en premier dans Stremio et deux catalogues **« Films / Séries avec bande-annonce VF »**.
- Les titres sans résultat sont revérifiés après 14 jours (une bande-annonce VF peut sortir plus tard).
- Ordre conseillé : `npm run harvest` → `npm run vf` → `npm run netflix-ids` (bande-annonce Netflix, casting, épisodes).

## Journal d'événements
Un journal persistant capture les actions clés (liage, synchronisation, erreurs de bande-annonce, etc.).
- Accessible depuis le dashboard via l'onglet **Journal**.
- Filtrable par niveau (`error`, `warn`, `info`) et recherche libre.
- API : `GET /admin/api/logs`, `POST /admin/api/logs/clear`.
- Historique conservé en base SQLite (`logs`), limité à 2000 entrées.

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
`src/netflix.js` scraper · `src/justwatch.js` correspondance nom → ID Netflix · `src/link.js` liage en arrière-plan · `src/tmdb.js` · `src/enrich.js` fusion Netflix+TMDB · `src/sync.js` catalogue · `src/addon.js` manifest/handlers · `src/db.js` SQLite.

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
*(Le choix de bande-annonce est désormais limité à Netflix uniquement.)*
Test direct : ouvre `http://localhost:7000/trailer/81944880/0.mp4` dans ton navigateur.
