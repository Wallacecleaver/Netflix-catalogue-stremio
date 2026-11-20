// Tests : détection de qualité des flux (paliers, parseur ffprobe, scan de fond + routes du dashboard)
// et source Facebook (extraction des liens MP4 d'une page de reel).
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'stockage-db-quality-'));
const PORT = 17000 + Math.floor(Math.random() * 2000);
process.env.PORT = String(PORT);
process.env.DB_PATH = path.join(tmpBase, 'quality.db');
process.env.HLS_CACHE_DIR = path.join(tmpBase, 'hls');
process.env.ADMIN_TOKEN = 'quality-admin-secret-123';
process.env.APPLETV_ENABLED = '0';
process.env.NETFLIX_REFRESH = '0';
process.env.RESOLVE_ENABLED = '0';
process.env.ALLOW_PRIVATE_URLS = '1';          // les MP4 de test sont servis sur 127.0.0.1

const quality = require('../src/quality');
const facebook = require('../src/facebook');

// ---- 1. Paliers ----
{
  const t = (w, h) => quality.tierOf(w, h).id;
  assert.strictEqual(t(3840, 2160), '4k');
  assert.strictEqual(t(2560, 1440), '1440p');
  assert.strictEqual(t(1920, 1080), '1080p');
  assert.strictEqual(t(1920, 800), '1080p', 'format cinéma 2.4:1 = Full HD');
  assert.strictEqual(t(1080, 1920), '1080p', 'vidéo verticale Full HD');
  assert.strictEqual(t(1280, 720), '720p');
  assert.strictEqual(t(720, 1280), '720p', 'reel vertical HD');
  assert.strictEqual(t(768, 432), 'sd', 'Netflix 768×432');
  assert.strictEqual(t(854, 480), 'sd');
  assert.strictEqual(t(640, 360), 'low');
  assert.strictEqual(t(0, 0), 'low');
}

// ---- 2. Parseur ffprobe ----
{
  const q = quality.parseProbe({
    streams: [
      { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '24000/1001', bit_rate: '4200000', color_transfer: 'bt709' },
      { codec_type: 'audio', codec_name: 'aac', bit_rate: '128000' },
    ],
    format: { duration: '61.5', size: '33000000', bit_rate: '4300000' },
  });
  assert.strictEqual(q.tier, '1080p');
  assert.strictEqual(q.vcodec, 'h264');
  assert.strictEqual(q.acodec, 'aac');
  assert.strictEqual(q.fps, 23.98);
  assert.strictEqual(q.bitrateKbps, 4200);
  assert.strictEqual(q.hasAudio, true);
  assert.strictEqual(q.hdr, false);

  // Rotation 90° : les dimensions affichées sont inversées ; HDR détecté ; débit déduit du format.
  const r = quality.parseProbe({
    streams: [{ codec_type: 'video', codec_name: 'hevc', width: 1920, height: 1080, side_data_list: [{ rotation: -90 }], color_transfer: 'smpte2084' }],
    format: { duration: '10', size: '5000000' },
  });
  assert.strictEqual(r.width, 1080);
  assert.strictEqual(r.height, 1920);
  assert.strictEqual(r.hasAudio, false);
  assert.strictEqual(r.hdr, true);
  assert.strictEqual(r.bitrateKbps, 4000);

  assert.throws(() => quality.parseProbe({ streams: [{ codec_type: 'audio' }] }), /aucune piste vidéo/);
  assert.throws(() => quality.parseProbe({ streams: [{ codec_type: 'video', width: 0, height: 0 }] }), /résolution/);
}

// ---- 3. Facebook : URL + extraction ----
{
  const ok = facebook.parseFacebookUrl('https://www.facebook.com/reel/1821011232469230');
  assert.strictEqual(ok.id, '1821011232469230');
  assert.ok(facebook.isFacebookUrl('https://fb.watch/abc123/'));
  assert.ok(facebook.isFacebookUrl('https://m.facebook.com/watch/?v=123456789'));
  assert.ok(!facebook.isFacebookUrl('https://evil.com/reel/1821011232469230'));
  assert.ok(!facebook.isFacebookUrl('https://facebook.com.evil.com/reel/1821011232469230'), 'sous-domaine piégé');
  assert.ok(!facebook.isFacebookUrl('javascript:alert(1)'));

  const html = '<meta property="og:title" content="Mon &amp; reel"><meta content="https://scontent.xx.fbcdn.net/a.jpg" property="og:image">'
    + '{"browser_native_hd_url":"https:\\/\\/video-cdg4-1.xx.fbcdn.net\\/o1\\/v\\/hd.mp4?_nc_cat=1\\u0026oe=6A000000",'
    + '"browser_native_sd_url":"https:\\/\\/evil.example\\/b.mp4","playable_url":"https:\\/\\/video.xx.fbcdn.net\\/sd.mp4?oe=69000000"}';
  const p = facebook.parseFacebookHtml(html);
  assert.strictEqual(p.title, 'Mon & reel');
  assert.deepStrictEqual(p.sources.map((s) => s.quality), ['hd', 'sd']);
  assert.ok(p.sources[0].url.includes('&oe=6A000000'), 'les \\u0026 sont décodés');
  assert.ok(p.sources.every((s) => /fbcdn\.net/.test(s.url)), 'les hôtes hors CDN Facebook sont refusés');
  assert.strictEqual(p.expiresAt, parseInt('69000000', 16) * 1000, 'expiration = plus proche des liens signés');
}

// ---- 4. Scan de bout en bout (vrais MP4 générés par ffmpeg, vraie base, vraies routes) ----
async function e2e() {
  const have = (bin) => { try { return spawnSync(bin, ['-version'], { stdio: 'ignore' }).status === 0; } catch { return false; } };
  if (!have('ffmpeg') || !quality.available()) {
    console.log('quality.test : ffmpeg/ffprobe absents, partie bout-en-bout ignorée');
    return;
  }
  const gen = (name, size, audio) => {
    const out = path.join(tmpBase, name);
    const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=24`];
    if (audio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440');
    args.push('-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p');
    if (audio) args.push('-c:a', 'aac', '-shortest');
    args.push('-movflags', '+faststart', out);
    assert.strictEqual(spawnSync('ffmpeg', args).status, 0, `ffmpeg ${name}`);
    return out;
  };
  const files = {
    '/hd.mp4': gen('hd.mp4', '1280x720', true),
    '/vertical.mp4': gen('vertical.mp4', '720x1280', true),
    '/muet.mp4': gen('muet.mp4', '640x360', false),
  };

  // Mini serveur de fichiers avec support des requêtes Range (comme un vrai CDN).
  const origin = http.createServer((req, res) => {
    const f = files[req.url];
    if (!f) { res.statusCode = 404; return res.end('nope'); }
    const size = fs.statSync(f).size;
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      const start = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      res.writeHead(206, { 'content-type': 'video/mp4', 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1, 'accept-ranges': 'bytes' });
      return fs.createReadStream(f, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': size, 'accept-ranges': 'bytes' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => origin.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${origin.address().port}`;

  const store = require('../src/db');
  const app = require('../src/app');
  const server = await new Promise((r) => { const s = app.listen(PORT, '127.0.0.1', () => r(s)); });

  try {
    store.upsertTitle({
      id: 'tt0000001', type: 'movie', name: 'Film de test', imdb_id: 'tt0000001',
      extra: { manualTrailers: [
        { title: 'HD', url: `${base}/hd.mp4` },
        { title: 'Vertical', url: `${base}/vertical.mp4` },
        { title: 'Muet', url: `${base}/muet.mp4` },
        { title: 'Cassé', url: `${base}/absent.mp4` },
      ] },
    });

    const st = await quality.run({ delayMs: 0, concurrency: 2 });
    assert.strictEqual(st.total, 4);
    assert.strictEqual(st.ok, 3);
    assert.strictEqual(st.failed, 1);

    const row = (i) => store.getQuality(`manual:tt0000001:${i}`);
    assert.strictEqual(row(0).tier, '720p');
    assert.strictEqual(`${row(0).width}x${row(0).height}`, '1280x720');
    assert.strictEqual(row(0).vcodec, 'h264');
    assert.strictEqual(row(0).has_audio, 1);
    assert.strictEqual(row(1).tier, '720p', 'vertical 720×1280');
    assert.strictEqual(`${row(1).width}x${row(1).height}`, '720x1280');
    assert.strictEqual(row(2).tier, 'low');
    assert.strictEqual(row(2).has_audio, 0);
    assert.strictEqual(row(3).ok, 0);
    assert.ok(row(3).error, 'le flux cassé porte un message d’erreur');

    const stats = store.qualityStats();
    assert.strictEqual(stats.total, 4);
    assert.strictEqual(stats.byTier['720p'], 2);
    assert.strictEqual(stats.noAudio, 1);
    assert.strictEqual(stats.hdPlus, 2);
    assert.strictEqual(store.listQuality({ status: 'error' }).total, 1);
    assert.strictEqual(store.listQuality({ tier: 'low' }).total, 1);
    assert.strictEqual(store.listQuality({ search: 'test' }).total, 4);

    // Deuxième passage : tout est récent, rien à refaire (sauf le flux en erreur, retenté après 6 h).
    const again = quality.buildQueue({});
    assert.strictEqual(again.length, 0);
    assert.strictEqual(quality.buildQueue({ force: true }).length, 4);

    // Routes du dashboard
    const hdr = { 'x-admin-token': process.env.ADMIN_TOKEN, 'content-type': 'application/json' };
    const denied = await fetch(`http://127.0.0.1:${PORT}/admin/api/quality`);
    assert.strictEqual(denied.status, 401, 'route protégée par le mot de passe admin');
    const list = await (await fetch(`http://127.0.0.1:${PORT}/admin/api/quality?sort=best&limit=10`, { headers: hdr })).json();
    assert.strictEqual(list.total, 4);
    assert.strictEqual(list.rows[0].ok, 1);
    assert.strictEqual(list.stats.ok, 3);
    assert.strictEqual(list.scan.available, true);
    const one = await (await fetch(`http://127.0.0.1:${PORT}/admin/quality/analyze`, { method: 'POST', headers: hdr, body: JSON.stringify({ key: 'manual:tt0000001:0' }) })).json();
    assert.strictEqual(one.ok, true);
    assert.strictEqual(one.record.tier, '720p');
    const bad = await fetch(`http://127.0.0.1:${PORT}/admin/quality/analyze`, { method: 'POST', headers: hdr, body: JSON.stringify({ key: 'manual:inconnu:9' }) });
    assert.strictEqual(bad.status, 400);

    // Le quota public du relais ne bloque pas les sondes internes, mais s'applique aux autres clients.
    const noSecret = await fetch(`http://127.0.0.1:${PORT}/media/tt0000001/0.mp4`, { headers: { range: 'bytes=0-1' } });
    assert.strictEqual(noSecret.status, 206);
    await noSecret.body?.cancel();

    // Suppression d'une fiche : son historique de qualité part avec elle.
    store.deleteTitle('tt0000001');
    assert.strictEqual(store.qualityStats().total, 0);

    // Le dashboard embarque bien le nouvel onglet.
    const page = await (await fetch(`http://127.0.0.1:${PORT}/admin`)).text();
    assert.ok(page.includes('id="tab-quality"') && page.includes('data-tab="quality"'));
  } finally {
    server.close();
    origin.close();
  }
}

e2e().then(() => {
  console.log('quality.test : OK');
  process.exit(0);
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
