const fs = require('fs');
require('../src/settings');                     // applique les surcharges enregistrées depuis /admin
const { ingestNetflix } = require('../src/enrich');
// Usage : npm run add -- <url|id> [<url|id> ...]
//         npm run add -- <id> --file page.html   (page enregistrée depuis ton navigateur)
(async () => {
  const args = process.argv.slice(2);
  const fi = args.indexOf('--file');
  const file = fi >= 0 ? args.splice(fi, 2)[1] : null;
  if (!args.length) { console.log('Usage: npm run add -- <url|id> [--file page.html]'); process.exitCode = 1; return; }
  const html = file ? fs.readFileSync(file, 'utf8') : undefined;
  for (const a of args) {
    try { console.log('OK ', JSON.stringify(await ingestNetflix(a, { html }))); }
    catch (e) { console.error('ERR', a, e.message); process.exitCode = 1; }
  }
})();
