'use strict'

// Single AI client entry. Implementation currently lives in root deepseek.js;
// call sites should require this module so the boundary can move without
// rewriting every consumer.
module.exports = require('../../../deepseek')
