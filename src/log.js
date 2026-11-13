const store = require('./db');

// Petit journal d'événements persisté dans SQLite, affiché dans l'onglet « Journal » du dashboard.
// Toutes les entrées sont aussi visibles en base (`logs`), y compris si le dashboard est inaccessible.
const LEVELS = ['debug', 'info', 'warn', 'error'];

function write(level, source, message, meta) {
  if (!LEVELS.includes(level)) level = 'info';
  try {
    store.addLog({ level, source, message: String(message), meta });
  } catch (e) {
    console.warn('[log]', e.message);
  }
}

module.exports = {
  debug: (source, message, meta) => write('debug', source, message, meta),
  info: (source, message, meta) => write('info', source, message, meta),
  warn: (source, message, meta) => write('warn', source, message, meta),
  error: (source, message, meta) => write('error', source, message, meta),
  list: (opts = {}) => store.listLogs(opts),
  clear: () => store.clearLogs(),
};
