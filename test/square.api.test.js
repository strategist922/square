/*global expect, Square, execSync */
describe('[square] API', function () {
  "use strict";

  /**
   * The location of our testing fixtures.
   *
   * @type {String}
   */
  var fixtures = require('path').join(process.env.PWD, 'test/fixtures');

  /**
   * Simple dummy function that is used for testing.
   *
   * @api private
   */
  function noop() { console.log(/* dummy function*/); }

  it('exposes the current version number', function () {
    expect(Square.version).to.match(/^\d+\.\d+\.\d+$/);
    expect(Square.version).to.eql(require('../package.json').version);
  });

  describe('.extend', function () {
    it('should extend the Square.prototype', function () {
      expect(Square.prototype.cowsack).to.be.an('undefined');

      Square.extend({
          cowsack: function () {}
      });

      expect(Square.prototype.cowsack).to.be.an('function');
      delete Square.prototype.cowsack;
    });

    it('should override existing prototypes', function () {
      var backup = Square.prototype.configure;
      expect(Square.prototype.configure).to.be.an('function');

      Square.extend({
          configure: noop
      });

      expect(Square.prototype.configure).to.equal(noop);
      Square.prototype.configure = backup;
    });
  });

  describe('@construction', function () {
    it('should construct without any errors', function () {
      var square = new Square();
    });

    it('should be configured using the options parameter', function () {
      var square = new Square();
      expect(square.env).to.not.equal('whoopwhoop');

      var square2 = new Square({ env: 'whoopwhoop' });
      expect(square2.env).to.equal('whoopwhoop');
    });

    it('should not override private properties', function () {
      var privates = {
              middleware: 'pewpew'
            , config: 'pewpew'
            , package: 'pewpew'
          }
        , square = new Square(privates);

      Object.keys(privates).forEach(function (key) {
        expect(square[key]).to.not.equal(privates[key]);
      });
    });

    it('should silence the logger when stdout option is changed', function () {
      var square = new Square({ stdout: true });
      expect(square.logger.level).to.equal(-1);

      square.stdout = false;
      expect(square.logger.level).to.be.above(-1);
    });

    it('should set the correct env based on NODE_ENV', function () {
      var square = new Square();
      expect(square.env).to.equal('testing');
    });

    it('should find the correct $HOME directory', function () {
      // @TODO make this test pass on non unix platforms, as pwd and cd ~/ will
      // probably output something else on windows ;)
      var home = execSync('cd ~/ && pwd', { silent: true }).output.replace('\n', '');

      var square = new Square();
      expect(square.home).to.equal(home);
    });

    it('should be able to configure the logger', function () {
      var square = new Square({
          'log notification level': 1337
        , 'log level': 7331
        , 'disable log transport': true
      });

      expect(square.logger.level).to.equal(7331);
      expect(square.logger.notification).to.equal(1337);
      expect(square.logger.transports).to.have.length(0);
    });
  });

  describe('#has', function () {
    it('should find duplicate plugins', function () {
      var square = new Square();

      square.middleware.push(noop);
      expect(square.has(noop)).to.equal(true);
    });

    it('shouldnt find non-existing plugins', function () {
      var square = new Square();
      expect(square.has(noop)).to.equal(false);
    });
  });

  describe('#use', function () {
    it('should only accept functions', function (done) {
      var square = new Square({ 'disable log transport': true });

      // assure that there is a small possibility that an event emitter can
      // execute async.. if this is not the case, we wrapped it in a tick
      square.logger.on('error', function (args, stack) {
        expect(args[0]).to.have.string('function');

        process.nextTick(done);
      });

      expect(square.use('string')).to.equal(false);
      expect(square.middleware).to.have.length(0);
    });

    it('should not add duplicate plugins', function () {
      var square = new Square();
      expect(square.middleware).to.have.length(0);

      expect(square.use(noop)).to.equal(true);
      expect(square.middleware).to.have.length(1);

      // silent failure
      expect(square.use(noop)).to.equal(false);
      expect(square.middleware).to.have.length(1);
    });
  });

  describe('#plugin', function () {
    it('should require the given plugin by name', function () {
      var square = new Square();

      expect(square.plugin('lint')).to.equal(true);
      expect(square.middleware).to.have.length(1);
    });

    it('should for the plugin in multiple locations', function () {
      var square = new Square({ 'disable log transport': true });
      square.on('error', noop); // throws an error other wise

      expect(square.plugin('plugin.fixture')).to.equal(false);

      // add the fixtures directory as possible option to search for plugins
      var square2 = new Square({ 'disable log transport': true });
      square2.paths.push(fixtures);

      expect(square2.plugin('plugin.fixture')).to.equal(true);
      expect(square2.middleware).to.have.length(1);
    });

    it('should do the first initialization step of the plugin', function (done) {
      var square = new Square({ 'disable log transport': true });
      square.paths.push(fixtures);

      square.on('plugin.fixture:init', function () {
        done();
      });

      square.plugin('plugin.fixture');
    });

    it('should proxy the configuration to the plugin', function (done) {
      var square = new Square({ 'disable log transport': true });
      square.paths.push(fixtures);

      square.on('plugin.fixture:init', function (pluginoptions) {
        expect(pluginoptions).to.equal(options);
        done();
      });

      var options = { foo: 'bar' };
      square.plugin('plugin.fixture', options);
    });

    it('should merge the configuration with the supplied options', function (done) {
      var square = new Square();
      square.paths.push(fixtures);
      square.package = {
          configuration: {
              plugins: {
                  'plugin.fixture': {
                      foo: 'bar'
                    , bar: 'foo'
                    , baz: 'afdasfas'
                  }
              }
          }
      };

      square.on('plugin.fixture:init', function (pluginoptions) {
        expect(pluginoptions).to.have.property('foo', 'choochoo');
        expect(pluginoptions).to.have.property('bar', 'foo');
        expect(pluginoptions).to.have.property('baz', 'afdasfas');

        done();
      });

      var options = { foo: 'choochoo' };
      square.plugin('plugin.fixture', options);
    });

    it('should log an critical error when it fails', function (done) {
      var square = new Square({ 'disable log transport': true });
      square.on('error', noop); // throws an error other wise

      square.logger.on('critical', function (args) {
        expect(args[0]).to.have.string('plugin');
        done();
      });

      expect(square.plugin('plugin.fixture' + Math.random())).to.equal(false);
    });
  });

  describe('#configure', function () {
    it('should call the function if no evn variable is given', function (done) {
      var square = new Square();

      square.configure(done);
    });

    it('should not execute the function if the env doesnt match', function () {
      var square = new Square()
        , execution = 0;

      square.configure('trololol', function () {
        execution++;
      });

      expect(execution).to.equal(0);
    });

    it('should execute the function on evn match', function (done) {
      var square = new Square();

      square.configure('testing', done);
    });

    it('should execute with the correct function context', function () {
      var square = new Square();

      square.on('configure', function () {
        expect(this).to.equal(square);
      });
    });
  });

  describe('#forEach', function () {
    it('should iterate over all plugins in the correct order', function (done) {
      var square = new Square({ 'disable log transport': true })
        , ids = [];

      square.paths.push(fixtures);

      square.plugin('plugin.fixture', { 'unique-id': 12 });
      square.middleware.push(
        require(fixtures + '/plugin.fixture').call(square, { 'unique-id': 13})
      );

      square.on('plugin.fixture:id', function (id) {
        ids.push(id);
      });

      square.forEach({ content: '', extension: 'js' }, function (err, collection) {
        expect(collection.content).to.equal('');
        expect(collection.extension).to.equal('js');
        expect(ids.join(',')).to.equal('12,13');

        done(err);
      });
    });

    it('should catch errors generated by the plugins', function (done) {
      var square = new Square({ 'disable log transport': true });
      square.paths.push(fixtures);

      // configure our plugin to throw errors
      square.plugin('plugin.fixture', { 'throw': true });
      square.forEach({ content: '', extension: 'js'}, function (err, collection) {
        expect(err).to.be.an.instanceof(Error);
        expect(err.message).to.equal('throwing an error');
        expect(collection).to.be.a('object');

        done();
      });
    });

    it('should handle plugins that doesnst return content', function (done) {
      var square = new Square({ 'disable log transport': true });
      square.paths.push(fixtures);

      // configure our plugin to throw errors
      square.plugin('plugin.fixture', { 'no-content': true });
      square.forEach({ content: 'oi', extension: 'js'}, function (err, collection) {
        expect(collection.content).to.equal('oi');
        expect(collection.extension).to.equal('js');

        done(err);
      });
    });

    it('should callback with the error when things breaks', function (done) {
      var square = new Square({ 'disable log transport': true });
      square.paths.push(fixtures);

      // configure our plugin to throw errors
      square.plugin('plugin.fixture', { 'error-argument': true });
      square.forEach({ content: '', extension: 'js'}, function (err, collection) {
        expect(err).to.be.an.instanceof(Error);
        expect(err.message).to.equal('error argument');
        expect(collection).to.be.a('object');

        done();
      });
    });

    it('should callback the newly generated collection', function (done) {
      var square = new Square({ 'disable log transport': true });
      square.paths.push(fixtures);

      // configure our plugin to throw errors
      square.plugin('plugin.fixture', { 'change-content': true });
      square.forEach({ content: '', extension: 'js'}, function (err, collection) {
        expect(collection.content).to.equal('changed the content');
        expect(collection.extension).to.equal('js');

        done(err);
      });
    });
  });

  describe('#preprocess', function () {
    it('should add debugging comments for each included file');

    it('should add the bundles dependencies');

    it('should process the [square] comment directives');

    it('should process the content with an compiler');

    it('should process the content without any compiler');
  });

  describe('#parse', function () {
    it('should parse .json strings');

    it('should parse .js strings');

    it('should parse objects');

    it('should parse configuration.import');

    it('should parse configuration.import recursively');

    it('should sort the bundles based on weight');

    it('should create a bundle.meta for each supplied bundle');

    it('should return true when it parses correctly');

    it('should return false when it fails to parse');
  });

  describe('#read', function () {
    it('should read .json files', function () {
      var square = new Square();

      expect(square.read(fixtures + '/read/test.json')).to.equal(true);
      expect(square.package).to.be.a('object');
      expect(square.package.configuration).to.be.a('object');
      expect(square.package.bundle).to.be.a('object');
    });

    it('should require .js files', function () {
      var square = new Square();

      expect(square.read(fixtures + '/read/test.js')).to.equal(true);
      expect(square.package).to.be.a('object');
      expect(square.package.configuration).to.be.a('object');
      expect(square.package.bundle).to.be.a('object');
    });

    it('should also read objects', function () {
      var square = new Square();

      var structure = { configuration: {}, bundle: {} };

      expect(square.read(structure)).to.equal(true);
      expect(square.package).to.be.a('object');
      expect(square.package.configuration).to.be.a('object');
      expect(square.package.bundle).to.be.a('object');
    });

    it('should return false when it fails to read the file', function (done) {
      var square = new Square();

      // we need to assign an error handler and failing to read a json file is
      // a critical error
      square.on('error', function (err) {
        expect(err).to.be.instanceof(Error);
        expect(err.message).to.contain('Failed');

        done();
      });

      expect(square.read(fixtures + '/wtftrololol.json')).to.equal(false);
    });

    it('should generate inclusion details', function () {
      var square = new Square()
        , source = require('fs').readFileSync(fixtures + '/read/test.json', 'utf8');

      expect(square.read(fixtures + '/read/test.json')).to.equal(true);

      // simple tests
      expect(square.package.path).to.be.a('string');
      expect(square.package.source).to.be.a('string');
      expect(square.package.location).to.be.a('string');

      expect(square.package.location).to.equal(fixtures + '/read/test.json');
      expect(square.package.path).to.equal(fixtures + '/read');
      expect(square.package.source).to.equal(source);
    });

    it('should parse boolean values using eson', function () {
      var square = new Square();

      expect(square.read(fixtures + '/read/eson-boolean.json')).to.equal(true);
      expect(square.package.configuration).to.be.a('object');
      expect(square.package.configuration.foo).to.equal(true);
      expect(square.package.configuration.bar).to.equal(false);
    });

    it('should parse include statements using eson', function () {
      var square = new Square();

      expect(square.read(fixtures + '/read/eson-include.json')).to.equal(true);
      expect(square.package.configuration).to.be.a('object');
      expect(square.package.configuration.foo).to.equal('bar');
    });

    it('should glob directories using eson', function () {
      var square = new Square();

      expect(square.read(fixtures + '/read/glob.json')).to.equal(true);
      expect(square.package.bundles).to.be.a('array');

      square.package.bundles.forEach(function (match) {
        expect(match).to.contain('glob');
        expect(match).to.contain('json');
      });
    });

    it('should tag {tags} using eson', function () {
      var square = new Square();

      expect(square.read(fixtures + '/read/tags.json')).to.equal(true);
      expect(square.package.type).to.equal('min');
    });
  });

  describe('#fromJSON', function () {
    var dir = require('path').join(fixtures, '/fromJSON');

    it('should validate the location', function () {
      var square = new Square();

      // non existing
      expect(square.fromJSON(dir + '/nonexisting.json')).to.be.a('object');
      expect(square.fromJSON(dir + '/nonexisting.json')).to.deep.equal({});

      // existing
      expect(square.fromJSON(dir + '/foo.json')).to.be.a('object');
      expect(square.fromJSON(dir + '/foo.json')).to.have.property('foo', 'bar');
    });

    it('should remove // comments from the JSON', function () {
      var square = new Square();

      expect(square.fromJSON(dir + '/singlecomment.json')).to.be.a('object');
      expect(square.fromJSON(dir + '/singlecomment.json')).to.have.property('foo', 'bar');
    });

    it('should remove /**/ comments from the JSON', function () {
      var square = new Square();

      expect(square.fromJSON(dir + '/multicomment.json')).to.be.a('object');
      expect(square.fromJSON(dir + '/multicomment.json')).to.have.property('foo', 'bar');
    });

    it('should remove both comments from the JSON', function () {
      var square = new Square();

      expect(square.fromJSON(dir + '/combinedcomment.json')).to.be.a('object');
      expect(square.fromJSON(dir + '/combinedcomment.json')).to.have.property('foo', 'bar');
    });

    it('should not give a fuck about the extension', function () {
      var square = new Square();

      expect(square.fromJSON(dir + '/noextension')).to.be.a('object');
      expect(square.fromJSON(dir + '/noextension')).to.have.property('foo', 'bar');
    });

    it('should return an Error when it fails to parse', function () {
      var square = new Square();

      expect(square.fromJSON(dir + '/broken.json')).to.be.an.instanceof(Error);
    });
  });

  describe('#critical', function () {
    it('should emit an error when its not running in cli mode');

    it('should exit the process with 1 when running in cli');
  });

  describe('createMeta', function () {
    it('should generate meta');
  });

  describe('createBundle', function () {
    it('should generate a bundle');
  });

  describe('#refresh', function () {
    it('should refresh the contents of the changed files');

    it('should ignore files that are not specified in a bundle');

    it('should emit `changed` when there are files updated');
  });

  describe('#directive', function () {
    it('should ignore regular comments');

    it('should ignore invalid comments');

    it('should include the linked file');

    it('should work with import, require, include');

    it('should process the files recusively');

    it('should giving meaning full errors for recursion');

    it('should add debug comments for each include');

    it('should prepend a semicolon if file doesnt start with one');

    it('should only prepend the semicolon for JavaScript files');
  });

  describe('#build', function () {});

  describe('#outofdate', function () {
    it('should check the upstream repo for its version number');

    it('should check different branches of the upstream');

    it('should randomly check for an upstream');

    it('should not check upstream if forbidden by configuration');
  });

  describe('#tag', function () {
    it('should return the branch name, as this is a git repository', function () {
      var square = new Square()
        , collection = { content: '', extension: 'js' }
        , data = square.tag(collection, 'dev');

      expect(data.branch).to.match(/^(master|development)$/);
    });

    it('should return the last SHA, as this is a git repository', function () {
      var square = new Square()
        , collection = { content: '', extension: 'js' }
        , data = square.tag(collection, 'dev');

      expect(data.sha).to.match(/^[0-9a-fA-F]{40}$/);
    });

    it('should contain the default tags', function () {
      var square = new Square()
        , collection = { content: '', extension: 'js' }
        , data = square.tag(collection);

      expect(data.type).to.equal('min');
      expect(data.ext).to.equal('js');
      expect(data.date).to.equal((new Date).toLocaleDateString());
      expect(data.year).to.equal((new Date).getFullYear());
      expect(data.user).to.equal(process.env.USER || 'anonymous');
      expect(data.env).to.equal('testing');
    });

    it('should override the tags with our configured tags', function () {
      var square = new Square()
        , collection = { content: '', extension: 'js' };

      square.package.configuration = { tags: { user: 'trolololololol' }};
      var data = square.tag(collection);

      expect(data.user).to.equal('trolololololol');
    });
  });

  describe('#template', function () {
    it('should replace the {tags} in a string', function () {
      var square = new Square()
        , tpl = square.template;

      expect(tpl('hello {world}', { world: 'foo' })).to.equal('hello foo');
      expect(tpl('{hi}', { hi: 'foo' })).to.equal('foo');
    });

    it('should remove the {tags} if no data has been found', function () {
      var square = new Square()
        , tpl = square.template;

      expect(tpl('hello {world}', {})).to.equal('hello ');
    });

    it('should find keys using dot notations for deeper object nesting', function () {
      var square = new Square()
        , tpl = square.template;

      var data = {
          bar: 'foo'
        , foo: {
            bar: 'baz'
          }
        , baz: [{ foo: 'bar' }]
      };

      expect(tpl('hi {bar}', data)).to.equal('hi foo');
      expect(tpl('hi {foo.bar}', data)).to.equal('hi baz');
      expect(tpl('hi {baz.0.foo}', data)).to.equal('hi bar');
      expect(tpl('{bar}{foo.bar}{baz.0.foo}', data)).to.equal('foobazbar');
    });

    it('should use the #tag() method to get data if no data is provided', function () {
      var square = new Square();

      expect(square.template('hi {type}')).to.equal('hi min');
    });
  });

  describe('#write', function () {
    it('should process the tags inside the configuration file name');

    it('should transform ~ to the $HOME path in file names');

    it('should emit a write with metrics');

    it('should prefix the file content with a license header');
  });

  describe('#commentWrap', function () {
    /**
     * Simple string single line comment string.
     *
     * @type {String}
     */

    var plain = 'hello world';

    /**
     * Multi line line.
     *
     * @type {String}
     */

    var multiline = ['hello', 'silly', 'world'].join('\n');

    it('should not place the comment if we dont have a comment style', function () {
      var square = new Square();

      expect(square.commentWrap(plain, 'pew pew')).to.equal('');
    });

    it('should wrap multi-line comments', function () {
      var square = new Square()
        , comments = square.commentWrap(multiline, 'js')
        , counts = 0;

      comments.split('\n').forEach(function (line) {
        if (line.trim() === '') return;

        expect(line.trim()).to.match(/\/|\*/);
      });
    });

    it('should wrap single-line comments', function () {
      var square = new Square()
        , comment = square.commentWrap(plain, 'js');

      expect(comment).to.have.string('/*');
      expect(comment).to.have.string('*/');
      expect(comment).to.have.string('\n');

      // should have starting \n, actual string, closing \n
      expect(comment.split('\n')).to.have.length(3);
    });

    it('should wrap the comment is the correct comment style based on type', function () {
      var square = new Square()
        , comment = square.commentWrap(plain, 'js')
        , comments = square.commentWrap(multiline, 'js')
        , style = square.commentStyles.js;

      expect(comment).to.have.string(style.header);
      expect(comment).to.have.string(style.body);
      expect(comment).to.have.string(style.footer);

      expect(comments).to.have.string(style.header);
      expect(comments).to.have.string(style.body);
      expect(comments).to.have.string(style.footer);
    });
  });

  describe('#license', function () {
    it('should prefix the content with a license');

    it('shouldnt prrefix if theres no license');

    it('should correclty comment the license header');
  });
});