'use strict';

// whatsapp-web.js `require('puppeteer')`. The real `puppeteer` package
// postinstall-downloads chrome-headless-shell, which fails `npx` from a
// dummy root. Re-export puppeteer-core; whatseal launches system Chrome.
module.exports = require('puppeteer-core');
