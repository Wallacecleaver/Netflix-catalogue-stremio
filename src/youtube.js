// Filet de sécurité : si TMDB n'a pas de bande-annonce, on cherche la vidéo sur YouTube.
async function searchTrailer(query) {
  try {
    const res = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=fr`, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'accept-language': 'fr-FR,fr;q=0.9',
        cookie: 'CONSENT=YES+1',
      },
    });
    if (!res.ok) return null;
    const m = (await res.text()).match(/"videoId":"([\w-]{11})"/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}
module.exports = { searchTrailer };
