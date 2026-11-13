const fs = require('fs');
const path = require('path');

// Page du dashboard (HTML autonome : CSS + JS inclus).
const HTML = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');

module.exports = { HTML };
