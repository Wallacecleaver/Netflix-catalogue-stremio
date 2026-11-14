// Recherche manuelle d'un titre : liens Netflix trouvés via DuckDuckGo (site:netflix.com/title <titre>).
// L'ajout se fait ensuite avec ingestNetflix (page Netflix → bande-annonce), après vérification à l'œil par l'utilisateur.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const decodeEnt = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
const strip = (s) => decodeEnt(String(s).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
const cleanTitle = (t) => t.replace(/^(Watch|Regarder)\s+/i, '').replace(/\s*[|\-–]\s*Netflix( Official Site)?\s*$/i, '').trim();
const NETFLIX_ID = /netflix\.com\/(?:[a-z]{2}(?:-[A-Za-z]{2})?\/)?title\/(\d+)/;

/** HTML de html.duckduckgo.com → [{ id, url, title, snippet }] (dédoublonné par ID Netflix). */
function parse(html) {
  const out = [];
  const seen = new Set();
  for (const block of html.split(/class="result__a"/).slice(1)) {
    const href = /href="([^"]+)"/.exec(block);
    if (!href) continue;
    let url = decodeEnt(href[1]);
    const u = /[?&]uddg=([^&]+)/.exec(url);
    if (u) { try { url = decodeURIComponent(u[1]); } catch { /* garde l'URL brute */ } }
    const m = NETFLIX_ID.exec(url);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    const title = />([\s\S]*?)<\/a>/.exec(block);
    const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    out.push({ id: m[1], url: `https://www.netflix.com/title/${m[1]}`, title: title ? cleanTitle(strip(title[1])) || null : null, snippet: snippet ? strip(snippet[1]).slice(0, 220) : '' });
  }
  if (!out.length) {   // mise en page changée : on récupère au moins les IDs présents dans le HTML
    for (const m of decodeURIComponent(html.replace(/%(?![0-9A-Fa-f]{2})/g, '%25')).matchAll(/netflix\.com\/(?:[a-z]{2}(?:-[A-Za-z]{2})?\/)?title\/(\d+)/g)) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      out.push({ id: m[1], url: `https://www.netflix.com/title/${m[1]}`, title: null, snippet: '' });
    }
  }
  return out;
}

async function netflix(query) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`site:netflix.com/title ${query}`)}&kl=fr-fr`;
  const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'fr-FR,fr;q=0.9' }, signal: AbortSignal.timeout(10000) });
  const html = await res.text();
  if (!res.ok || /anomaly|captcha|unusual traffic/i.test(html.slice(0, 5000))) throw new Error(`DuckDuckGo bloque la requête (HTTP ${res.status}) : réessaie dans quelques minutes`);
  return parse(html).slice(0, 8);
}

module.exports = { netflix, parse };
