const { syncCatalog, syncRecent } = require('../src/sync');
Promise.all([syncCatalog(), syncRecent()])
  .then(([n, r]) => console.log(`+${n} titres, +${r} sorties récentes`))
  .catch((e) => { console.error(e.message); process.exitCode = 1; });
