const { syncCatalog } = require('../src/sync');
syncCatalog().then((n) => console.log(`+${n} titres`)).catch((e) => { console.error(e.message); process.exitCode = 1; });
