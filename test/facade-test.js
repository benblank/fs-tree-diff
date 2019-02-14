'use strict';

const chai = require('chai');
const fixturify = require('fixturify');
const fs = require('fs-extra');
const fstree = require('..');
const path = require('path');
const sinon = require('sinon');
const sinonChai = require('sinon-chai');

const Entry = require('../lib/entry');
const { compareChanges } = require('../lib/shared');
const { ROOT_CONTAINER, getTempRoot, sourceTreeFromFixture, writableTreeFromFixture } = require('./helpers');
const verifyChanges = require('./verify-changes');

const { expect } = chai;

// Disable "actual"/"expected" truncation.
chai.config.truncateThreshold = 0;

chai.use(sinonChai);

const FIXTURE = {
  'hello.txt': 'Hello, World!\n',
  'my-directory.txt': 'sneaky!',

  'empty': {},

  'my-directory': {
    'foo.txt': 'foo',
    'bar.js': 'let bar;',

    'subdir': {
      'baz.js': 'let baz;',
    },
  },
};

function directory(relativePath) {
  return new Entry(relativePath, undefined, 0, Entry.DIRECTORY_MODE);
}

function file(relativePath) {
  return new Entry(relativePath, undefined, 0, Entry.FILE_MODE);
}

/** Given a fixture, compute the changes it represents.
 *
 * In other words, produce 'mkdir' changes for directories and 'create' changes
 * for file.
 *
 * Note that this function returns a **sorted** list of changes.  It therefore
 * may not be suitable for verifying that the changes produced by a tree are in
 * the correct order.
 *
 * @see verifyChangeOrder
 */
function changesFromFixture(fixture) {
  const changes = [];

  function collectFromDirectory(pathSegments, fixture) {
    for (const [ name, contents ] of Object.entries(fixture)) {
      const relativePath = path.join(...pathSegments, name);

      if (typeof contents === 'object') {
        changes.push([ 'mkdir', relativePath, directory(relativePath) ]);

        collectFromDirectory([ ...pathSegments, name ], contents);
      } else {
        changes.push([ 'create', relativePath, file(relativePath) ]);
      }
    }
  }

  collectFromDirectory([], fixture);

  return sanitizeChanges(sortChanges(changes));
}

/** Reset the tracked changes for any type of tree. */
function clearChanges(tree) {
  if (tree.stop) {
    tree.stop();
  }

  // ensure changes are generated
  tree.changes();

  tree.reread();

  if (tree.start) {
    tree.start();
  }
}

/** Given a fixture, compute the entries it represents. */
function entriesFromFixture(fixture) {
  return changesFromFixture(fixture).map((change) => change[2]);
}

/** Given a fixture, compute the paths it represents. */
function pathsFromFixture(fixture) {
  return entriesFromFixture(fixture).map((entry) => entry.relativePath);
}

/** Convert a change into a simpler, more comparable object.
 *
 * Sanitizes paths and entries using sanitizeEntry.
 *
 * If no entry is provided with a change (i.e. the change contains only two
 * elements), an entry will be created based on the operation.
 */
function sanitizeChange(change) {
  let entry = change[2];

  if (!entry) {
    entry = /mkdir|rmdir/.test(change[0]) ? directory(change[1]) : file(change[1]);
  }

  return [change[0], change[1], sanitizeEntry(entry)];
}

/** Convert an array of changes into simpler, more comparable objects. */
function sanitizeChanges(changes) {
  return changes.map(sanitizeChange);
}

/** Sanitize an array of entries using sanitizeEntry. */
function sanitizeEntries(entries) {
  return entries.map(sanitizeEntry);
}

/** Reduces an entry to a simpler, more comparable form.
 *
 * Only mode and relativePath are retained, both sanitized.
 */
function sanitizeEntry(entry) {
  return new Entry(entry.relativePath, undefined, 0, sanitizeMode(entry.mode));
}

/** Discard permission bits in mode.
 *
 * Sanitizes a mode by retaining only the type bits.
 */
function sanitizeMode(mode) {
  return mode & 61440;  // only retain type bits
}

/** Sort a list of changes into a canonical order.
 *
 * The order is change/create/mkdir changes in alphabetical order by
 * relativePath, followed by rmdir/unlink changes in reverse alphabetical
 * order.
 */
function sortChanges(changes) {
  return changes.sort(compareChanges);
}

describe('fsFacade', function() {
  let tree;

  afterEach(function() {
    fs.removeSync(ROOT_CONTAINER);
  });

  function defineCommonTests() {
    function defineCommonReadTests(act, {
      directories,
      files,
    } = {}) {
      if (directories === undefined || files === undefined) {
        throw new Error('"directories" and "files" must be set');
      }

      it('throws for non-existent paths', function() {
        expect(() => act('does-not-exist')).to.throw(/\bENOENT\b/);
      });

      if (directories) {
        it('normalizes directory paths through existing directories', function() {
          expect(() => act('my-directory/../empty')).to.not.throw();
        });

        it('normalizes directory paths through non-existing directories', function() {
          expect(() => act('does-not-exist/../empty')).to.not.throw();
        });
      }

      if (files) {
        it('normalizes file paths through existing directories', function() {
          expect(() => act('my-directory/../hello.txt')).to.not.throw();
        });

        it('normalizes file paths through non-existing directories', function() {
          expect(() => act('does-not-exist/../hello.txt')).to.not.throw();
        });
      }
    }

    describe('.changes() [common]', function() {
      it('returns the changes from the fixture', function() {
        const changes = sanitizeChanges(tree.changes());

        expect(sortChanges(changes)).to.deep.equal(changesFromFixture(FIXTURE));
        expect(() => verifyChanges(changes)).to.not.throw();
      });
    });

    describe('.chdir [common]', function() {
      it('creates a Projection', function() {
        expect(tree.chdir('my-directory')).to.be.an.instanceOf(fstree.Projection);
      });

      it('throws if the target is a file', function() {
        expect(() => tree.chdir('hello.txt')).to.throw(/\bENOTDIR\b/);
      });

      it('throws if the target does not exist', function() {
        expect(() => tree.chdir('does-not-exist')).to.throw(/\bENOENT\b/);
      });
    });

    describe('.entries [common]', function() {
      it('returns every entry in the tree', function() {
        expect(sanitizeEntries(tree.entries)).to.deep.equal(entriesFromFixture(FIXTURE));
      });
    });

    describe('.existsSync() [common]', function() {
      it('returns true for directories', function() {
        expect(tree.existsSync('my-directory')).to.be.true;
      });

      it('returns true for files', function() {
        expect(tree.existsSync('hello.txt')).to.be.true;
      });

      it('returns true for the root', function() {
        expect(tree.existsSync('')).to.be.true;
      });

      it('returns false for non-existent paths', function() {
        expect(tree.existsSync('does-not-exist')).to.be.false;
      });

      it('normalizes through existing paths', function() {
        expect(tree.existsSync('my-directory/../hello.txt')).to.be.true;
      });

      it('normalizes through non-existing paths', function() {
        expect(tree.existsSync('does-not-exist/../hello.txt')).to.be.true;
      });
    });

    describe('.paths [common]', function() {
      it('contains every path in the tree', function() {
        expect(tree.paths).to.deep.equal(pathsFromFixture(FIXTURE));
      });
    });

    describe('.readFileSync() [common]', function() {
      defineCommonReadTests((path_) => tree.readFileSync(path_, 'utf8'), { directories: false, files: true });

      it('works', function() {
        expect(tree.readFileSync('hello.txt', 'utf8')).to.equal('Hello, World!\n');
      });

      it('throws for directories', function() {
        expect(() => tree.readFileSync('my-directory', 'utf8')).to.throw(/\bEISDIR\b/);
      });
    });

    describe('.readdirSync() [common]', function() {
      defineCommonReadTests((path_) => tree.readdirSync(path_), { directories: true, files: false });

      it('works', function() {
        expect(tree.readdirSync('my-directory')).to.deep.equal([
          'bar.js',
          'foo.txt',
          'subdir',
        ]);
      });

      it('throws for files', function() {
        expect(() => tree.readdirSync('hello.txt')).to.throw(/\bENOTDIR\b/);
      });
    });

    describe('.reread() [common]', function() {
      it('works', function() {
        expect(() => tree.reread()).to.not.throw;
      });

      it('works when the root is not changed', function() {
        expect(() => tree.reread(tree.root)).to.not.throw();
      });
    });

    describe('.statSync() [common]', function() {
      defineCommonReadTests((path_) => tree.statSync(path_), { directories: true, files: true });

      it('works for files', function() {
        const stats = tree.statSync('hello.txt');

        expect(stats).to.have.property('mode');
        expect(stats).to.have.property('mtime');
        expect(stats).to.have.property('size');
      });

      it('works for directories', function() {
        const stats = tree.statSync('my-directory');

        expect(stats).to.have.property('mode');
        expect(stats).to.have.property('mtime');
        expect(stats).to.have.property('size');
      });

      it('works for the tree\'s root', function() {
        const stats = tree.statSync('');

        expect(stats).to.have.property('mode');
        expect(stats).to.have.property('mtime');
        expect(stats).to.have.property('size');
      });
    });
  }

  function defineCommonWriteTests(act, {
    allowMissingParent = false,
    allowRoot = false,
    checkTracking = true,
    directories,
    eperm = false,
    files,
    mustExist,
  } = {}) {
    if (directories === undefined || files === undefined || mustExist === undefined) {
      throw new Error('directories, files, and mustExist must be set');
    }

    if (directories) {
      it('normalizes directory paths through existing directories', function() {
        expect(() => act(tree, mustExist ? 'my-directory/../empty' : 'my-directory/../does-not-exist')).to.not.throw();
      });

      it('normalizes directory paths through non-existing directories', function() {
        expect(() => act(tree, mustExist ? 'does-not-exist/../empty' : 'does-not-exist/../also-does-not-exist')).to.not.throw();
      });
    }

    if (files) {
      it('normalizes file paths through existing directories', function() {
        expect(() => act(tree, mustExist ?  'my-directory/../hello.txt' : 'my-directory/../new.txt')).to.not.throw();
      });

      it('normalizes file paths through non-existing directories', function() {
        expect(() => act(tree, mustExist ? 'does-not-exist/../hello.txt' : 'does-not-exist/../new.txt')).to.not.throw();
      });
    }

    if (checkTracking) {
      if (directories) {
        it('tracks a change when acting on a directory', function() {
          clearChanges(tree);

          act(tree, mustExist ? 'empty' : 'new');

          expect(tree.changes()).to.have.lengthOf(1);
        });
      }

      if (files) {
        it('tracks a change when acting on a file', function() {
          clearChanges(tree);

          act(tree, mustExist ? 'hello.txt' : 'new.txt');

          expect(tree.changes()).to.have.lengthOf(1);
        });
      }
    }

    if (directories) {
      it('throws when a stopped tree acts on a directory', function() {
        tree.stop();

        expect(() => act(tree, mustExist ? 'empty' : 'new')).to.throw(/\bstopped\b/i);
      });
    }

    if (files) {
      it('throws when a stopped tree acts on a file', function() {
        tree.stop();

        expect(() => act(tree, mustExist ? 'hello.txt' : 'new.txt')).to.throw(/\bstopped\b/i);
      });
    }

    if (!allowMissingParent) {
      it('throws when a parent directory does not exist', function() {
        expect(() => act(tree, 'does-not-exist/new')).to.throw(/\bENOENT\b/);
      });
    }

    if (!allowRoot) {
      it('throws when acting on the tree\'s root', function() {
        expect(() => act(tree, '')).to.throw(/\broot\b/i);
      });
    }

    if (mustExist) {
      it('throws if the target does not exist', function() {
        expect(() => act(tree, 'does-not-exist')).to.throw(/\bENOENT\b/);
      });
    }

    if (!directories) {
      it('throws if the target is a directory', function() {
        if (eperm) {
          // For some reason, real unlinks throw EPERM here rather than EISDIR.
          expect(() => act(tree, 'empty')).to.throw(/\bEPERM\b/);
        } else {
          expect(() => act(tree, 'empty')).to.throw(/\bE(?:EXIST|ISDIR)\b/);
        }
      });
    }

    if (!files) {
      it('throws if the target is a file', function() {
        expect(() => act(tree, 'hello.txt')).to.throw(mustExist ? /\bENOTDIR\b/ : /\bEEXIST\b/);
      });
    }

    it('throws when acting across a symlinked directory', function() {
      const tree2 = writableTreeFromFixture({});

      tree2.symlinkToFacadeSync(tree, 'my-directory', 'linked-directory');

      expect(() => act(tree2, 'linked-directory/new')).to.throw(/\bENOENT?\b/i);
    });
  }

  function defineConstructorRootTests() {
    it('requires a root', function() {
      expect(() => new fstree.SourceTree()).to.throw(/\broot\b/i);
    });

    it('requires root be a string', function() {
      expect(() => new fstree.SourceTree({ root: null })).to.throw(/\broot\b/i);
      expect(() => new fstree.SourceTree({ root: 5 })).to.throw(/\broot\b/i);
    });

    it('requires root be non-empty', function() {
      expect(() => new fstree.SourceTree({ root: '' })).to.throw(/\broot\b/i);
    });

    it('requires root be an absolute path', function() {
      expect(() => new fstree.SourceTree({ root: 'foo' })).to.throw(/\broot\b/i);
    });

    it('normalizes root', function() {
      expect(new fstree.SourceTree({ root: '/foo' }).root).to.equal('/foo');
      expect(new fstree.SourceTree({ root: '/foo/' }).root).to.equal('/foo');
      expect(new fstree.SourceTree({ root: '/bar/../foo' }).root).to.equal('/foo');
    });
  }

  function defineRereadChainingTest() {
    it('calls the private _reread method of its children exactly once', function() {
      const child1 = tree.chdir('my-directory');
      const child2 = tree.filtered({});

      child1._reread = sinon.spy();
      child2._reread = sinon.spy();

      tree.reread();

      expect(child1._reread).to.have.been.calledOnce;
      expect(child2._reread).to.have.been.calledOnce;
    });
  }

  describe('Delegator', function() {
    let delegate;

    beforeEach(function() {
      delegate = writableTreeFromFixture(FIXTURE);

      tree = writableTreeFromFixture({});
      tree.symlinkToFacadeSync(delegate, '', '');
    });

    defineCommonTests();

    describe('.reread()', function() {
      it('does not call the private _reread method of its children', function() {
        const child1 = tree.chdir('my-directory');
        const child2 = tree.filtered({});

        child1._reread = sinon.spy();
        child2._reread = sinon.spy();

        tree.reread();

        expect(child1._reread).to.not.have.been.called;
        expect(child2._reread).to.not.have.been.called;
      });
    });

    describe('.undoRootSymlinkSync()', function() {
      let tree2;

      beforeEach(function() {
        tree2 = writableTreeFromFixture({});
        tree2.symlinkToFacadeSync(tree, '', '');
      });

      it('works', function() {
        expect(tree2.paths).to.deep.equal(pathsFromFixture(FIXTURE));

        tree2.undoRootSymlinkSync();

        expect(tree2.paths).to.be.empty;
      });

      it('changes the tree back into a WritableTree', function() {
        tree2.undoRootSymlinkSync();

        expect(tree2).to.be.an.instanceOf(fstree.WritableTree);
      });
    });
  });

  describe('Projection', function() {
    let parent;

    beforeEach(function() {
      parent = sourceTreeFromFixture(FIXTURE);

      tree = parent.filtered({});
    });

    defineCommonTests();

    describe('cwd filter', function() {
      let projection;

      beforeEach(function() {
        projection = parent.chdir('my-directory');
      });

      it('applies to changes', function() {
        expect(sanitizeChanges(projection.changes())).to.deep.equal(changesFromFixture(FIXTURE['my-directory']));
      });

      it('applies to entries', function() {
        expect(sanitizeEntries(projection.entries)).to.deep.equal(entriesFromFixture(FIXTURE['my-directory']));
      });

      it('applies to paths', function() {
        expect(projection.paths).to.deep.equal(pathsFromFixture(FIXTURE['my-directory']));
      });

      it('can be changed', function() {
        projection.cwd = 'my-directory/subdir';

        expect(sanitizeEntries(projection.entries)).to.deep.equal(entriesFromFixture(FIXTURE['my-directory'].subdir));
      });

      it('emits the correct changes when changed', function() {
        // Also clears changes on projection, as it is a child of parent.
        clearChanges(parent);

        projection.cwd = 'my-directory/subdir';

        expect(sanitizeChanges(projection.changes())).to.deep.equal(sanitizeChanges([
          [ 'unlink', 'subdir/baz.js' ],
          [ 'rmdir', 'subdir' ],
          [ 'unlink', 'foo.txt' ],
          [ 'unlink', 'bar.js' ],
          [ 'create', 'baz.js' ],
        ]));
      });

      it('can be combined with an include filter', function() {
        expect(parent.filtered({ cwd: 'my-directory', include: [ '**/*.js' ] }).paths).to.deep.equal([
          'bar.js',
          'subdir',
          'subdir/baz.js',
        ]);
      });

      it('can be combined with an exclude filter', function() {
        expect(parent.filtered({ cwd: 'my-directory', exclude: [ '**/*.js' ] }).paths).to.deep.equal([
          'foo.txt',
          'subdir',
        ]);
      });

      it('applies to .chdir()', function() {
        expect(projection.chdir('subdir').root).to.equal(path.join(tree.root, 'my-directory', 'subdir'));
      });

      it('applies to .existsSync()', function() {
        expect(projection.existsSync('foo.txt')).to.be.true;
      });

      it('applies to .filtered()', function() {
        expect(projection.filtered({ include: [ '*.txt' ] }).paths).to.deep.equal([
          'foo.txt',
        ]);
      });

      it('applies to .readFileSync()', function() {
        expect(projection.readFileSync('foo.txt', 'utf8')).to.equal(FIXTURE['my-directory']['foo.txt']);
      });

      it('applies to .readdirSync()', function() {
        expect(projection.readdirSync('subdir')).to.deep.equal([
          'baz.js',
        ]);
      });

      it('applies to .statSync()', function() {
        expect(() => projection.statSync('foo.txt')).to.not.throw();
      });
    });

    describe('files filter', function() {
      let projection;

      beforeEach(function() {
        projection = parent.filtered({
          files: [
            // use names which don't overlap FIXTURE, to make leakage detectible
            'one.txt',
            'two/three.txt',
          ],
        });
      });

      it('only allows null, undefined, and arrays', function() {
        expect(() => parent.filtered({ files: '**/*.js' })).to.throw(/\ban array\b/);
        expect(() => parent.filtered({ files: /\.js$/ })).to.throw(/\ban array\b/);
        expect(() => parent.filtered({ files: (path_) => path_.endsWith('.js') })).to.throw(/\ban array\b/);
        expect(() => parent.filtered({ files: 4 })).to.throw(/\ban array\b/);
        expect(() => parent.filtered({ files: true })).to.throw(/\ban array\b/);
        expect(() => parent.filtered({ files: new Date() })).to.throw(/\ban array\b/);
      });

      it('normalizes paths', function() {
        projection = parent.filtered({
          files: [ './foo/../bar/././baz.txt' ],
        });

        expect(projection.paths).to.deep.equal([
          'bar',
          'bar/baz.txt',
        ]);
      });

      it('is incompatible with include', function() {
        expect(() => parent.filtered({ files: [ 'foo' ], include: [ 'bar' ] })).to.throw(/\bincompatible\b/);
      });

      it('is incompatible with exclude', function() {
        expect(() => parent.filtered({ files: [ 'foo' ], include: [ 'bar' ] })).to.throw(/\bincompatible\b/);
      });

      it('applies to changes', function() {
        expect(sanitizeChanges(projection.changes())).to.deep.equal(sanitizeChanges([
          [ 'create', 'one.txt' ],
          [ 'mkdir', 'two' ],
          [ 'create', 'two/three.txt' ],
        ]));
      });

      it('applies to entries', function() {
        expect(sanitizeEntries(projection.entries)).to.deep.equal(sanitizeEntries([
          file('one.txt'),
          directory('two'),
          file('two/three.txt'),
        ]));
      });

      it('applies to paths', function() {
        expect(projection.paths).to.deep.equal([
          'one.txt',
          'two',
          'two/three.txt',
        ]);
      });

      it('can be changed', function() {
        projection.files = [
          // again, no overlap with FIXTURE or previous value
          'four.js',
          'five/six.js',
        ];

        expect(projection.paths).to.deep.equal([
          'five',
          'five/six.js',
          'four.js',
        ]);
      });

      it('emits the correct changes when changed', function() {
        // also clears changes on projection, as it is a child of parent
        clearChanges(parent);

        projection.files = [
          // again, no overlap with FIXTURE or previous value
          'four.js',
          'five/six.js',
        ];

        expect(sanitizeChanges(projection.changes())).to.deep.equal(sanitizeChanges([
          [ 'unlink', 'two/three.txt' ],
          [ 'rmdir', 'two' ],
          [ 'unlink', 'one.txt' ],
          [ 'mkdir', 'five' ],
          [ 'create', 'five/six.js' ],
          [ 'create', 'four.js' ],
        ]));
      });

      it('can be empty', function() {
        projection.files = [];

        expect(projection.paths).to.deep.equal([]);
      });

      it('applies to .chdir()', function() {
        expect(projection.chdir('two').root).to.equal(`${tree.root}/two`);
      });

      it('applies to .existsSync()', function() {
        // file exists on disk, but not in filter
        expect(projection.existsSync('hello.txt')).to.be.false;
      });

      it('applies to .filtered()', function() {
        expect(projection.filtered({ include: [ '*.txt' ] }).paths).to.deep.equal([
          'one.txt',
        ]);
      });

      it('applies to .readFileSync()', function() {
        // file exists on disk, but not in filter
        expect(() => projection.readFileSync('hello.txt', 'utf8')).to.throw(/\bENOENT\b/);
      });

      it('applies to .readdirSync()', function() {
        expect(projection.readdirSync('two')).to.deep.equal([
          'three.txt',
        ]);
      });

      it('applies to .statSync()', function() {
        expect(() => projection.statSync('one.txt')).to.not.throw();
      });
    });

    describe('include filter', function() {
      let projection;

      beforeEach(function() {
        projection = parent.filtered({ include: [ '**/*.js' ] });
      });

      it('supports glob filters', function() {
        expect(parent.filtered({ include: [ '**/*.txt' ] }).paths).to.deep.equal([
          'hello.txt',
          'my-directory',
          'my-directory.txt',
          'my-directory/foo.txt',
        ]);
      });

      it('supports RegExp filters', function() {
        expect(parent.filtered({ include: [ /\.txt$/ ] }).paths).to.deep.equal([
          'hello.txt',
          'my-directory',
          'my-directory.txt',
          'my-directory/foo.txt',
        ]);
      });

      it('supports function filters', function() {
        expect(parent.filtered({ include: [ (path_) => path_.endsWith('.txt') ] }).paths).to.deep.equal([
          'hello.txt',
          'my-directory',
          'my-directory.txt',
          'my-directory/foo.txt',
        ]);
      });

      it('supports multiple filters', function() {
        expect(parent.filtered({ include: [ '**/*.txt', '**/*.js' ] }).paths).to.deep.equal([
          'hello.txt',
          'my-directory',
          'my-directory.txt',
          'my-directory/bar.js',
          'my-directory/foo.txt',
          'my-directory/subdir',
          'my-directory/subdir/baz.js',
        ]);
      });

      it('supports mixed filters', function() {
        expect(parent.filtered({ include: [ '**/*.txt', /\.js$/ ] }).paths).to.deep.equal([
          'hello.txt',
          'my-directory',
          'my-directory.txt',
          'my-directory/bar.js',
          'my-directory/foo.txt',
          'my-directory/subdir',
          'my-directory/subdir/baz.js',
        ]);
      });

      it('only allows arrays', function() {
        expect(() => parent.filtered({ include: '**/*.js' })).to.throw(/\ban array\b/);
        expect(() => parent.filtered({ include: /\.js$/ })).to.throw(/\ban array\b/);
        expect(() => parent.filtered({ include: (path_) => path_.endsWith('.js') })).to.throw(/\ban array\b/);
        expect(() => parent.filtered({ include: 4 })).to.throw(/\ban array\b/);
        expect(() => parent.filtered({ include: true })).to.throw(/\ban array\b/);
        expect(() => parent.filtered({ include: new Date() })).to.throw(/\ban array\b/);
      });

      it('applies to changes', function() {
        expect(sanitizeChanges(projection.changes())).to.deep.equal(sanitizeChanges([
          [ 'mkdir', 'my-directory' ],
          [ 'create', 'my-directory/bar.js' ],
          [ 'mkdir', 'my-directory/subdir' ],
          [ 'create', 'my-directory/subdir/baz.js' ],
        ]));
      });

      it('applies to entries', function() {
        expect(sanitizeEntries(projection.entries)).to.deep.equal(sanitizeEntries([
          directory('my-directory'),
          file('my-directory/bar.js'),
          directory('my-directory/subdir'),
          file('my-directory/subdir/baz.js'),
        ]));
      });

      it('applies to paths', function() {
        expect(projection.paths).to.deep.equal([
          'my-directory',
          'my-directory/bar.js',
          'my-directory/subdir',
          'my-directory/subdir/baz.js',
        ]);
      });

      it('can be changed', function() {
        // no overlap with previous value; subdirectories cannot match
        projection.include = [ '*.txt' ];

        expect(projection.paths).to.deep.equal([
          'hello.txt',
          'my-directory.txt',
        ]);
      });

      it('emits the correct changes when changed', function() {
        // also clears changes on projection, as it is a child of parent
        clearChanges(parent);

        // no overlap with previous value; subdirectories cannot match
        projection.include = [ '*.txt' ];

        expect(sanitizeChanges(projection.changes())).to.deep.equal(sanitizeChanges([
          [ 'unlink', 'my-directory/subdir/baz.js' ],
          [ 'rmdir', 'my-directory/subdir' ],
          [ 'unlink', 'my-directory/bar.js' ],
          [ 'rmdir', 'my-directory' ],
          [ 'create', 'hello.txt' ],
          [ 'create', 'my-directory.txt' ],
        ]));
      });

      it('can hide all files', function() {
        projection.include = [ 'does-not-exist' ];

        expect(projection.paths).to.deep.equal([]);
      });

      it('applies to .chdir()', function() {
        // filter with no directories
        projection.include = [ '*.txt' ];

        expect(() =>projection.chdir('my-directory').root).to.throw(/\bENOENT\b/);
      });

      it('applies to .existsSync()', function() {
        // file exists on disk, but not in filter
        expect(projection.existsSync('hello.txt')).to.be.false;
      });

      it('applies to .filtered()', function() {
        expect(projection.filtered({ exclude: [ 'my-directory/subdir' ] }).paths).to.deep.equal([
          'empty',
          'my-directory',
          'my-directory/bar.js',
        ]);
      });

      it('applies to .readFileSync()', function() {
        // file exists on disk, but not in filter
        expect(() => projection.readFileSync('hello.txt', 'utf8')).to.throw(/\bENOENT\b/);
      });

      it('applies to .readdirSync()', function() {
        expect(projection.readdirSync('my-directory')).to.deep.equal([
          'bar.js',
          'subdir',
        ]);
      });

      it('applies to .statSync()', function() {
        expect(() => projection.statSync('my-directory/foo.txt')).to.throw(/\bENOENT\b/);
      });
    });

    describe('exclude filter', function() {
      let projection;

      beforeEach(function() {
        projection = parent.filtered({ exclude: [ 'my-directory/subdir' ] });
      });

      it('supports glob filters', function() {
        expect(parent.filtered({ exclude: [ '**/*.js' ] }).paths).to.deep.equal([
          'empty',
          'hello.txt',
          'my-directory',
          'my-directory.txt',
          'my-directory/foo.txt',
          'my-directory/subdir',
        ]);
      });

      it('supports RegExp filters', function() {
        expect(parent.filtered({ exclude: [ /\.js$/ ] }).paths).to.deep.equal([
          'empty',
          'hello.txt',
          'my-directory',
          'my-directory.txt',
          'my-directory/foo.txt',
          'my-directory/subdir',
        ]);
      });

      it('supports function filters', function() {
        expect(parent.filtered({ exclude: [ (path_) => path_.endsWith('.js') ] }).paths).to.deep.equal([
          'empty',
          'hello.txt',
          'my-directory',
          'my-directory.txt',
          'my-directory/foo.txt',
          'my-directory/subdir',
        ]);
      });

      it('supports multiple filters', function() {
        expect(parent.filtered({ exclude: [ '**/*.txt', '**/*.js' ] }).paths).to.deep.equal([
          'empty',
          'my-directory',
          'my-directory/subdir',
        ]);
      });

      it('supports mixed filters', function() {
        expect(parent.filtered({ exclude: [ '**/*.txt', /\.js$/ ] }).paths).to.deep.equal([
          'empty',
          'my-directory',
          'my-directory/subdir',
        ]);
      });

      it('only allows arrays', function() {
        expect(() => parent.filtered({ exclude: '**/*.js' })).to.throw(/\ban array\b/);
        expect(() => parent.filtered({ exclude: /\.js$/ })).to.throw(/\ban array\b/);
        expect(() => parent.filtered({ exclude: (path_) => path_.endsWith('.js') })).to.throw(/\ban array\b/);
        expect(() => parent.filtered({ exclude: 4 })).to.throw(/\ban array\b/);
        expect(() => parent.filtered({ exclude: true })).to.throw(/\ban array\b/);
        expect(() => parent.filtered({ exclude: new Date() })).to.throw(/\ban array\b/);
      });

      it('applies to changes', function() {
        expect(sanitizeChanges(projection.changes())).to.deep.equal(sanitizeChanges([
          [ 'mkdir', 'empty' ],
          [ 'create', 'hello.txt' ],
          [ 'mkdir', 'my-directory' ],
          [ 'create', 'my-directory.txt' ],
          [ 'create', 'my-directory/bar.js' ],
          [ 'create', 'my-directory/foo.txt' ],
        ]));
      });

      it('applies to entries', function() {
        expect(sanitizeEntries(projection.entries)).to.deep.equal(sanitizeEntries([
          directory('empty'),
          file('hello.txt'),
          directory('my-directory'),
          file('my-directory.txt'),
          file('my-directory/bar.js'),
          file('my-directory/foo.txt'),
        ]));
      });

      it('applies to paths', function() {
        expect(projection.paths).to.deep.equal([
          'empty',
          'hello.txt',
          'my-directory',
          'my-directory.txt',
          'my-directory/bar.js',
          'my-directory/foo.txt',
        ]);
      });

      it('can be changed', function() {
        projection.exclude = [ 'my-directory' ];

        expect(projection.paths).to.deep.equal([
          'empty',
          'hello.txt',
          'my-directory.txt',
        ]);
      });

      it('emits the correct changes when changed', function() {
        // also clears changes on projection, as it is a child of parent
        clearChanges(parent);

        projection.exclude = [ 'my-directory' ];

        expect(sanitizeChanges(projection.changes())).to.deep.equal(sanitizeChanges([
          [ 'unlink', 'my-directory/foo.txt' ],
          [ 'unlink', 'my-directory/bar.js' ],
          [ 'rmdir', 'my-directory' ],
        ]));
      });

      it('can hide all files', function() {
        projection.exclude = [ '**/*' ];

        expect(projection.paths).to.deep.equal([]);
      });

      it('applies to .chdir()', function() {
        projection.exclude = [ 'my-directory' ];

        expect(() => projection.chdir('my-directory/subdir').root).to.throw(/\bENOENT\b/);
      });

      it('applies to .existsSync()', function() {
        // file exists on disk, but not in filter
        expect(projection.existsSync('my-directory/subdir/baz.js')).to.be.false;
      });

      it('applies to .filtered()', function() {
        expect(projection.filtered({ include: [ '**/*.js' ] }).paths).to.deep.equal([
          'my-directory',
          'my-directory/bar.js',
        ]);
      });

      it('applies to .readFileSync()', function() {
        // file exists on disk, but not in filter
        expect(() => projection.readFileSync('my-directory/subdir/baz.js', 'utf8')).to.throw(/\bENOENT\b/);
      });

      it('applies to .readdirSync()', function() {
        expect(() => projection.readdirSync('my-directory/subdir')).to.throw(/\bENOENT\b/)
      });

      it('applies to .statSync()', function() {
        expect(() => projection.statSync('my-directory/subdir/baz.js')).to.throw(/\bENOENT\b/);
      });
    });

    describe('.chdir()', function() {
      it('never returns the same tree', function() {
        expect(tree.chdir('')).to.not.equal(tree);
      });
    });

    describe('.filtered()', function() {
      it('never returns the same tree', function() {
        expect(tree.filtered({})).to.not.equal(tree);
      });
    });

    describe('.reread()', function() {
      defineRereadChainingTest();
    });
  });

  describe('SourceTree', function() {
    beforeEach(function() {
      tree = sourceTreeFromFixture(FIXTURE);
    });

    defineCommonTests();

    describe('constructor', function() {
      defineConstructorRootTests();
    });

    describe('scanning', function() {
      it('scans only the root', function() {
        tree.readdirSync('');

        expect(tree._scannedDirectories).to.have.all.keys([ '' ]);
      });

      it('scans only a single directory', function() {
        tree.statSync('my-directory/foo.txt');

        expect(tree._scannedDirectories).to.have.all.keys([ 'my-directory' ]);
      });

      it('won\'t scan the same directory twice', function() {
        expect(tree.readdirSync('my-directory/subdir')).to.deep.equal([ 'baz.js' ]);

        // Invalidate the tree's "cache" by changing what's on disk.
        fs.unlinkSync(path.join(tree.root, 'my-directory/subdir/baz.js'));
        fs.writeFileSync(path.join(tree.root, 'my-directory/subdir/quux.txt'), 'quux', 'utf8');

        // Result should now come from memory, so won't reflect on-disk changes.
        expect(tree.readdirSync('my-directory/subdir')).to.deep.equal([ 'baz.js' ]);
      });

      it('resets when .reread() is called', function() {
        expect(tree.readdirSync('my-directory/subdir')).to.deep.equal([ 'baz.js' ]);

        // Invalidate the tree's "cache" by changing what's on disk.
        fs.unlinkSync(path.join(tree.root, 'my-directory/subdir/baz.js'));
        fs.writeFileSync(path.join(tree.root, 'my-directory/subdir/quux.js'), 'quux', 'utf8');

        tree.reread();

        expect(tree.readdirSync('my-directory/subdir')).to.deep.equal([ 'quux.js' ]);
      });
    });

    describe('.changes()', function() {
      beforeEach(function() {
        clearChanges(tree);
      });

      it('picks up created files', function() {
        fs.writeFileSync(path.join(tree.root, 'new.txt'), 'new', 'utf8');

        expect(sanitizeChanges(tree.changes())).to.deep.equal(sanitizeChanges([
          [ 'create', 'new.txt' ],
        ]));
      });

      it('picks up changed files', function() {
        fs.writeFileSync(path.join(tree.root, 'hello.txt'), 'Hello, again!\n', 'utf8');

        expect(sanitizeChanges(tree.changes())).to.deep.equal(sanitizeChanges([
          [ 'change', 'hello.txt' ],
        ]));
      });

      it('picks up created directories', function() {
        fs.mkdirSync(path.join(tree.root, 'new'));

        expect(sanitizeChanges(tree.changes())).to.deep.equal(sanitizeChanges([
          [ 'mkdir', 'new' ],
        ]));
      });

      it('picks up deleted directories', function() {
        fs.rmdirSync(path.join(tree.root, 'empty'));

        expect(sanitizeChanges(tree.changes())).to.deep.equal(sanitizeChanges([
          [ 'rmdir', 'empty' ],
        ]));
      });

      it('picks up deleted files', function() {
        fs.unlinkSync(path.join(tree.root, 'hello.txt'));

        expect(sanitizeChanges(tree.changes())).to.deep.equal(sanitizeChanges([
          [ 'unlink', 'hello.txt' ],
        ]));
      });
    });

    describe('.existsSync()', function() {
      it('returns true for working scanned symlinks', function() {

        fs.symlinkSync(`${tree.root}/hello.txt`, `${tree.root}/linked.txt`);

        expect(tree.existsSync('linked.txt')).to.be.true;
      });

      it('returns false for broken scanned symlinks', function() {
        fs.symlinkSync(`${tree.root}/does-not-exist`, `${tree.root}/linked`);

        expect(tree.existsSync('linked')).to.be.false;
      });
    });

    describe('.reread()', function() {
      defineRereadChainingTest();

      it('resets the cached entries', function() {
        const tree2 = sourceTreeFromFixture({});

        expect(tree2.paths).to.be.empty;

        fixturify.writeSync(tree2.root, {
          a: {
            b: 'hello',
          },
          a2: 'guten tag'
        });

        // The root directory is already cached, so the new files are not picked up.
        expect(tree2.paths).to.be.empty;

        tree2.reread();

        expect(tree2.paths).to.deep.equal([
          'a',
          'a/b',
          'a2'
        ]);
      });

      it('can change the root', function() {
        const newRoot = getTempRoot();

        expect(tree.paths).to.deep.equal(pathsFromFixture(FIXTURE));

        fixturify.writeSync(newRoot, {
          bar: 'bar',
        });

        tree.reread(newRoot);

        expect(tree.paths).to.deep.equal([
          'bar',
        ]);
      });

      it('throws on non-absolute roots', function() {
        expect(() => tree.reread('foo')).to.throw(/\babsolute\b/i);
      });
    });
  });

  describe('WritableTree', function() {
    beforeEach(function() {
      tree = writableTreeFromFixture(FIXTURE);
    });

    defineCommonTests();

    describe('constructor', function() {
      defineConstructorRootTests();
    });

    describe('change untracking', function() {
      beforeEach(function() {
        tree.mkdirSync('another-directory');

        clearChanges(tree);
      });

      it('tracks only a change when a removed file is created', function() {
        expect(tree.changes()).to.have.lengthOf(0);

        tree.unlinkSync('hello.txt');

        expect(tree.changes()).to.have.lengthOf(1);
        expect(tree.changes()[0][0]).to.equal('unlink');

        tree.writeFileSync('hello.txt', 'new', 'utf8');

        expect(tree.changes()).to.have.lengthOf(1);
        expect(tree.changes()[0][0]).to.equal('change');
      });

      it('tracks only a single change when a file changes multiple times', function() {
        expect(tree.changes()).to.have.lengthOf(0);

        tree.writeFileSync('hello.txt', 'changed1', 'utf8');

        expect(tree.changes()).to.have.lengthOf(1);
        expect(tree.changes()[0][0]).to.equal('change');

        tree.writeFileSync('hello.txt', 'changed2', 'utf8');

        expect(tree.changes()).to.have.lengthOf(1);
        expect(tree.changes()[0][0]).to.equal('change');
      });

      it('tracks only a create when a newly-created file changes', function() {
        expect(tree.changes()).to.have.lengthOf(0);

        tree.writeFileSync('new.txt', 'new', 'utf8');

        expect(tree.changes()).to.have.lengthOf(1);
        expect(tree.changes()[0][0]).to.equal('create');

        tree.writeFileSync('new.txt', 'changed', 'utf8');

        expect(tree.changes()).to.have.lengthOf(1);
        expect(tree.changes()[0][0]).to.equal('create');
      });

      it('tracks nothing when a removed directory is re-created', function() {
        expect(tree.changes()).to.have.lengthOf(0);

        tree.rmdirSync('another-directory');

        expect(tree.changes()).to.have.lengthOf(1);
        expect(tree.changes()[0][0]).to.equal('rmdir');

        tree.mkdirSync('another-directory');

        expect(tree.changes()).to.have.lengthOf(0);
      });

      it('tracks nothing when a newly-created directory is removed', function() {
        expect(tree.changes()).to.have.lengthOf(0);

        tree.mkdirSync('foo');

        expect(tree.changes()).to.have.lengthOf(1);
        expect(tree.changes()[0][0]).to.equal('mkdir');

        tree.rmdirSync('foo');

        expect(tree.changes()).to.have.lengthOf(0);
      });

      it('tracks only an unlink when a changed file is unlinked', function() {
        expect(tree.changes()).to.have.lengthOf(0);

        tree.writeFileSync('hello.txt', 'changed', 'utf8');

        expect(tree.changes()).to.have.lengthOf(1);
        expect(tree.changes()[0][0]).to.equal('change');

        tree.unlinkSync('hello.txt');

        expect(tree.changes()).to.have.lengthOf(1);
        expect(tree.changes()[0][0]).to.equal('unlink');
      });

      it('tracks nothing when a newly-created file is unlinked', function() {
        expect(tree.changes()).to.have.lengthOf(0);

        tree.writeFileSync('foo.txt', 'foo', 'utf8');

        expect(tree.changes()).to.have.lengthOf(1);
        expect(tree.changes()[0][0]).to.equal('create');

        tree.unlinkSync('foo.txt');

        expect(tree.changes()).to.have.lengthOf(0);
      });
    });

    describe('.changes()', function() {
      beforeEach(function() {
        clearChanges(tree);
      });

      it('picks up created files', function() {
        tree.writeFileSync('new.txt', 'new', 'utf8');

        expect(sanitizeChanges(tree.changes())).to.deep.equal(sanitizeChanges([
          [ 'create', 'new.txt' ],
        ]));
      });

      it('picks up changed files', function() {
        tree.writeFileSync('hello.txt', 'Hello, again!\n', 'utf8');

        expect(sanitizeChanges(tree.changes())).to.deep.equal(sanitizeChanges([
          [ 'change', 'hello.txt' ],
        ]));
      });

      it('picks up created directories', function() {
        tree.mkdirSync('new');

        expect(sanitizeChanges(tree.changes())).to.deep.equal(sanitizeChanges([
          [ 'mkdir', 'new' ],
        ]));
      });

      it('picks up deleted directories', function() {
        tree.rmdirSync('empty');

        expect(sanitizeChanges(tree.changes())).to.deep.equal(sanitizeChanges([
          [ 'rmdir', 'empty' ],
        ]));
      });

      it('picks up deleted files', function() {
        tree.unlinkSync('hello.txt');

        expect(sanitizeChanges(tree.changes())).to.deep.equal(sanitizeChanges([
          [ 'unlink', 'hello.txt' ],
        ]));
      });

      it('includes changes from new symlinks', function() {
        const tree2 = writableTreeFromFixture({});

        tree2.symlinkToFacadeSync(tree, 'my-directory', 'linked-directory');

        expect(sanitizeChanges(tree2.changes())).to.deep.equal(sanitizeChanges([
          [ 'mkdir', 'linked-directory' ],
          [ 'create', 'linked-directory/bar.js' ],
          [ 'create', 'linked-directory/foo.txt' ],
          [ 'mkdir', 'linked-directory/subdir' ],
          [ 'create', 'linked-directory/subdir/baz.js' ],
        ]));
      });

      it('includes changes from old symlinks', function() {
        const tree2 = writableTreeFromFixture({});

        tree2.symlinkToFacadeSync(tree, 'my-directory', 'linked-directory');

        clearChanges(tree);
        clearChanges(tree2);

        tree.writeFileSync('my-directory/new.txt', 'new', 'utf8');

        expect(sanitizeChanges(tree2.changes())).to.deep.equal(sanitizeChanges([
          [ 'create', 'linked-directory/new.txt' ],
        ]));
      });
    });

    describe('.chdir()', function() {
      it('can target symlinks', function() {
        const tree2 = writableTreeFromFixture({});

        tree2.symlinkToFacadeSync(tree, 'my-directory', 'linked-directory');

        expect(tree2.chdir('linked-directory').paths).to.deep.equal([
          'bar.js',
          'foo.txt',
          'subdir',
          'subdir/baz.js',
        ]);
      });

      it('can cross symlinks', function() {
        const tree2 = writableTreeFromFixture({});

        tree2.symlinkToFacadeSync(tree, 'my-directory', 'linked-directory');

        expect(tree2.chdir('linked-directory/subdir').paths).to.deep.equal([
          'baz.js',
        ]);
      });

      it('can cross root symlinks', function() {
        const tree2 = writableTreeFromFixture({});

        tree2.symlinkToFacadeSync(tree, 'my-directory', '');

        expect(tree2.chdir('subdir').paths).to.deep.equal([
          'baz.js',
        ]);
      });

      // This replicates a scenario discovered in `ember new`.
      it('can cross complex symlinks', function() {
        const tree1 = writableTreeFromFixture({ 'hello.txt': 'hello', 'my-directory': {} });
        const tree2 = writableTreeFromFixture({});
        const tree3 = sourceTreeFromFixture({ 'foo.css': 'foo {}' });

        tree2.mkdirSync('baz');
        tree2.symlinkToFacadeSync(tree3, '', 'baz/bar');
        tree1.symlinkToFacadeSync(tree2, 'baz', 'abc');

        const projection = tree1.chdir('abc/bar');

        expect(sanitizeChanges(projection.changes())).to.deep.equal(sanitizeChanges([
          [ 'create', 'foo.css' ],
        ]));
      });

      // This replicates a scenario discovered in `ember new`.
      it('can cross complex root symlinks', function() {
        const tree1 = writableTreeFromFixture({ 'hello.txt': 'hello', 'my-directory': {} });
        const tree2 = writableTreeFromFixture({});
        const tree3 = sourceTreeFromFixture({ bar: { 'foo.js': 'let foo;' } });

        tree2.symlinkToFacadeSync(tree3, '', '');
        tree1.symlinkToFacadeSync(tree2, '', 'my-directory/baz');

        const projection = tree1.chdir('my-directory');

        expect(sanitizeEntries(projection.entries)).to.deep.equal(sanitizeEntries([
          directory('baz'),
          directory('baz/bar'),
          file('baz/bar/foo.js'),
        ]));
      });
    });

    describe('.emptySync()', function() {
      let tree2;

      function worksOn(label, path_, changeCount) {
        it(`works on ${label}`, function() {
          tree2.emptySync(path_);

          expect(tree2.readdirSync(path_)).to.be.empty;
        });

        it(`tracks the correct number of changes when working on ${label}`, function() {
          clearChanges(tree);
          clearChanges(tree2);

          tree2.emptySync(path_);

          expect(tree2.changes()).to.have.lengthOf(changeCount);
        });
      }

      beforeEach(function() {
        tree2 = writableTreeFromFixture({
          'empty': {},

          'has-regular-file': {
            'file.txt': 'file',
          },

          'has-empty-directory': {
            'subdir': {},
          },

          'has-filled-directory': {
            'subdir': {
              'file.txt': 'file',
            },
          },

          'has-directory-link': {}, // link created below
          'has-file-link': {}, // link created below
        });

        tree2.symlinkToFacadeSync(tree, 'empty', 'has-directory-link/linked-directory');
        tree2.symlinkToFacadeSync(tree, 'hello.txt', 'has-file-link/linked.txt');
      });

      defineCommonWriteTests((tree, path_) => tree.emptySync(path_), {
        allowRoot: true,

        // emptySync doesn't have a simple 1:1 relationship between calls and tracked changes
        checkTracking: false,

        directories: true,
        files: false,
        mustExist: true,
      });

      worksOn('already-empty directories', 'empty', 0);
      worksOn('directories containing regular files', 'has-regular-file', 1);
      worksOn('directories containing empty directories', 'has-empty-directory', 1);
      worksOn('directories containing filled directories', 'has-filled-directory', 2);
      worksOn('directories containing linked directories', 'has-directory-link', 1);
      worksOn('directories containing linked files', 'has-file-link', 1);
      worksOn('root', '', 12);

      it('only empties the requested directory', function() {
        tree2.emptySync('has-regular-file');

        expect(tree2.readdirSync('has-filled-directory')).to.deep.equal([ 'subdir' ]);
      });
    });

    describe('.filtered', function() {
      it('includes matching files from symlinked directories', function() {
        const tree2 = writableTreeFromFixture({
          'foo.js': 'let foo;',
        });

        tree2.symlinkToFacadeSync(tree, 'my-directory', 'quux');

        expect(tree2.filtered({ include: [ '**/*.js' ] }).paths).to.deep.equal([
          'foo.js',
          'quux',
          'quux/bar.js',
          'quux/subdir',
          'quux/subdir/baz.js',
        ]);
      });
    });

    describe('.mkdirSync()', function() {
      defineCommonWriteTests((tree, path_) => tree.mkdirSync(path_), {
        directories: true,
        files: false,
        mustExist: false,
      });

      it('works', function() {
        tree.mkdirSync('foo');

        expect(tree.existsSync('foo')).to.be.true;
      });

      it('throws if a symlinked directory already exists', function() {
        const tree2 = writableTreeFromFixture({});

        tree2.symlinkToFacadeSync(tree, 'my-directory', 'linked-directory');

        expect(() => tree2.mkdirSync('linked-directory')).to.throw(/\bsymlinks?\b/i);
      });

      it('throws if a symlinked file already exists', function() {
        const tree2 = writableTreeFromFixture({});

        tree2.symlinkToFacadeSync(tree, 'hello.txt', 'linked.txt');

        expect(() => tree2.mkdirSync('linked.txt')).to.throw(/\bsymlinks?\b/i);
      });
    });

    describe('.mkdirpSync()', function() {
      defineCommonWriteTests((tree, path_) => tree.mkdirpSync(path_), {
        allowMissingParent: true,
        directories: true,
        files: false,
        mustExist: false,
      });

      it('works', function() {
        tree.mkdirpSync('foo/bar/baz');

        expect(tree.existsSync('foo/bar/baz')).to.be.true;
      });

      it('throws if a symlinked directory already exists', function() {
        const tree2 = writableTreeFromFixture({});

        tree2.symlinkToFacadeSync(tree, 'my-directory', 'linked-directory');

        expect(() => tree2.mkdirpSync('linked-directory')).to.throw(/\bsymlinks?\b/i);
      });

      it('throws if a symlinked file already exists', function() {
        const tree2 = writableTreeFromFixture({});

        tree2.symlinkToFacadeSync(tree, 'hello.txt', 'linked.txt');

        expect(() => tree2.mkdirpSync('linked.txt')).to.throw(/\bsymlinks?\b/i);
      });
    });

    describe('.readFileSync()', function() {
      it('does not throw when the tree is stopped', function() {
        tree.stop();

        expect(() => tree.readFileSync('hello.txt', 'utf8')).to.not.throw();
      });

      it('works across symlinked directories', function() {
        const tree2 = writableTreeFromFixture({});

        tree2.symlinkToFacadeSync(tree, 'my-directory', 'linked-directory');

        expect(tree2.readFileSync('linked-directory/foo.txt', 'utf8')).to.equal('foo');
      });

      it('works across symlinked files', function() {
        const tree2 = writableTreeFromFixture({});

        tree2.symlinkToFacadeSync(tree, 'hello.txt', 'linked.txt');

        expect(tree2.readFileSync('linked.txt', 'utf8')).to.equal('Hello, World!\n');
      });
    });

    describe('.readdirSync()', function() {
      it('does not throw when the tree is stopped', function() {
        tree.stop();

        expect(() => tree.readdirSync('my-directory', 'utf8')).to.not.throw();
      });

      it('works on symlinked directories', function() {
        const tree2 = writableTreeFromFixture({});

        tree2.symlinkToFacadeSync(tree, 'my-directory', 'linked-directory');

        expect(tree2.readdirSync('linked-directory')).to.deep.equal([
          'bar.js',
          'foo.txt',
          'subdir',
        ]);
      });

      it('works across symlinked directories', function() {
        const tree2 = writableTreeFromFixture({});

        tree2.symlinkToFacadeSync(tree, 'my-directory', 'linked-directory');

        expect(tree2.readdirSync('linked-directory/subdir')).to.deep.equal([
          'baz.js',
        ]);
      });
    });

    describe('.reread()', function() {
      defineRereadChainingTest();

      it('throws when attempting to change the root', function() {
        expect(() => tree.reread(getTempRoot())).to.throw(/\broot\b/i);
      });
    });

    describe('.rmdirSync()', function() {
      defineCommonWriteTests((tree, path_) => {
        tree.rmdirSync(path_);
      }, {
        directories: true,
        files: false,
        mustExist: true,
      });

      it('works on a directory', function() {
        tree.rmdirSync('empty');

        expect(tree.existsSync('empty')).to.be.false;
      });

      it('throws when removing a regular file', function() {
        expect(() => tree.rmdirSync('hello.txt')).to.throw(/\bENOTDIR\b/);
      });

      it('throws when removing a symlinked directory', function() {
        const tree2 = writableTreeFromFixture({});

        tree2.symlinkToFacadeSync(tree, 'my-directory', 'linked-directory');

        expect(() => tree2.rmdirSync('linked-directory')).to.throw(/\bsymlinks?\b/i);
      });

      it('throws when removing a symlinked file', function() {
        const tree2 = writableTreeFromFixture({});

        tree2.symlinkToFacadeSync(tree, 'hello.txt', 'linked.txt');

        expect(() => tree2.rmdirSync('linked.txt')).to.throw(/\bsymlinks?\b/i);
      });
    });

    describe('.start()', function() {
      it('resets tracked changes', function() {
        expect(sanitizeChanges(tree.changes())).to.deep.equal(changesFromFixture(FIXTURE));

        tree.start();

        expect(tree.changes()).to.be.empty;
      });
    });

    describe('.statSync()', function() {
      it('works across symlinked directories', function() {
        const tree2 = writableTreeFromFixture({});

        tree2.symlinkToFacadeSync(tree, 'my-directory', 'linked-directory');

        const expected = tree.statSync('my-directory/foo.txt');
        const actual = tree2.statSync('linked-directory/foo.txt');

        expect(actual.mode).to.equal(expected.mode);
        expect(actual.mtime.getTime()).to.equal(expected.mtime.getTime());
        expect(actual.size).to.equal(expected.size);
      });

      it('works across symlinked files', function() {
        const tree2 = writableTreeFromFixture({});

        tree2.symlinkToFacadeSync(tree, 'hello.txt', 'linked.txt');

        const expected = tree.statSync('hello.txt');
        const actual = tree2.statSync('linked.txt');

        expect(actual.mode).to.equal(expected.mode);
        expect(actual.mtime.getTime()).to.equal(expected.mtime.getTime());
        expect(actual.size).to.equal(expected.size);
      });
    });

    describe('.symlinkSync()', function() {
      const root = getTempRoot();
      const targetDirectory = path.join(root, 'foo');
      const targetFile = path.join(root, 'bar.txt');

      beforeEach(function() {
        fs.mkdirpSync(targetDirectory);
        fs.writeFileSync(targetFile, 'bar', 'utf8');
      });

      defineCommonWriteTests((tree, path_) => tree.symlinkSync(targetFile, path_), {
        directories: true,
        files: true,
        mustExist: false,
      });

      it('works when linking to a directory', function() {
        tree.symlinkSync(targetDirectory, 'linked-directory');

        expect(tree.existsSync('linked-directory')).to.be.true;
      });

      it('works when linking to a file', function() {
        tree.symlinkSync(targetFile, 'linked.txt');

        expect(tree.existsSync('linked.txt')).to.be.true;
      });

      it('throws when creating a broken link', function() {
        expect(() => tree.symlinkSync(path.join(root, 'does-not-exist'), 'broken')).to.throw(/\bENOENT\b/);
      });
    });

    describe('.symlinkToFacadeSync()', function() {
      let tree2;

      beforeEach(function() {
        tree.writeFileSync('my-directory/foo.txt', 'foo', 'utf8');

        tree2 = writableTreeFromFixture({});
      });

      defineCommonWriteTests((sourceTree, path_) => sourceTree.symlinkToFacadeSync(tree, 'hello.txt', path_), {
        allowRoot: true,
        directories: true,
        files: true,
        mustExist: false,
      });

      it('works when linking to a directory', function() {
        tree2.symlinkToFacadeSync(tree, 'my-directory', 'linked-directory');

        expect(tree2.readFileSync('linked-directory/foo.txt', 'utf8')).to.equal('foo');
      });

      it('works when linking to a file', function() {
        tree2.symlinkToFacadeSync(tree, 'hello.txt', 'linked.txt');

        expect(tree2.readFileSync('linked.txt', 'utf8')).to.equal('Hello, World!\n');
      });

      it('works when linking to root', function() {
        tree2.symlinkToFacadeSync(tree, '', 'linked-directory');

        expect(tree2.readFileSync('linked-directory/hello.txt', 'utf8')).to.equal('Hello, World!\n');
      });

      describe('when linking from root', function() {
        it('works', function() {
          tree2.symlinkToFacadeSync(tree, 'my-directory', '');

          expect(tree2.readFileSync('foo.txt', 'utf8')).to.equal('foo');
        });

        it('changes the source tree into a Delegator', function() {
          tree2.symlinkToFacadeSync(tree, 'my-directory', '');

          expect(tree2).to.be.an.instanceOf(fstree.Delegator);
        });

        it('throws if the source tree contains a directory', function() {
          tree2.mkdirSync('foo');

          expect(() => tree2.symlinkToFacadeSync(tree, 'my-directory', '')).to.throw(/\bENOTEMPTY\b/);
        });

        it('throws if the source tree contains a file', function() {
          tree2.writeFileSync('foo.txt', 'foo', 'utf8');

          expect(() => tree2.symlinkToFacadeSync(tree, 'my-directory', '')).to.throw(/\bENOTEMPTY\b/);
        });

        it('throws if the target is a file', function() {
          expect(() => tree2.symlinkToFacadeSync(tree, 'hello.txt', '')).to.throw(/\bENOTDIR\b/);
        });
      });

      it('throws when overwriting a symlinked directory', function() {
        const tree2 = writableTreeFromFixture({});

        tree2.symlinkToFacadeSync(tree, 'my-directory', 'linked-directory');

        expect(() => tree2.symlinkToFacadeSync(tree, 'my-directory', 'linked-directory')).to.throw(/\bsymlinks?\b/i);
      });

      it('throws when overwriting a symlinked file', function() {
        const tree2 = writableTreeFromFixture({});

        tree2.symlinkToFacadeSync(tree, 'hello.txt', 'linked.txt');

        expect(() => tree2.symlinkToFacadeSync(tree, 'hello.txt', 'linked.txt')).to.throw(/\bsymlinks?\b/i);
      });
    });

    describe('.unlinkSync()', function() {
      defineCommonWriteTests((tree, path_) => tree.unlinkSync(path_), {
        directories: false,
        eperm: true,
        files: true,
        mustExist: true,
      });

      it('works on regular files', function() {
        tree.unlinkSync('hello.txt');

        expect(tree.existsSync('hello.txt')).to.be.false;
      });

      it('works on symlinked directories', function() {
        const tree2 = writableTreeFromFixture({});

        tree2.symlinkToFacadeSync(tree, 'my-directory', 'linked-directory');

        expect(tree2.existsSync('linked-directory')).to.be.true;

        tree2.unlinkSync('linked-directory');

        expect(tree2.existsSync('linked-directory')).to.be.false;
      });

      it('works on symlinked files', function() {
        const tree2 = writableTreeFromFixture({});

        tree2.symlinkToFacadeSync(tree, 'hello.txt', 'linked.txt');

        expect(tree2.existsSync('linked.txt')).to.be.true;

        tree2.unlinkSync('linked.txt');

        expect(tree2.existsSync('linked.txt')).to.be.false;
      });
    });

    describe('.writeFileSync()', function() {
      defineCommonWriteTests((tree, path_) => tree.writeFileSync(path_, 'new', 'utf8'), {
        directories: false,
        files: true,
        mustExist: false,
      });

      it('works', function() {
        tree.writeFileSync('new.txt', 'new', 'utf8');

        expect(tree.readFileSync('new.txt', 'utf8')).to.equal('new');
      });

      it('does not write a new file when the content matches the old file', async function() {
        const expected = tree.statSync('hello.txt');

        // Ensure that at least one millisecond passes so that the mtimes could not be the same.
        await new Promise((resolve) => setTimeout(resolve, 1));

        tree.writeFileSync('hello.txt', 'Hello, World!\n', 'utf8');

        const actual = tree.statSync('hello.txt');

        expect(actual.mode).to.equal(expected.mode);
        expect(actual.mtime.getTime()).to.equal(expected.mtime.getTime());
        expect(actual.size).to.equal(expected.size);
      });

      it('does not track a change when the content matches the old file', function() {
        clearChanges(tree);

        tree.writeFileSync('hello.txt', 'Hello, World!\n', 'utf8');

        expect(tree.changes()).to.have.lengthOf(0);
      });

      it('throws when writing to a symlinked directory', function() {
        const tree2 = writableTreeFromFixture({});

        tree2.symlinkToFacadeSync(tree, 'my-directory', 'linked-directory');

        expect(() => tree2.writeFileSync('linked-directory', 'new', 'utf8')).to.throw(/\bsymlinks?\b/i);
      });

      it('throws when writing to a symlinked file', function() {
        const tree2 = writableTreeFromFixture({});

        tree2.symlinkToFacadeSync(tree, 'hello.txt', 'linked.txt');

        expect(() => tree2.writeFileSync('linked.txt', 'new', 'utf8')).to.throw(/\bsymlinks?\b/i);
      });
    });
  });
});
