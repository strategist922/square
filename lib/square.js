'use strict';

/**!
 * [square]
 * @copyright (c) 2012 observe.it (observe.it) <opensource@observe.it>
 * MIT Licensed
 */

/**
 * Native modules.
 */
var EventEmitter = require('events').EventEmitter
  , createHash = require('crypto').createHash
  , util = require('util')
  , path = require('path')
  , fs = require('fs')
  , os = require('os');

/**
 * Third party modules.
 */
var canihaz = require('canihaz')('square')
  , exec = require('shelljs').exec
  , Expires = require('expirable')
  , Logger = require('devnull')
  , async = require('async')
  , eson = require('eson')
  , _ = require('lodash');

/**
 * Super charge the EventEmitters, and sprinkle everything with sugar.
 */
require('sugar');

/**
 * Custom helper libraries.
 */
var preprocess = require('./pre-process')
  , helper = require('./helpers')
  , wrap = require('./wrap');

/**
 * Cached variables to speed up common lookups.
 */
var slice = Array.prototype.slice
  , toString = Object.prototype.toString;

/**
 * Require statement parser for inline includes.
 *
 * @type {RegExp}
 * @api private
 */
var reqparse = /(\/\*|\/\/)\s*\[square\]\s*\@(require|import|include)\s*\"([^"]+)?\"(.*)/i;

/**
 * Square, build system.
 *
 * Options:
 *
 * - env: Environment variables, defaults to 'development'.
 * - reqparse: Regular expression for parsing directives.
 * - logger: A logger instance.
 * - commentStyles: Object with a extension=>comment styles.
 * - home: The location of the users HOME directory
 * - paths: Array of paths that we should search for plugins
 * - distribution: Different type's of distributions that are supported
 * - reqparse: Regular Expression that parses the [square] directives
 * - writable: Are we allowed to write to file
 * - cli: CLI mode
 *
 * @constructor
 * @param {Object} options
 * @api public
 */
var Square = module.exports = function Square(options) {
  // Argument defaults.
  options = options || {};

  // Setup our cache
  this.cache = new Expires('3 minutes');

  // Create a new dev/null logger instance.
  this.logger = new Logger({
      // Turn off timestamps.
      timestamp: false

      // Don't namespace log messages.
    , namespacing: -1

      // Emit notifications starting at debug.
    , notification: 'log notification level' in options
        ? options['log notification level']
        : Logger.levels.debug

      // Only logs with level <= log.
    , level: 'log level' in options
        ? options['log level']
        : Logger.levels.log

      // Do we want to disable the logging base.
    , base: 'disable log transport' in options
        ? !options['disable log transport']
        : true
  });

  // Setup our eson parser, which will pre-parse our configuration files.
  this.eson = eson()
    .use(require('./eson/template').bind(this))
    .use(eson.include)
    .use(eson.bools)
    .use(eson.glob);

  // When the stdout properly is set we need to see if we should enable logging
  // or not.
  Object.defineProperty(this, 'stdout', {
      get: this.getSTDOUT
    , set: this.setSTDOUT
  });

  // The extend should happen after we have set all the Object.define's so they
  // can get triggered once our options are updated.
 _.extend(this, options);

  // These values should never be overridden by the _.extend.
  this.config = require('../static');
  this.middleware = [];
  this.storages = [];
  this.package = {};
};

Square.prototype.__proto__ = EventEmitter.prototype;

/**
 * The current process env.
 *
 * @type {String}
 */
Square.prototype.env = (process.env.NODE_ENV || 'development').toLowerCase();

/**
 * Path to the $HOME directory of the user, so we replace ./~ paths with this
 * value.
 *
 * @type {String}
 */
Square.prototype.home = process.env.HOME || process.env.USERPROFILE;

/**
 * The paths that the .plugin method needs to scan in order to find the correct
 * plugin.
 *
 * @type {Array}
 */
Square.prototype.paths = [
    // Search in our own plugin directory.
    '../plugins'

    // Search in the users current directory's .square folder.
  , path.join(process.env.PWD, '.square')

    // search in the users current directory.
  , process.env.PWD

    // Current node_modules folder.
  , path.join(process.env.PWD, 'node_modules')
];

/**
 * The list of distribution's that we support.
 *
 * @type {Array}
 */
Square.prototype.distributions = [
    // Minified, no comments & crushed.
    'min'

    // Development, fully commented.
  , 'dev'
];

/**
 * Regular Expression for parsing [square] import/require directives.
 *
 * @type {RegExp}
 */
Square.prototype.reqparse = reqparse;

/**
 * Boolean flag so we know if we run as an API or as a CLI application.
 *
 * @type {Boolean}
 */
Square.prototype.cli = false;

/**
 * Boolean flag that indicates if we need output data to stdout.
 *
 * @type {Boolean}
 * @api private
 */
Square.prototype.standardOutput = false;

/**
 * Are we allowed to write the distributions to disk.
 *
 * @type {Boolean}
 */
Square.prototype.writable = true;

/**
 * Small helper object that allows us to wrap files in the correct comment
 * syntax based on the file extension. The key is the file extension and the
 * value is an Object that shows everything should be wrapped.
 *
 * @type {Object}
 */
Square.prototype.commentStyles = require('./comments');

/**
 * Setup our STDOUT get handler.
 *
 * @returns {Boolean}
 * @api private
 */
Square.prototype.getSTDOUT = function getSTDOUT() {
  return this.standardOutput;
};

/**
 * When STDOUT is to true we need to silence our logger, so it doesn't output
 * any information as we will be writing our own data to stdout.
 *
 * @param {Boolean} bool
 * @returns {Boolean}
 * @api private
 */
Square.prototype.setSTDOUT = function setSTDOUT(bool) {
  // Make sure that we output errors and critical information when we are
  // silenced.
  this.logger.set('level', bool ? Logger.levels.error : Logger.levels.log);

  return this.standardOutput = !!bool;
};

/**
 * Middleware layer. Use different middleware layers for compiling your bundles.
 * The order of definition is respected.
 *
 * @param {Function} layer
 * @returns {Boolean} success
 * @api public
 */
Square.prototype.use = function use(layer) {
  if (typeof layer !== 'function') {
    this.logger.error('the supplied middleware isnt a valid function');
    return false;
  }

  // Check if we this middleware is already configured.
  if (this.has(layer)) return false;

  this.middleware.push(layer);
  return true;
};

/**
 * Add a new storage engine.
 *
 * @param {Mixed} engine the engine, or name of the engine
 * @returns {Boolean} success
 * @api public
 */
Square.prototype.storage = function storage(engine) {
  if (typeof engine === 'string') try {
    engine = require('../storage/' + engine);
  } catch(e) {
    return false;
  }

  if (typeof engine !== 'function') {
    this.logger.error('the supplied middleware isnt a valid function');
    return false;
  }

  this.storages.push(engine);
  return true;
};

/**
 * Checks if the middleware layer already exists based on the function name.
 *
 * @param {Function} layer
 * @return {Boolean}
 * @api public
 */
Square.prototype.has = function has(layer) {
  /**
   * Small some function that checks if the supplied middleware is the same as
   * the given middleware layer. This check is done on the contents of the
   * function body and the names of the function.
   *
   * @param {Function} middleware
   * @returns {Boolean}
   * @api private
   */

  return this.middleware.some(function some(middleware) {
    return middleware.toString() === layer.toString()
      && middleware.name === layer.name;
  });
};

/**
 * Load a file from our plugin directory in to our middleware.
 *
 * @param {String} layer name of the plugin
 * @param {Object} options configuration for the plugin
 * @returns {Boolean} success
 * @api public
 */
Square.prototype.plugin = function plugin(layer, options) {
  // Argument defaults.
  options = options || {};

  var configuration = this.package.configuration
    , length = this.paths.length
    , i = 0
    , middleware
    , location;

  if (configuration && configuration.plugins) {
    options = _.extend(configuration.plugins[layer] || {}, options);
  }

  for (; i < length; i++) {
    location = path.join(this.paths[i], '/' + layer);

    try { middleware = require(location); break; }
    catch (e) {
      this.logger.debug('Failed to load plugin %s', location);
    }
  }

  // We didn't find anything, fail, hard, as the user probably really needed
  // this plugin, or he or she wouldn't require it.
  if (!middleware) {
    return this.critical(
        'Unable to load the plugin '
      + layer
      + ', it doesnt exist in any of our paths: '
      + this.paths.join(', ')
    );
  }

  this.use(middleware.call(this, options));
  return true;
};

/**
 * Loop over the plugins/middleware. The collection object should consist of the
 * following key/value pairs:
 *
 * - {String} content, The content that needs to be processed by the middleware.
 * - {String} extension, The extension / file type of the content.
 *
 * @param {Object} collection
 * @param {Function} cb
 * @api public
 */
Square.prototype.forEach = function forEach(collection, cb) {
  var self = this
    , backup = collection;

  async.forEachSeries(
      this.middleware

      /**
       * Process the middleware.
       *
       * @param {Function} layer middleware
       * @param {Function} done callback
       * @api private
       */
    , function iterate(layer, done) {
        function yep(err, result) {
          if (result) backup = collection = result;
          else collection = backup;

          done(err);
        }

        // Capture errors that are thrown in the middleware layers during
        // processing, it won't capture everything for example async errors but
        // that should really be handled by the middleware it self.
        try { layer.call(self, collection, yep); }
        catch (e) { yep(e); }
      }

      /**
       * All the middleware processing has been done.
       *
       * @param {Error} err
       * @api private
       */
    , function finished(err) {
        cb(err || undefined, collection);
      }
  );
};

/**
 * Runs the supplied configuration function only for the set env. This allows
 * you to use different middleware stacks for development and production. You
 * can specify as many environments as you wish. It only requires a callback
 * function as last argument. All other arguments are seen as environment
 * variables where it should be toggled.
 *
 * @param {String} env environment
 * @param {Function} fn callback
 * @api public
 */
Square.prototype.configure = function configure(evn, fn) {
  var envs = 'all'
    , args = slice.call(arguments);

  // Setup the correct argument structure.
  fn = args.pop();

  if (args.length) envs = args;
  if (envs === 'all' || ~envs.indexOf(this.env)) fn.call(this);

  return this;
};

/**
 * Pre-process a single bundle.
 *
 * details.index = index of the file with this extensions
 * details.total = total count of files with this extension
 * details.distribution = distribution type
 *
 * @param {Object} bundle that needs to be processed
 * @param {Object} details
 * @param {Function} cb
 * @api private
 */
Square.prototype.preprocess = function preprocess(bundle, details, fn) {
  var meta = bundle.meta
    , content = ''
    , self = this;

  // We need to some processing steps in order to get the correct content for
  // this bundle:
  //
  //   I: We need to fetch the dependencies of the file, it could be that this
  //      file needs to have a variable file loaded in advance before it can be
  //      pre-processed.
  //
  //  II: When the dependencies are combined we need to pre-process the file
  //      with the square directives to include alternate files.
  //
  // III: Check if this file needs to be pre-processed with a compiler such as
  //      Stylus or CoffeeScript.
  //
  // @TODO We might want to wrap the dependencies in a special comments so we
  // can remove additional content that get's added by the dependencies as they
  // are only ment to be used as content for the pre-processors.

  // Prevent any dependencies to the content so everything can be processed at
  // once by the pre-processor/compiler.
  if (bundle.dependencies && bundle.dependencies.length) {
    content += bundle.dependencies.map(function mapping(key) {
      var prefix = self.commentWrap('[square] dependency: ' + key, meta.extension);

      return prefix + fs.readFileSync(key, 'utf-8');
    }).join('\n');
  }

  // Add the content of the bundle it self.
  content += this.commentWrap('[square] bundle: ' + meta.location, meta.extension);
  content += meta.content;

  // Do some directive processing on the complete variable.
  content = this.directive(content, meta.extension, meta.directory);

  // Check for compilers.
  if (!('compiler' in meta) || !meta.compiler) return fn(undefined, content);

  meta.compiler.call(bundle, content, details, function compiling(err, content) {
    if (err) return fn(err);

    content += self.commentWrap(
        [
            '[square] the code above is compiled from '
            + meta.extension +' to '+ meta.output
          , '[square] see '+ meta.location
        ].join('\n')
      , meta.output
    );

    fn(undefined, content);
  });
};

/**
 * Reduce the dependencies to one single string.
 *
 * @param {String} platform the platform we are compiling (configuration.platforms)
 * @param {Array} extensions list of extensions that we want to build
 * @param {Function} fn callback with object output-extension -> value map
 * @api public
 */
Square.prototype.reduce = function reduce(platform, extensions, fn) {
  var self = this
    , totals
    , count;

  // Create a list of extension as some pre-processors need to know if they are
  // the first to be processed as they might need to add additional content to
  // the code. So these should NOT be a list of extensions that will be outputted
  count = this.package.meta.files.reduce(function counter(memo, file) {
    var extension = path.extname(file).slice(1);

    if (!memo[extension]) memo[extension] = 0;
    memo[extension]++;

    return memo;
  }, {});

  // Keep a snapshot of the counts as totals.
  totals = _.clone(count);

  async.reduce(
      this.package.meta.tree // Files to be looped over.
    , {} // The initial memo value.
    , function reduce(memo, bundle, fn) {
        var extension = bundle.meta.extension
          , output = bundle.meta.output
          , total = totals[extension]
          , details = {
                // calculate the current index of this file starting at 0
                // just like a regular process
                index: total - count[extension]--
              , count: total
              , platform: platform
            };

        // Check if this extension is supported, if it isn't we don't have to do
        // any pre-processing
        if (!~extensions.indexOf(output)) return fn(undefined, memo);

        // Make sure we can easily add the new content by ensuring that we have
        // a placeholder in the memo object
        if (!memo[output]) memo[output] = '';

        self.preprocess(bundle, details, function preprocess(err, content) {
          if (err) return fn(err, memo);

          // Check if we are a JS file, if so we need to check if the content
          // ends on a semi colon or starts with one to prevent concatenation
          // failure.
          if (output === 'js') memo[output] = self.semicolon(memo[output]);

          // Make sure we remove any excessive whitespace from the top & bottom
          memo[output] = (memo[output] + '\n' + content).trim();
          fn(err, memo);
        });
      }
    , fn
  );
};

/**
 * Semi colon appending like a boss.
 *
 * @param {String} content
 * @returns {String}
 * @api private
 */
Square.prototype.semicolon = function semicolon(content) {
  if (!content) return '';

  var char = content.trim().charAt(content.length - 1);

  if (
       content !== ''
    && char
    && char !== ';'
    && (
         char === ')'
      || char === '}'
    )
  ) {
    content = content +';';
  }

  return content;
};

/**
 * Parse the given bundle, this function accepts multiple argument formats.
 *
 * - String, the location of a bundle file.
 * - Object, a pre-json parsed version of the bundle.
 *
 * @param {Mixed} data the stuff that needs to be parse
 * @param {Boolean} parseOnly only parse the data, don't set it
 * @returns {Mixed} boolean if not parseOnly
 * @api public
 */
Square.prototype.parse = function parse(data, parseOnly) {
  if (!this.read(data)) return false;

  // Now that we have read the data, we need to process it so it gets the
  // desired format that we could actually process. We should take the following
  // steps in consideration:
  //
  // - The bundles is an Object and there for we cannot assume it stays in order
  //   in different engines, if a bundle supplied a "weight" key, we should sort
  //   on that. If this key does not exist we will generate one based on the
  //   current index of the bundle.
  //
  // - We should detect if the supplied bundle needs to be pre-processed based
  //   on the current file extension.
  //
  // - A bundle can have "dependencies" that need to be loaded in advanced
  //   before the bundle can be compiled or pre-processed. Once the bundle is
  //   generated it should remove those "dependencies" from the file¬
  //
  // - If the bundles is an array, we should generate bundle objects from them.
  //
  // - The configuration object should be parsed, to ensure that the "dist" key
  //   is actually an object with paths to the correct release types. In
  //   addition to this, we also need to parse the license header.

  var struct = parseOnly ? data : this.package
    , self = this
    , config;

  if (!('configuration' in struct)) struct.configuration = {};
  if (!('bundle' in struct)) struct.bundle = {};

  // Start assembling the square.json from top to bottom, starting at the
  // configuration.
  //
  // Merge the configuration with our defaults so we are sure that all required
  // keys are in place.
  struct.configuration = config = _.extend(
      _.clone(this.config)
    , struct.configuration
  );

  // It's possible that user specified an import section, these should be
  // imported and parsed so we can merge them with the "bundle" key later on.
  if (Array.isArray(config.import)) {
    struct.configuration.import = config.import.map(function importer(path) {
      // We need to call parse recursively as imported files.
      var structure = self.parse(path, true);

      // If we failed to parse it, return an empty object.
      if (!structure || !('bundle' in structure)) return {};
      return structure.bundle;
    });
  }

  // Parse a potential license header that was specified in the configuration
  // section.
  if ('license' in config) {
    config.license = helper.base(config.license, struct.path);

    // Do we actually have a configuration file that we could add here?
    if (!fs.existsSync(config.license)) {
      this.logger.error(
          'Hmz, you added a license to your configuration but % doesnt exist'
        , config.license
      );

      // Remove that shizzle
      delete struct.configuration.license;
    } else {
      struct.configuration.license = fs.readFileSync(config.license, 'utf8');
    }
  }

  // Check if we need to unfold the "dist" key to a regular object with all
  // supported distribution types.
  if (typeof config.dist === 'string') {
    struct.configuration.dist = this.distributions.reduce(function build(memo, dist) {
      memo[dist] = config.dist;

      return memo;
    }, {});
  }

  // Now that all possible configuration options have been parsed we are going
  // to process the heart of the square.json files, the bundles. First we need
  // to check if it's not an array as it could been called using an glob.
  if (Array.isArray(struct.bundle)) {
    struct.bundle = struct.bundle.reduce(function bundle(memo, file, index) {
      memo[file] = self.createBundle(file, index);
    }, {});
  }

  // We are sure that we have a bundle as an object we can merge in any
  // potential configuration.import bundles and merge it with our current bundle
  // structure.
  if ('import' in struct.configuration) {
    _.extend(struct.bundle, struct.configuration.import);
  }

  // Setup a tree that we are going to use to put the bundled dependencies in
  // order.
  var tree = []
    , files = []
    , extensions = {}
    , dependencies = []
    , size = Object.keys(struct.bundle).length;

  // Every possible way of adding bundles to the structure has been handled,
  // time to process the bundle.
  _.forEach(struct.bundle, function forEach(bundle, location) {
    // Create some meta information about the bundle that we use to actually
    // process the content. Please note that we have to extend the bundle to
    // make sure that all references of keys => values stay up to date all the
    // time.
    bundle.meta = bundle.meta || {};
    _.extend(bundle.meta, self.createMeta.call(struct, bundle, location));

    // Make sure that everything is correct and that all files have been
    // specified correctly. Only test the `bundle.meta.location` as that has
    // been parsed and points to the correct location
    if (!fs.existsSync(bundle.meta.location)) {
      return self.critical(
          'Duuuude wtf, you specified bundle %s, but that file doesnt exist'
        , bundle.meta.location
      );
    }

    // Added the file to the files array.
    files.push(bundle.meta.location);

    // Add a weight so we can sort our bundles.
    bundle.weight = helper.weight(+bundle.weight || 1, size--);

    // We need to maintain a mapping of the files to extensions so we can build
    var output = bundle.meta.output;
    if (!extensions[output]) extensions[output] = [];
    extensions[output].push(location);

    // Check to see if the bundle has any dependencies that need to be loaded in
    // advanced and removed after compiling.
    if ('dependencies' in bundle) {
      if (Array.isArray(bundle.dependencies)) {
        bundle.dependencies = bundle.dependencies.map(function map(dep) {
          dep = path.resolve(helper.base(dep, struct.path));

          if (!fs.existsSync(dep)) {
            return self.critical(
                'Derp! The dependency %s in doesnt exit in the %s bundle'
              , dep
              , location
            );
          }

          // Added the file to the dependencies array.
          dependencies.push(dep);
          return dep;
        });
      } else {
        self.logger.error(
            'The `dependencies` prop on the %s bundle should be an array'
          , location
        );
      }
    }

    // All transformation have been done, push it to the dependencies tree.
    tree.push(bundle);
  });

  // Now that the bundles have been parsed we need to establish an dependency
  // order.
  tree = tree.sort(function sort(a, b) {
    return b.weight - a.weight;
  });

  // Create the some generated meta data about the package which can be used by
  // other pieces of square.
  struct.meta = {
      tree: tree                  // sorted list of files
    , files: files                // list of files inside the bundle
    , dependencies: dependencies  // list of all the dependencies
    , extensions: extensions      // object extension=>array of files
  };

  // If we are in parse only mode we should return the parsed structure instead
  // of setting the structure as this.package and returning a `boolean`.
  if (parseOnly) return struct;
  this.package = struct;

  return true;
};

/**
 * Refresh the contents and the details of a bundle as it has been changed.
 *
 * @param {Object} bundle
 * @param {String} key
 * @returns {Object} bundle
 * @api public
 */
Square.prototype.createMeta = function createMeta(bundle, key) {
  key = key || bundle.meta.key;

  // Get the directory of where we read out the square.json file.
  var directory = this.path
    , location = helper.base(key, directory)
    , extension = path.extname(key).slice(1)
    , compiler = preprocess[extension]
    , output = extension
    , as = bundle.as;

  // Figure out the output extension of the bundle as files that need to be
  // pre-processed start out with a different extension. Some compilers support
  // multiple output types.. So we need to make sure we get the correct one.
  if (compiler) {
    // Make sure that the 'as' extension really exists
    if (~compiler.extensions.indexOf(as)) output = as;
    else output = compiler.extensions.shift();
  }

  return {
      // Add some details about the file.
      content: fs.existsSync(location) ? fs.readFileSync(location, 'utf-8') : ''
    , extension: extension
    , output: output
    , compiler: compiler

      // Some information about the file location and how to get there :)
    , key: key
    , location: location
    , directory: path.dirname(location)
    , filename: path.basename(key)
  };
};

/**
 * Creates a new bundle compatible object from a file.
 *
 * @param {String} location the path to the file that needs to be converted
 * @param {Number} index file so we can generate an weight
 * @returns {Object} bundle
 * @api public
 */
Square.prototype.createBundle = function createBundle(path, index) {
  return {
      description: 'This file description has been generated by [square]'
    , weight: +index || (
        // If there is no weight established then try to generate a weight based
        // on the items in the Object. Assuming every file in there is added in
        // order, this should generate the correct weight.
        this.package.bundle && !Array.isArray(this.package.bundle)
          ? Object.keys(this.package.bundle).length
          : 1
      )
  };
};

/**
 * Read in the possible square.json file and parse it to a JavaScript object.
 *
 * Args:
 * - string, path to a square.json configuration file
 * - object, square.json configuration object
 *
 * @param {Mixed} args
 * @returns {Boolean} successful reading
 * @api private
 */
Square.prototype.read = function read(args, readOnly) {
  args = [args].reduce(function reduce(memory, arg) {
    var type = /\[object (\w+)\]/.exec(toString.call(arg).toLowerCase())[1];

    memory[type] = arg;
    return memory;
  }, {});

  var structure = {}
    , extension
    , exists;

  // Check to see if we actually need to override the current structure.
  if (!readOnly) this.package = structure;

  try {
    // Assume that we where called with a string, which is a path to a file that
    // follows our square.json specification.
    if (args.string) {
      // Get the extension, so we know what type of file we are dealing with
      // here..
      extension = path.extname(args.string);
      exists = fs.existsSync(args.string);

      // If the file doesn't exist, it could be that they forgot to append .json
      // to the file name, so do a check for that..
      if (!exists && fs.existsSync(args.string + '.json')) {
        args.string = args.string + '.json';
        extension = '.json';
        exists = true;
      }

      // It doesn't exist, bail out.
      if (!exists) {
        return this.critical('Failed to parse bundle, %s does not exist ', args.string);
      }

      // Handle node.js styled requires.
      if (extension === '.js') {
        structure = require(args.string);
        args.package = JSON.stringify(structure);
      } else {
        structure = this.fromJSON(args.string);
        args.package = fs.readFileSync(args.string, 'utf8');
      }

      // Apply extra JSON transformation that are done by eson, such as file
      // glob's, JSON includes etc, we need to se the eson.path correctly each
      // time we use it as it's used by the include plugin.
      this.eson.path = args.string;
      structure = this.eson.parse(structure);

      // Folder of the bundle.
      structure.path = structure.path || path.dirname(args.string);

      // Location of the bundle.
      structure.location = structure.location || args.string;

      // Stringified content.
      structure.source = args.package;
    } else if (args.object) {
      structure = args.object;
      args.package = JSON.stringify(structure);

      // Apply extra JSON transformation that are done by eson, such as file
      // glob's, JSON includes etc.
      this.eson.path = process.env.PWD;
      structure = this.eson.parse(args.package);

      // Folder of the bundle.
      structure.path = structure.path || path.dirname(process.env.PWD);

      // Location of the bundle.
      structure.location = structure.location || process.env.PWD;

      // Stringified content.
      structure.source = args.package;
    } else {
      return this.critical('Unsupported bundled');
    }
  } catch (e) {
    return this.critical('Failed to parse the bundle', e.stack);
  }

  if (readOnly) return structure;
  this.package = structure;

  return true;
};

/**
 * Parse commented JSON. The following comment formats are supported:
 *
 * - `// comment` single line comments.
 * - `/ * comment` multi line comments.
 *
 * @param {String} location
 * @returns {Mixed} Error if it fails to parse the JSON
 * @api public
 */
Square.prototype.fromJSON = function fromJSON(location) {
  if (!location || !fs.existsSync(location)) return {};

  var cleaned = fs.readFileSync(location, 'utf8')
    // Removes /* comments */
    .replace(/\*([^*]|[\r\n]|(\*+([^*\/]|[\r\n])))*\*+/g, '')
    // Removes // comments
    .replace(/\/\/[^\n\r]*/g, '');

  // Return the parsed instance.
  try { return JSON.parse(cleaned); }
  catch (e) { return new Error('Failed to parse JSON: ' + cleaned); }
};

/**
 * Output a critical error shutdown the process.
 *
 * @param {String}
 * @returns {Boolean}
 * @api public
 */
Square.prototype.critical = function critical(message) {
  this.logger.critical.apply(this.logger, arguments);

  // Format the message.
  message = util.format.apply(util, arguments);

  if (!this.cli) {
    this.emit('error', new Error(message));
    return false;
  }

  // Output some useful debugging information.
  this.logger.info('');
  this.logger.info('Additional information:');
  this.logger.info('');
  this.logger.info('- Square version:         %s',  this.version);
  this.logger.info('- Node.js version:        %s',  process.version);
  this.logger.info(
      '- System information:     %s, %s (%s)'
    , os.type()     // Operating system name.
    , os.release()  // Operating system release.
    , process.arch  // Processor architecture.
  );
  this.logger.info('- Issued command:         %s', process.argv.join(' '));
  this.logger.info('- Current Working Dir:    %s', process.cwd());
  this.logger.info('');
  this.logger.info('If your square.json file has been created according the docs.');
  this.logger.info('Then please log this error in our bug tracker: github.com/observing/square');
  this.logger.info('or report it in our irc channel: irc.freenode.net#observing');

  process.exit(1);
  return false;
};

/**
 * Refresh the contents of a file.
 *
 * @param {Array} files
 * @api public
 */
Square.prototype.refresh = function refresh(files) {
  var bundle = this.package.bundle
    , extensions = {}
    , changes = []
    , self = this;

  Object.keys(bundle).forEach(function find(file) {
    var meta = bundle[file].meta
      , match = files.some(function some (file) {
          var location = path.resolve(meta.location);

          return file === location || ~location.indexOf(file);
        });

    if (!match) return;

    // There can be some sort of edge case where the file that we want to have
    // is actually removed & added again from the disk by certain IDE's. So to
    // get around this limitation we need to check if it's there, or just while
    // loop until it's found again :D
    if (!fs.existsSync(meta.location)) {
      while (!fs.existsSync(meta.location)) {
        // Freeze the event loop, lol ;$
      }
    }

    self.package.bundle[file].content = fs.readFileSync(meta.location, 'utf8');

    // Add the file extension to the extensions list so we can create
    // a dedicated rebuild.
    extensions[meta.extension] = true;
    changes.push(file);
  });

  if (!changes.length) return;

  // Trigger a new build from the given extensions.
  this.emit('changed', _.unique(changes));
  this.build(_.unique(extensions));
};

/**
 * Processes the [square] directive comments that might be found inside the
 * files.
 *
 * @param {String} data content that needs to be scanned
 * @param {String} extension file extension
 * @param {String} reference the directory of the file
 * @param {Array|Undefined} seen array of files that the directive has seen
 * @returns {String}
 * @api public
 */
Square.prototype.directive = function directive(data, extension, reference, seen) {
  seen = seen || [];
  reference = reference || this.package.path;

  var self = this
    , assemble = [];

  /**
   * Process the directive.
   *
   * @param {String} match complete matched result
   * @param {String} commenttype type of comment
   * @param {String} statement import statement name
   * @param {String} file the file that needs to be inlined
   * @returns {String}
   * @api private
   */
  function insert(match, commenttype, statement, file) {
    var location = path.resolve(reference, file)
      , data = '';

    if (!fs.existsSync(location)) {
      return self.critical('[square] @%s statement %s does not exist', statement, file);
    }

    if (~seen.indexOf(location)) {
      return self.critical('recursive [square] import statement detected %s', match);
    }

    // We processed the file, mark it as seen to protect us against recursive
    // includes.
    seen.push(location);

    data += self.commentWrap('[square] directive: ' + location, extension);
    data += fs.readFileSync(location, 'utf8').trim();

    // Pass the contents back in to the directive again so we can also process
    // the directives inside the directive.
    return self.directive(data, extension, path.dirname(location), seen);
  }

  /**
   * Find the previous line that contains content, ignoring whitespace and
   * newlines.
   *
   * @param {Number} index
   * @param {Array} lines
   * @returns {Object}
   */
  function prev(index, lines) {
    while (index--) {
      var line = lines[index].trim();

      if (line && !/^(\/\/|\/\*)/.test(line)) {
        return { line: line, index: index };
      }
    }

    return {};
  }

  // Start scanning each line of the file to possible directive's. Normally you
  // would just use Array#map for this, but we actually need to modify previous
  // lines which is not possible during a reduce.
  data.split(/\n|\r/g).forEach(function scan(line, index, lines) {
    if (self.reqparse.test(line)) {

      // Check if we need to prepend a semicolon to prevent potential
      // concatenation failures.
      var last = prev(index--, assemble)
        , content = line.replace(self.reqparse, insert);

      if (
          extension === 'js'
        && last.line
        && last.line.charAt(last.line.length - 1) !== ';'
        && content
        && content.charAt(0) !== ';'
      ) {
        // Modify the line that is missing a semicolon.
        assemble[last.index] = last.line + ';';
      }

      return assemble.push(content);
    }

    return assemble.push(line);
  });

  return assemble.join('\n').trim();
};

/**
 * Build the stuff. The callback Xmas tree that assembles all the things!
 *
 * @param {Array} extensions
 * @param {Function} fn
 * @api public
 */
Square.prototype.build = function build(platform, extensions, fn) {
  var args = slice.call(arguments).reduce(function reduce (memory, arg) {
        memory[Array.isArray(arg) ? 'array' : typeof arg] = arg;
        return memory;
      }, {})
    , self = this;

  /**
   * Reduced receives the result from the square#reduce. The result object is
   * a concatenated result of all the dependencies.
   *
   * @param {Error} err optional error argument
   * @param {Object} result
   * @api private
   */
  function reduced(err, result) {
    if (err) return done(err);

    var collections = _.map(result, function each(content, extension) {
      // Again, add a semicolon because minifiers could strip the last
      // semi-colon as it would reduce the portablity of the generated code
      if (extension === 'js') content = self.semicolon(content);

      // Generate a collection object that is passed in to each middleware
      // layer. These objects should always have a content and extension key.
      return {
          extension: extension
        , content: content
        , platform: platform
        , distribution: 'min'
      };
    });

    // @TODO make sure we also handle .dev builds, not only .min
    self.logger.debug('iterating over the plugin middleware');
    async.map(collections, self.forEach.bind(self), writer);
  }

  /**
   * Write the processed collections to disk.
   *
   * @param {Error} err
   * @param {Array} collections
   */
  function writer(err, collections) {
    if (err) return done(err);

    // @TODO make sure that self.write only accepts 2 arguments and reads the
    // type from the supplied collection object.
    self.logger.debug('writing files');
    async.map(collections, self.write.bind(self), done);
  }

  /**
   * Callback function for when the build is finished.
   *
   * @param {Error} err
   */
  function done(err, files) {
    // Stop our cache, it will be activated again when we need it
    self.cache.stop();

    // Merge the results array to a key=>value object
    files = (files || []).reduce(function reduceFiles(memo, collection) {
      memo[collection.basename] = collection;
      return memo;
    }, {});

    if (err && !args.function) self.critical(err);
    if (args.function) args.function.call(self, err, files);

    // Emit that we are ready.
    self.logger.info('successfully generated %s', Object.keys(files).join(', '));
    self.emit('build', files);
  }

  // Make sure that we actually have parsed package file that we can build
  if (!('configuration' in this.package)) {
    throw new Error('Dont build before you parse a configuration file');
  }

  // Arguments mapping, as we don't want to give a fuck about the arguments you
  // supply to this biatch
  platform = args.string || 'web';
  extensions = args.array && args.array.length
    ? args.array
    : Object.keys(this.package.meta.extensions);

  // @TODO loop over all platforms we are building against.
  this.cache.start();

  this.reduce(platform, extensions, reduced);
  this.logger.debug(
      'generating a new build, platform: %s, extensions: %s'
    , platform
    , extensions
  );
};

/**
 * Check if we are running an out of date build of square. Because users are not
 * actively checking if their binary is up to date and will be missing out on
 * critical bug fixes and feature releases.
 *
 * @param {Boolean} random should we do a random check
 * @param {String} branch optional branch
 * @api public
 */
Square.prototype.outofdate = function outofdate(random, branch) {
  // Allow users to cancel our update check.
  if (this.package.configuration && this.package.configuration.noupdate) return this;

  var luckynumber = Math.floor(Math.random() * 11)
    , url = 'https://raw.github.com/observing/square/'
      + (branch || 'master')
      + '/package.json'
    , self = this;

  // Rate limit the amount of checks that we are allowed to do, we don't want to
  // check github for every invocation of square.
  if (random && luckynumber !== 7) return this;

  canihaz.request(function lazyload(err, request) {
    if (err) return;

    request({ uri: url }, function done(err, res, body) {
      var latest;

      // No need to do error handling here.. If there was an error, we can't
      // probably parse JSON anyways and it will just die inside the JSON.parse.
      try { latest = JSON.parse(body.toString('utf8')).version; }
      catch (e) { return; }

      if (latest && latest !== self.version) {
        self.emit('outofdate', latest, self.version);
      }
    });
  });

  return this;
};

/**
 * Process the template string.
 *
 * @param {String} str
 * @param {Object} data
 * @returns {String} result
 * @api public
 */
Square.prototype.template = function template(str, data) {
  data = data || this.tag();

  /**
   * Small helper function that allows you get a key from an object by
   * specifying it's depth using dot notations.
   *
   * Example:
   *
   * - path.to.0.keys
   * - key.depth
   *
   * @param {Ojbect|Array} data
   * @param {String} prop
   * @returns {Mixed}
   * @api private
   */
  function getObjectByKey(data, prop) {
    if (!prop || !~prop.indexOf('.')) return data[prop];

    var result = prop
      , structure = data;

    for (var paths = prop.split('.'), i = 0, length = paths.length; i < length; i++) {
      result = structure[+paths[i] || paths[i]];
      structure = result;
    }

    return result || data[prop];
  }

  return str.replace(/\{([^\{]+?)\}/g, function replace(tag, prop) {
    return getObjectByKey(data, prop) || '';
  });
};

/**
 * Creates a tag / profile from the content so it can be used for processing.
 *
 * @param {Object} collection
 * @returns {Object}
 * @api public
 */
Square.prototype.tag = function tag(collection) {
  collection = collection || {};

  var configuration = this.package.configuration || {}
    , tags = _.extend(collection, configuration.tags || {})
    , branch = this.cache.get('git branch', true)
    , sha = this.cache.get('git show', true)
    , date = new Date();

  if (!this.cache.has('git branch')) {
    branch = this.cache.set('git branch', exec('git branch', { silent: true }).output);
  }

  if (!this.cache.has('git show')) {
    sha = this.cache.set('git show', exec('git show -s', { silent: true }).output);
  }

  if (branch) {
    branch = /\*\s([\w\.]+)/g.exec(branch) || '';
    branch = branch.length ? branch[1] : branch;
  }

  if (sha) {
    sha = /commit\s(\w+)/g.exec(sha) || '';
    sha = sha.length ? sha[1] : sha;
  }

  return _.extend({ type: 'min' }, {
      md5: createHash('md5').update(collection.content || '').digest('hex')
    , branch: branch
    , sha: sha
    , ext: collection.extension || 'js'
    , date: date.toLocaleDateString()
    , year: date.getFullYear()
    , user: process.env.USER || 'anonymous'
    , host: os.hostname()
    , env: this.env
  }, tags);
};

/**
 * Write the output of the file to a directory. Collection contains the
 * following keys:
 *
 *  content: Processed file contents.
 *  extension: File extension.
 *  group: Group name of current file.
 *
 * @param {Object} collection
 * @param {String} extension
 * @param {Function} fn
 * @api public
 */
Square.prototype.write = function write(collection, fn) {
  // Extend the collection with information from the tag
  _.extend(collection, this.tag.apply(this, arguments));

  // Process the file based output.
  var configuration = this.package.configuration
    , output = configuration.dist[collection.distribution].replace(/^~/g, this.home)
    , file = this.template(output, collection)
    , base = path.basename(file)
    , self = this;

  // Make sure that the file is saved relative to the location of the
  // square.json file instead of the current directory of where the command is
  // executed.
  file = helper.base(file, this.package.path);

  // Add the generated file name information back to the collection
  collection.file = file;
  collection.basename = base;

  // Add a license to the file if needed.
  collection.content = this.license.apply(this, arguments);

  /**
   * Simple finish function to ensure that we always call our callback when it's
   * supplied. No matter what kind of write we need to perform.
   *
   * @param {Error} err optional error
   */
  function finished(err) {
    if (err) self.critical('failed to store ' + base, err);
    if (fn) fn(err, collection);
  }

  // Decide how we should output the file, do we need to write it disk, write it
  // to STDOUT or maybe we should just emit this.
  if (this.stdout) {
    process.nextTick(finished);
  } else if(this.env === 'testing' && collection.content) {
    this.logger.info('Not actually writing %s, we are running in test env', file);
    process.nextTick(finished);
  } else if (this.writable && collection.content) {
    async.parallel(
      this.storages.map(function storage(engine) {
        return engine.bind(engine, self, collection);
      }), finished);
  } else {
    process.nextTick(finished);
  }
};

/**
 * Check if we need to prepend a license file.
 *
 * @param {Object} collection
 * @returns {String}
 * @api public
 */
Square.prototype.license = function copyright(collection) {
  var configuration = this.package.configuration
    , license = configuration.license;

  if (!license) return collection.content || '';
  if (!collection.content) return '';

  // Process the template with some variables.
  license = this.template(license, this.tag.apply(this, arguments));
  return this.commentWrap(license, collection.extension) + collection.content;
};

/**
 * Wraps a line/lines in the correct comment format and returns the updated
 * string.
 *
 * @param {String} data
 * @param {String} extension
 * @returns {String}
 * @api public
 */
Square.prototype.commentWrap = function commentWrap(data, extension) {
  var style = this.commentStyles.ext[extension] || this.commentStyles.styles[extension];

  // Discard the comment if we don't have a suitable type.
  if (!style) return '';

  return data.split(/[\n|\r]/g).map(function mapping(line, index, lines) {
    var header = index === 0
      , footer = (index + 1) === lines.length;

    // Single line comment.
    if (header && footer) {
      return '\n' + style.header + ' ' + line + style.footer + '\n';
    }

    // Multi line comments.
    if (header) return '\n' + style.header + '\n' + style.body + ' ' + line;
    if (footer) return style.body + ' ' + line + '\n' + style.footer + '\n';

    return style.body + ' ' + line;
  }).join('\n');
};

/**
 * Expose the current version.
 *
 * @type {String}
 */
Square.prototype.version = Square.version = require('../package.json').version;

/**
 * Make square extendible, just like you are used to with Backbone.js
 * constructors.
 *
 * @type {Function}
 */
Square.extend = require('extendable');

/**
 * Extend square with some modules that don't really belong in the "core" of
 * square or that are to bloated that it needs to be loaded from a separated
 * file.
 *
 * @param {Object} proto with new prototypes
 * @returns {Square}
 * @api public
 */
Square.load = function loader(proto) {
  _.extend(Square.prototype, proto);

  return Square;
};

/**
 * Get a list of all available plugin and their descriptions.
 *
 * @returns {Array} list of plugins
 */
Square.plugins = function plugins() {
  var directory = path.join(__dirname, '../plugins');

  return fs.readdirSync(directory).filter(function filter(file) {
    // Remove all pointless garbage from the directory, as we only care about
    // about the JavaScript files.
    return (/\.js$/).test(file);
  }).map(function map(file) {
    var plugin = require(directory +'/'+ file);

    return {
        path: directory +'/'+ file
      , name: file.replace(/\.js$/, '')
      , plugin: plugin
      , filename: file
      , description: plugin.description || ''
    };
  });
};

/**
 * Start the CLI interface for Square.
 *
 * @param {Array} args arguments to be used for cli, defaults to process.argv
 * @returns {Commander} the used cli interface
 * @api public
 */
Square.cli = function cli(args) {
  return require('./cli')(args || process.argv);
};
