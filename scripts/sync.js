const { syncCatalog, syncRecent } = require('../src/sync');
require('../src/settings');                     // applique les surcharges enregistrées depuis /admin
Promise.all([syncCatalog(), syncRecent()])
  .then(([n, r]) => console.log(`+${n} titres, +${r} sorties récentes`))
  .catch((e) => { console.error(e.message); process.exitCode = 1; });
