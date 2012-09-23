'use strict';

/**
 * Third party modules.
 */
var canihaz = require('canihaz')('square')
  , which = require('which').sync
  , _ = require('lodash');

/**
 * Library modules.
 */
var asyncChild = require('./lib/child');

/**
 * Check if the Java Runtime is enabled/installed.
 *
 * @type {Boolean}
 */
var runtime = which('java');

/**
 * Compression levels, the lower the faster, the higher the better.
 *
 * @type {Array}
 * @api private
 */
exports.levels = {
    js: runtime
      ? [
          ['yui']                       // level 0
        , ['uglify']                    // level 1
        , ['closure']                   // level 2
        , ['yui', 'uglify']             // level 3
        , ['yui', 'closure']            // level 4
        , ['yui', 'closure', 'uglify']  // level 5
      ]
      : [
          ['uglify']                    // level 0, java disabled
      ]
  , css: runtime
      ? [
          ['yui']
      ]
      : [
          ['sqwish']                    // level 0, java disabled
      ]
};
