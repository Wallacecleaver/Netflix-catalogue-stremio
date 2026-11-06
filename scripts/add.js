const { ingestNetflix } = require('../src/enrich');
(async () => {
  const args = process.argv.slice(2);
  if (!args.length) { console.log('Usage: npm run add -- <url|id> [...]'); process.exit(1); }
  for (const a of args) {
    try { console.log('OK ', JSON.stringify(await ingestNetflix(a))); }
    catch (e) { console.error('ERR', a, e.message); }
  }
})();
