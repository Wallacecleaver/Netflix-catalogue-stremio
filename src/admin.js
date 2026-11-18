const fs = require('fs');
const path = require('path');
const { version } = require('../package.json');

// Page du dashboard (HTML autonome : CSS + JS inclus, version injectée depuis package.json).
const HTML = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8').replace(/__APP_VERSION__/g, String(version || '0.0.0'));

module.exports = { HTML };
