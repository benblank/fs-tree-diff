'use strict';

const expect = require('chai').expect;
const oneLine = require('common-tags').oneLine;
const fixturify = require('fixturify');
const fs = require('fs-extra');
const md5hex = require('md5hex');
const path = require('path');
const rimraf = require('rimraf');
const sinon = require('sinon');

const fstree = require('../../lib');
const Entry = require('../../lib/entry');
const shared = require('../../lib/shared');
const helpers = require('./helpers');

const directory = helpers.directory;
const file = helpers.file;
const treeFromDisk = helpers.treeFromDisk;

require('chai').config.truncateThreshold = 0;

/** Convert an array of changes into the structures used by WritableTree.
 *
 * The changes are sanitized prior to conversion.
 *
 * @param {WritableTree} tree The tree which will contain the changes.
 * @param {Change[]} changes The array of changes to convert.
 */
function compileChanges(tree, changes) {
  const sanitized = sanitizeChanges(changes);

  let previous = undefined;

  tree._firstChange = sanitized[0];
  tree._lastChange = sanitized[sanitized.length - 1];

  tree._changeHash = sanitized.reduce((hash, change) => {
    if (previous) {
      previous[4] = change;
    }

    change[3] = previous;
    previous = change;

    hash[change[0]][change[1]] = change;

    return hash;
  }, {
    change: {},
    create: {},
    mkdir: {},
    rmdir: {},
    unlink: {},
  });

  if (tree._lastChange) {
    // Otherwise, there will only be 4 elements.
    tree._lastChange[4] = undefined;
  }
}

/** Convert an array of changes into simpler, more comparable objects.
 *
 * Sanitizes paths and entries using sanitizePath and sanitizeEntry.
 *
 * If no entry is provided with a change (i.e. the change contains only two
 * elements), an entry will be created based on the operation.
 */
function sanitizeChanges(changes) {
  return changes.map(change => {
    let entry = change[2];

    if (!entry) {
      entry = /mkdir|rmdir/.test(change[0]) ? directory(change[1]) : file(change[1]);
    }

    return [change[0], sanitizePath(change[1]), sanitizeEntry(entry)];
  });
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
  return new Entry(sanitizePath(entry.relativePath), undefined, 0, sanitizeMode(entry.mode));
}

/** Sanitize a path by removing trailing slash, if present. */
function sanitizePath(path_) {
  return path_.replace(/\/$/, '');
}

/** Sanitize an array of paths using sanitizePath. */
function sanitizePaths(paths) {
  return paths.map(sanitizePath);
}

/** Discard permission bits in mode.
 *
 * Sanitizes a mode by retaining only the type bits.  Further, normal files are
 * translated to a mode of 0, as is the conventional representation in this
 * library.
 */
function sanitizeMode(mode) {
  return mode & 61440;  // only retain type bits
}

describe('fs abstraction', () => {
  const ROOT = path.resolve('tmp/fs-test-root');
  const ROOT2 = path.resolve('tmp/fs-test-root2');
  const ROOT3 = path.resolve('tmp/fs-test-root3');

  const originalNow = Date.now;

  let tree;   // Used in most tests.
  let tree2;  // Used in tests which employ symlinkToFacadeSync.
  let tree3;  // Used in a few tests which symlinkToFacadeSync multiple trees.

  beforeEach(() => {
    Date.now = (() => 0);

    rimraf.sync(ROOT);
    rimraf.sync(ROOT2);
    rimraf.sync(ROOT3);

    fs.mkdirpSync(ROOT);
    fs.mkdirpSync(ROOT2);
    fs.mkdirpSync(ROOT3);

    fixturify.writeSync(ROOT, {
      'hello.txt': 'Hello, World!\n',
      'my-directory': {},
    });

    tree = treeFromDisk(ROOT);
    tree2 = treeFromDisk(ROOT2);
    tree3 = treeFromDisk(ROOT3);
  });

  afterEach(() => {
    Date.now = originalNow;

    fs.removeSync(ROOT);
    fs.removeSync(ROOT2);
    fs.removeSync(ROOT3);
  });

  describe('fs', () => {
    describe('.reread', () => {
      it('resets entries for SourceTrees', () => {
        tree = treeFromDisk(`${ROOT}/my-directory`, fstree.SourceTree);

        expect(sanitizePaths(tree.paths)).to.deep.equal([]);

        fixturify.writeSync(`${ROOT}/my-directory`, {
          a: {
            b: 'hello',
          },
          a2: 'guten tag'
        });

        tree.reread();

        expect(sanitizePaths(tree.paths)).to.deep.equal([
          'a',
          'a/b',
          'a2'
        ]);
      });

      it('does not reset entries for writable trees', () => {
        tree = treeFromDisk(`${ROOT}/my-directory`);

        expect(sanitizePaths(tree.paths)).to.deep.equal([]);

        fixturify.writeSync(`${ROOT}/my-directory`, {
          a: {
            b: 'hello',
          },
          a2: 'guten tag'
        });

        tree.reread();

        expect(sanitizePaths(tree.paths)).to.deep.equal([]);
      });

      it('does not reset entries for writable trees when new root matches old root', () => {
        tree = treeFromDisk(`${ROOT}/my-directory`);

        expect(sanitizePaths(tree.paths)).to.deep.equal([]);

        fixturify.writeSync(`${ROOT}/my-directory`, {
          a: {
            b: 'hello',
          },
          a2: 'guten tag'
        });

        tree.reread(`${ROOT}/my-directory`);

        expect(sanitizePaths(tree.paths)).to.deep.equal([]);
      });

      it('can change roots for SourceTrees', () => {
        fixturify.writeSync(`${ROOT}/my-directory`, {
          a: {
            b: 'hello',
          },
          a2: 'guten tag',
        });

        tree = new fstree.SourceTree({ root: `${ROOT}/my-directory` });

        expect(sanitizePaths(tree.paths)).to.deep.equal([
          'a',
          'a/b',
          'a2'
        ]);

        tree.reread(`${ROOT}/my-directory/a`);

        expect(sanitizePaths(tree.paths)).to.deep.equal([
          'b',
        ]);

        expect(tree.root).to.equal(`${ROOT}/my-directory/a`);
      });

      it('cannot change roots for SourceTrees without providing absolute path', () => {
        tree = new fstree.SourceTree({ root: `${ROOT}` });

        expect(() => {
          tree.reread('tmp/fs-test-root/my-directory/a');
        }).to.throw(`Root must be an absolute path, not 'tmp/fs-test-root/my-directory/a'`);
      });

      it('throws if called with a new root for a writable tree', () => {
        fixturify.writeSync(`${ROOT}/my-directory`, {
          a: {
            b: 'hello',
          },
          a2: 'guten tag'
        });

        tree = treeFromDisk(`${ROOT}/my-directory`);

        expect(() => {
          tree.reread(`${ROOT}/my-directory/a`);
        }).to.throw(oneLine`
          Cannot change root from '${ROOT}/my-directory'
          to '${ROOT}/my-directory/a' of a writable tree.
        `);
      });

      it('is no-op for trees with parents', () => {
        tree = treeFromDisk(ROOT, fstree.SourceTree);
        tree2 = tree.chdir('my-directory');

        expect(sanitizePaths(tree2.paths)).to.deep.equal([]);

        fixturify.writeSync(`${ROOT}/my-directory`, {
          a: {
            b: 'hello',
          },
          a2: 'guten tag'
        });

        tree2.reread();

        expect(sanitizePaths(tree2.paths)).to.deep.equal([]);
      });
    });

    describe('._findByRelativePath', () => {
      it('missing file', () => {
        expect(tree._findByRelativePath('missing/file')).to.deep.equal({
          entry: null,
          tree: null,
        });
      });

      it('file', () => {
        let result = tree._findByRelativePath('hello.txt');
        let entry = result.entry;

        expect(entry).to.not.be.null;
        expect(entry).to.have.property('relativePath', 'hello.txt');
        expect(entry).to.have.property('mode');
        expect(entry).to.have.property('size');
        expect(entry).to.have.property('mtime');
      });

      it('missing directory', () => {
        expect(tree._findByRelativePath('missing/directory')).to.deep.equal({
          entry: null,
          tree: null,
        });
      });

      it('directory with trailing slash', () => {
        const result = tree._findByRelativePath('my-directory/');
        const entry = result.entry;

        expect(entry).to.not.be.null;
        expect(entry).to.have.property('relativePath', 'my-directory');
        expect(entry).to.have.property('mode');
        expect(entry).to.have.property('size');
        expect(entry).to.have.property('mtime');
      });

      it('directory without trailing slash', () => {
        let result = tree._findByRelativePath('my-directory');
        let entry = result.entry;

        expect(entry).to.not.be.null;
        // we can _findByRelativePath without the trailing /, but we get back the
        // same entry we put in, from walk-sync this will have a trailing /
        expect(entry).to.have.property('relativePath', 'my-directory');
        expect(entry).to.have.property('mode');
        expect(entry).to.have.property('size');
        expect(entry).to.have.property('mtime');
      });

      it('finds root', () => {
        const result = tree._findByRelativePath('');

        expect(result.entry).to.equal(Entry.ROOT);
      });

      it('normalizes paths', () => {
        expect(tree._findByRelativePath('my-directory/').entry).to.not.be.null;
        expect(tree._findByRelativePath('my-directory/.').entry).to.not.be.null;
        expect(tree._findByRelativePath('my-directory/foo/..').entry).to.not.be.null;
      });

      it('get entry for file from symlinks', () => {
        tree.mkdirSync('my-directory/bar');
        tree.writeFileSync('my-directory/bar/baz', 'hello');
        tree2.symlinkToFacadeSync(tree, 'my-directory', 'b')

        expect(tree2._findByRelativePath('b/bar/baz').entry).to.not.be.null;
      });

      it('get entry for a directory from symlinks', () => {
        tree.mkdirpSync('my-directory/bar/baz/');
        tree2.symlinkToFacadeSync(tree, 'my-directory', 'b')

        expect(tree2._findByRelativePath('b/bar/baz/').entry).to.not.be.null;
      });

      it('get entry for a file missing in symlinks', () => {
        tree.mkdirSync('my-directory/bar');
        tree.writeFileSync('my-directory/bar/baz', 'hello');
        tree2.symlinkToFacadeSync(tree, 'my-directory', 'b')

        expect(tree2._findByRelativePath('b/bar/baz/abc').entry).to.be.null;
      });

      it('get entry for a directory found in second level symlinks', () => {
        tree.mkdirpSync('my-directory/bar/baz');
        tree2.mkdirSync('a');
        tree2.symlinkToFacadeSync(tree, 'my-directory/bar', 'a/foo');
        tree3.symlinkToFacadeSync(tree2, 'a', 'b');

        expect(tree3._findByRelativePath('b/foo/baz').entry).to.not.be.null;
      });

      it('correctly travserses root links', () => {
        tree2.symlinkToFacadeSync(tree, '', 'abc')

        expect(tree2._findByRelativePath('abc/my-directory').entry).to.not.be.null;
      });
    });

    it('does not allow non-absolute paths', () => {
      expect(() => {
        new fstree.WritableTree({ root: null });
      }).to.throw(`Root must be an absolute path, not 'null'`);

      expect(() => {
        new fstree.WritableTree({ root: '' })
      }).to.throw(`Root must be an absolute path, not ''`);

      expect(() => {
        new fstree.WritableTree({ root: 'foo' })
      }).to.throw(`Root must be an absolute path, not 'foo'`);
    });

    it('ensures no trailing slash for root', () => {
      expect(new fstree.WritableTree({ root: '/foo' }).root).to.equal('/foo');
      expect(new fstree.WritableTree({ root: '/foo/' }).root).to.equal('/foo');
      expect(new fstree.WritableTree({ root: '/foo//' }).root).to.equal('/foo');
    });

    describe('.readFileSync', () => {
      describe('start/stop', () => {
        it('does not error when stopped', () => {
          tree.stop();
          expect(tree.readFileSync('hello.txt', 'UTF8')).to.equal('Hello, World!\n');
        });
      });

      it('reads existing file', () => {
        expect(tree.readFileSync('hello.txt', 'UTF8')).to.equal('Hello, World!\n');
      });

      it('throws for missing file', () => {
        expect(() => {
          tree.readFileSync('missing.txt', 'UTF8');
        }).to.throw('ENOENT: no such file or directory, open \'missing.txt\'');
      });

      describe('from symlinks', () => {
        it('reads file in a symlinked directory', () => {
          tree.writeFileSync('my-directory/baz.txt', 'baz');
          tree2.symlinkToFacadeSync(tree, 'my-directory', 'c');

          expect(tree2._findByRelativePath('c/baz.txt').entry).to.not.be.null;
          expect(tree2.readFileSync('c/baz.txt', 'UTF8')).to.equal('baz');
        });

        it('reads symlinked files', () => {
          tree2.symlinkToFacadeSync(tree, 'hello.txt', 'hello2.txt');

          expect(tree2.readFileSync('hello2.txt', 'utf8')).to.equal('Hello, World!\n');
        });
      });
    });

    describe('.writeFileSync', () => {
      it('throws when stopped', () => {
        tree.stop();

        expect(() => {
          tree.writeFileSync('hello.txt', 'OMG');
        }).to.throw(/stopped/);

        expect(() => {
          tree.writeFileSync('hello.txt', 'OMG');
        }).to.throw(/writeFile/);
      });

      it('adds new file', () => {
        expect(sanitizePaths(tree.paths)).to.deep.equal([
          'hello.txt',
          'my-directory',
        ]);

        tree.writeFileSync('new-file.txt', 'new file');

        const entry = tree._findByRelativePath('new-file.txt').entry;

        expect(entry).to.not.be.null;
        expect(entry.relativePath).to.equal('new-file.txt');
        expect(entry.checksum).to.equal(md5hex('new file'));
        expect(entry.mode).to.equal(Entry.FILE_MODE);
        expect(entry).to.have.property('mtime');
        expect(tree.readFileSync('new-file.txt', 'UTF8')).to.equal('new file');

        expect(sanitizePaths(tree.paths)).to.deep.equal([
          'hello.txt',
          'my-directory',
          'new-file.txt',
        ]);
      });

      it('tracks a change', () => {
        expect(tree.changes()).to.deep.equal([]);

        tree.writeFileSync('new-file.txt', 'new file');

        expect(sanitizeChanges(tree.changes())).to.deep.equal(sanitizeChanges([
          ['create', 'new-file.txt'],
        ]));
      });

      describe('idempotent', () => {
        it('is idempotent files added this session', () => {
          const old = fs.statSync(path.join(tree.root, 'hello.txt'));
          const oldContent = fs.readFileSync(path.join(tree.root, 'hello.txt'));

          tree.writeFileSync('hello.txt', oldContent);

          const current = fs.statSync(path.join(tree.root, 'hello.txt'));

          expect(old.mtime.getTime()).to.equal(current.mtime.getTime());
          expect(old.mode).to.equal(current.mode);
          expect(old.size).to.equal(current.size);
          expect(tree.changes()).to.deep.equal([]);

          expect(sanitizePaths(tree.paths)).to.deep.equal([
            'hello.txt',
            'my-directory',
          ]);
        });

        it('is idempotent across session', () => {
          tree.writeFileSync('new-file.txt', 'new file');

          const oldChanges = tree.changes();

          tree.writeFileSync('new-file.txt', 'new file');

          expect(oldChanges).to.deep.equal(tree.changes());
        });
      });

      describe('update', () => {
        it('tracks and correctly updates a file -> file', () => {
          tree.writeFileSync('new-file.txt', 'new file');

          let old = fs.statSync(path.join(tree.root, 'new-file.txt'));

          tree.stop();
          tree.start();
          tree.writeFileSync('new-file.txt', 'new different content');

          let current = fs.statSync(path.join(tree.root, 'new-file.txt'));

          expect(current).to.have.property('mtime');
          expect(current.mode).to.equal(old.mode);
          expect(current.size).to.equal(21);

          expect(sanitizeChanges(tree.changes())).to.deep.equal(sanitizeChanges([
            ['change', 'new-file.txt'],
          ]));
        });
      });

      it('throws across symlinks', () => {
        tree.symlinkToFacadeSync(tree, 'my-directory', 'other-directory');

        expect(() => {
          tree.writeFileSync('other-directory/foo.txt', 'foo');
        }).to.throw(/symlink/i);
      });

      it('throws when writing to the tree\'s root', () => {
        expect(() => tree.writeFileSync('', 'foo')).to.throw(/root/);
      });

      it('throws when writing into a non-existent directory', () => {
        expect(() => tree.writeFileSync('foo/bar.txt', 'bar')).to.throw(/ENOENT/);
      });
    });

    describe('.symlinkToFacadeSync', () => {
      it('can link from a directory', () => {
        tree.mkdirSync('my-directory/bar');
        tree.writeFileSync('my-directory/bar/baz.txt', 'baz');
        tree2.symlinkToFacadeSync(tree, 'my-directory', 'b');

        expect(sanitizePaths(tree2.paths)).to.deep.equal([
          'b',
          'b/bar',
          'b/bar/baz.txt',
        ]);
      });

      it('can link from the root of the target tree', () => {
        tree2.symlinkToFacadeSync(tree, '', 'b')

        expect(sanitizePaths(tree2.paths)).to.deep.equal([
          'b',
          'b/hello.txt',
          'b/my-directory'
        ]);
      });

      describe('when linking to the root of the target tree', () => {
        it('succeeds', () => {
          tree2.symlinkToFacadeSync(tree, 'my-directory', '');
          tree.writeFileSync('my-directory/foo.txt', 'foo');

          expect(sanitizePaths(tree2.paths)).to.deep.equal([
            'foo.txt',
          ]);
        });

        it('becomes a Delegator', () => {
          tree2.symlinkToFacadeSync(tree, 'my-directory', '');

          expect(tree2).to.be.an.instanceOf(fstree.Delegator);
        });

        it('sets the target tree\'s delegate', () => {
          tree2.symlinkToFacadeSync(tree, 'my-directory', '');

          expect(tree2._delegate).to.not.be.undefined;
        });

        it('removes the target tree\'s root directory', () => {
          tree2.symlinkToFacadeSync(tree, 'my-directory', '');

          const lstat = fs.lstatSync(tree2._root);

          expect(lstat.mode & 61440).to.not.equal(16384);
        });

        it('creates a symlink at the target tree\'s root', () => {
          tree2.symlinkToFacadeSync(tree, 'my-directory', '');

          const lstat = fs.lstatSync(tree2._root);

          expect(lstat.mode & 61440).to.equal(40960);
        });

        it('throws if the target tree has contents', () => {
          tree2.mkdirSync('foo');

          expect(() => tree2.symlinkToFacadeSync(tree, 'my-directory', '')).to.throw(/ENOTEMPTY/);
        });
      });

      it('can link from a file', () => {
        tree2.symlinkToFacadeSync(tree, 'hello.txt', 'goodbye.txt');

        expect(sanitizePaths(tree2.paths)).to.deep.equal([
          'goodbye.txt',
        ]);
      });

      it('throws across symlinks', () => {
        tree.mkdirSync('foo');
        tree2.symlinkToFacadeSync(tree, 'my-directory', 'other-directory');

        expect(() => {
          tree2.symlinkToFacadeSync(tree, 'foo', 'other-directory/foo');
        }).to.throw(/symlink/i);
      });

      it('throws when symlinking into a non-existent directory', () => {
        expect(() => tree2.symlinkToFacadeSync(tree, 'my-directory', 'foo/bar', 'bar')).to.throw(/ENOENT/);
      });

      it('throws when destDir already exists', () => {
        tree.mkdirSync('my-directory/bar');
        tree.writeFileSync('my-directory/bar/baz', 'hello');
        tree2.mkdirSync('abc');
        tree2.writeFileSync('abc/xyz', 'hello');

        expect(() => {
          tree2.symlinkToFacadeSync(tree, 'my-directory', 'abc');
        }).to.throw(/EEXIST/);

      });

      it('throws when destfile already exists', () => {
        tree2.writeFileSync('b', 'hello');

        expect(() => {
          tree2.symlinkToFacadeSync(tree, 'my-directory', 'b');
        }).to.throw(/EEXIST/);
      });

      it('throws when srcdir does not exist', () => {
        expect(() => {
          tree2.symlinkToFacadeSync(tree, 'a', 'b')
        }).to.throw(/ENOENT/);
      });
    });

    describe('.undoRootSymlinkSync', () => {
      it('becomes a WritableTree', () => {
        tree2.symlinkToFacadeSync(tree, '', '');
        tree2.undoRootSymlinkSync();

        expect(tree2).to.be.an.instanceOf(fstree.WritableTree);
      });

      it('removes delegate', () => {
        tree2.symlinkToFacadeSync(tree, '', '');
        tree2.undoRootSymlinkSync();

        expect(tree2._delegate).to.be.undefined;
      });

      it('removes the symlink', () => {
        tree2.symlinkToFacadeSync(tree, '', '');
        tree2.undoRootSymlinkSync();

        const lstat = fs.lstatSync(tree2.root);

        expect(lstat.mode & 61440).to.not.equal(40960);
      });

      it('recreates the root directory', () => {
        tree2.symlinkToFacadeSync(tree, '', '');
        tree2.undoRootSymlinkSync();

        const lstat = fs.lstatSync(tree2.root);

        expect(lstat.mode & 61440).to.equal(16384);
      });
    });

    describe('.symlinkSync', () => {
      it('symlinks files', () => {
        tree.symlinkSync(path.join(tree.root, 'hello.txt'), 'my-link');

        expect(tree.readFileSync('my-link', 'UTF8')).to.equal('Hello, World!\n');

        expect(sanitizePaths(tree.paths)).to.deep.equal([
          'hello.txt',
          'my-directory',
          'my-link',
        ]);
      });

      it('tracks a change', () => {
        expect(tree.changes()).to.deep.equal([]);

        tree.symlinkSync(path.join(tree.root, 'hello.txt'), 'my-link');

        expect(sanitizeChanges(tree.changes())).to.deep.equal(sanitizeChanges([
          ['create', 'my-link'],
        ]));
      });

      it('throws if the target already exists', () => {
        const source = path.join(ROOT2, 'foo.txt');
        fs.writeFileSync(source, 'foo');

        expect(() => tree.symlinkSync(source, 'hello.txt')).to.throw(/EEXIST/);
      });

      it('throws across symlinks', () => {
        tree.writeFileSync('foo.txt', 'foo');
        tree.symlinkToFacadeSync(tree, 'my-directory', 'other-directory');

        expect(() => {
          tree.symlinkSync(`${tree.root}foo.txt`, 'other-directory/foo.txt');
        }).to.throw(/symlink/i);
      });

      it('throws when symlinking to the tree\'s root', () => {
        expect(() => tree.symlinkSync(ROOT, '')).to.throw(/root/);
      });

      it('throws when symlinking into a non-existent directory', () => {
        expect(() => tree.symlinkSync(ROOT, 'foo/bar')).to.throw(/ENOENT/);
      });
    });

    describe('.unlinkSync', () => {
      it('removes files', () => {
        tree.unlinkSync('hello.txt');

        expect(sanitizePaths(tree.paths)).to.deep.equal([
          'my-directory',
        ]);
      });

      it('tracks a change', () => {
        expect(tree.changes()).to.deep.equal([]);

        tree.unlinkSync('hello.txt');

        expect(sanitizeChanges(tree.changes())).to.deep.equal(sanitizeChanges([
          ['unlink', 'hello.txt'],
        ]));
      });

      it('removes symlinked directories', () => {
        tree.symlinkSync(path.join(tree.root, 'my-directory'), 'linked-dir');
        tree.unlinkSync('linked-dir');

        expect(sanitizePaths(tree.paths)).to.deep.equal([
          'hello.txt',
          'my-directory',
        ]);
      });

      it('removes symlinked-from-entry directories', () => {
        tree2.symlinkToFacadeSync(tree, 'my-directory', 'linked-dir');
        tree2.unlinkSync('linked-dir');

        expect(sanitizePaths(tree2.paths)).to.deep.equal([]);
      });

      it('throws when stopped', () => {
        tree.stop();

        expect(() => {
          tree.unlinkSync('hello.txt');
        }).to.throw(/stopped/);

        expect(() => {
          tree.unlinkSync('hello.txt');
        }).to.throw(/unlink/);
      });

      it('throws across symlinks', () => {
        tree.writeFileSync('my-directory/foo.txt', 'foo');
        tree.symlinkToFacadeSync(tree, 'my-directory', 'other-directory');

        expect(() => {
          tree.unlinkSync('other-directory/foo.txt');
        }).to.throw(/symlink/i);
      });

      it('throws when unlinking the tree\'s root', () => {
        expect(() => tree.unlinkSync('')).to.throw(/root/);
      });
    });

    describe('.rmdirSync', () => {
      it('removes directories', () => {
        expect(sanitizePaths(tree.paths)).to.deep.equal([
          'hello.txt',
          'my-directory',
        ]);

        tree.rmdirSync('my-directory');

        expect(sanitizePaths(tree.paths)).to.deep.equal([
          'hello.txt',
        ]);
      });

      it('tracks a change', () => {
        expect(tree.changes()).to.deep.equal([]);

        tree.rmdirSync('my-directory');

        expect(sanitizeChanges(tree.changes())).to.deep.equal(sanitizeChanges([
          ['rmdir', 'my-directory'],
        ]));
      });

      it('throws for files', () => {
        expect(() => {
          tree.rmdirSync('hello.txt');
        }).to.throw(/ENOTDIR/);
      });

      it('throws when stopped', () => {
        tree.stop();

        expect(() => {
          tree.rmdirSync('hello.txt');
        }).to.throw(/stopped/);

        expect(() => {
          tree.rmdirSync('hello.txt');
        }).to.throw(/rmdir/);
      });

      it('throws across symlinks', () => {
        tree.mkdirSync('my-directory/foo');
        tree2.symlinkToFacadeSync(tree, 'my-directory', 'other-directory');

        expect(() => {
          tree2.rmdirSync('other-directory/foo');
        }).to.throw(/symlink/i);

        it('throws when removing the tree\'s root', () => {
          expect(() => tree.rmdirSync(ROOT, '')).to.throw(/root/);
        });
      });
    });

    describe('.emptySync', () => {
      it('removes directory contents', () => {
        tree.emptySync('');

        expect(sanitizePaths(tree.paths)).to.deep.equal([]);
      });

      it('empties only the specified directory', () => {
        tree.writeFileSync('my-directory/foo.txt', 'foo');
        tree.emptySync('my-directory');

        expect(sanitizePaths(tree.paths)).to.deep.equal([
          'hello.txt',
          'my-directory',
        ]);
      });

      it('deletes directory symlinks', () => {
        tree2.symlinkToFacadeSync(tree, 'my-directory', 'foo');
        tree2.emptySync('');

        expect(sanitizePaths(tree2.paths)).to.deep.equal([]);
      });

      it('deletes file symlinks', () => {
        tree2.symlinkToFacadeSync(tree, 'hello.txt', 'foo.txt');
        tree2.emptySync('');

        expect(sanitizePaths(tree2.paths)).to.deep.equal([]);
      });

      it('deletes external symlinks', () => {
        tree2.symlinkSync(path.join(ROOT, 'hello.txt'), 'foo.txt');
        tree2.emptySync('');

        expect(sanitizePaths(tree2.paths)).to.deep.equal([]);
      });

      it('tracks changes', () => {
        tree.emptySync('');

        expect(sanitizeChanges(tree.changes())).to.deep.equal(sanitizeChanges([
          ['rmdir', 'my-directory'],
          ['unlink', 'hello.txt'],
        ]));
      });

      it('throws for files', () => {
        expect(() => tree.emptySync('hello.txt')).to.throw('ENOTDIR: not a directory, empty \'hello.txt\'');
      });

      it('throws when stopped', () => {
        tree.stop();

        expect(() => tree.emptySync('')).to.throw('Cannot \'empty\' on a stopped tree.');
      });

      it('throws across symlinks', () => {
        tree2.symlinkToFacadeSync(tree, '', 'foo');

        expect(() => tree2.emptySync('foo/my-directory')).to.throw(/symlink/i);
      });

      it('throws when emptying a non-existent directory', () => {
        expect(() => tree.emptySync('foo')).to.throw(/ENOENT/);
      });
    });

    describe('.mkdirSync', () => {
      it('creates a directory', () => {
        expect(sanitizePaths(tree.paths)).to.deep.equal([
          'hello.txt',
          'my-directory',
        ]);

        tree.mkdirSync('new-directory');

        expect(sanitizePaths(tree.paths)).to.deep.equal([
          'hello.txt',
          'my-directory',
          'new-directory',
        ]);
      });

      it('tracks a change', () => {
        expect(tree.changes()).to.deep.equal([]);

        tree.mkdirSync('new-directory');

        expect(sanitizeChanges(tree.changes())).to.deep.equal(sanitizeChanges([
          ['mkdir', 'new-directory'],
        ]));
      });

      it('throws when a file exists in the target location', () => {
        expect(() => {
          tree.mkdirSync('hello.txt');
        }).to.throw(/EEXIST/);
      });

      it('throws when a file exists in the target location', () => {
        expect(() => {
          tree.mkdirSync('my-directory');
        }).to.throw(/EEXIST/);
      });

      it('does error when stopped', () => {
        tree.stop();

        expect(() => {
          tree.mkdirSync('hello.txt');
        }).to.throw(/stopped/);

        expect(() => {
          tree.mkdirSync('hello.txt');
        }).to.throw(/mkdir/);
      });

      it('throws across symlinks', () => {
        tree.symlinkToFacadeSync(tree, 'my-directory', 'other-directory');

        expect(() => {
          tree.mkdirSync('other-directory/foo');
        }).to.throw(/symlink/i);
      });

      it('throws when creating the tree\'s root', () => {
        expect(() => tree.mkdirSync('')).to.throw(/root/);
      });

      it('throws when creating in a non-existent directory', () => {
        expect(() => tree.mkdirSync('foo/bar')).to.throw(/ENOENT/);
      });
    });

    describe('.mkdirpSync', () => {
      it('creates directories', () => {
        expect(sanitizePaths(tree.paths)).to.deep.equal([
          'hello.txt',
          'my-directory',
        ]);

        tree.mkdirpSync('new-directory/a/b/c/');

        expect(sanitizePaths(tree.paths)).to.deep.equal([
          'hello.txt',
          'my-directory',
          'new-directory',
          'new-directory/a',
          'new-directory/a/b',
          'new-directory/a/b/c',
         ]);
      });

      it('tracks changes', () => {
        expect(tree.changes()).to.deep.equal([]);

        tree.mkdirpSync('new-directory/a/b/c/');

        expect(sanitizeChanges(tree.changes())).to.deep.equal(sanitizeChanges([
          ['mkdir', 'new-directory'],
          ['mkdir', 'new-directory/a'],
          ['mkdir', 'new-directory/a/b'],
          ['mkdir', 'new-directory/a/b/c'],
        ]));
      });

      it('is idempotent (exact match)', function testDir2Dir() {
        const old = fs.statSync(`${tree.root}/my-directory`);

        tree.mkdirpSync('my-directory/');

        const current = fs.statSync(`${tree.root}/my-directory`);

        expect(old.mtime.getTime()).to.equal(current.mtime.getTime());
        expect(old).to.have.property('mode', current.mode);
        expect(old).to.have.property('size', current.size);

        expect(sanitizePaths(tree.paths)).to.deep.equal([
          'hello.txt',
          'my-directory',
        ]);
      });

      it('is idempotent (path normalization)', () => {
        let old = fs.statSync(`${tree.root}/my-directory`);

        tree.mkdirpSync('my-directory/foo/..');

        let current = fs.statSync(`${tree.root}/my-directory`);

        expect(old.mtime.getTime()).to.equal(current.mtime.getTime());
        expect(old).to.have.property('mode', current.mode);
        expect(old).to.have.property('size', current.size);

        expect(sanitizePaths(tree.paths)).to.deep.equal([
          'hello.txt',
          'my-directory',
        ]);
      });

      it('throws if a file with the same name exists', () => {
        expect(() => tree.mkdirpSync('hello.txt')).to.throw(/EEXIST/);
      });

      it('throws when stopped', () => {
        tree.stop();

        expect(() => {
          tree.mkdirpSync('hello.txt');
        }).to.throw(/stopped/);

        expect(() => {
          tree.mkdirpSync('hello.txt');
        }).to.throw(/mkdirp/);
      });
    });

    describe('._resolvePath', () => {
      it('resolves the empty string', () => {
        expect(tree._resolvePath('')).to.equal(ROOT);
      });

      it('resolves .', () => {
        expect(tree._resolvePath('.')).to.equal(ROOT);
      });

      it('resolves paths that exist', () => {
        expect(tree._resolvePath('my-directory')).to.equal(`${ROOT}/my-directory`);
      });

      it('resolves paths that do not exist', () => {
        expect(tree._resolvePath('narnia')).to.equal(`${ROOT}/narnia`);
      });

      it('resolves paths with ..', () => {
        expect(tree._resolvePath('my-directory/uwot/../..')).to.equal(ROOT);
      });

      it('throws for paths that escape root', () => {
        expect(() => {
          tree._resolvePath('..');
        }).to.throw('Invalid path: \'..\' not within root.');
      });

      it('throws for paths within a chdir that escape root', () => {
        const projection = tree.chdir('my-directory');

        expect(() => {
          projection._resolvePath('..');
        }).to.throw('Invalid path: \'..\' not within root.');
      });
    });

    describe('.statSync', () => {
      it('returns a stat object for normalized paths that exists', () => {
        let result = tree.statSync('my-directory/../hello.txt');

        expect(result).to.have.property('mode');
        expect(result).to.have.property('mtime');
        expect(result).to.have.property('size');
      });

      it('returns a correct stat object for tree roots', () => {
        const expected = fs.statSync(ROOT);
        const actual = tree.statSync('');

        expect(actual.mode).to.equal(expected.mode);
        expect(actual.mtime.getTime()).to.equal(expected.mtime.getTime());
        expect(actual.size).to.equal(expected.size);
      });

      it('returns the target\'s stats for linked directories', () => {
        tree2.symlinkToFacadeSync(tree, 'my-directory', 'linked-directory');

        const expected = fs.statSync(path.join(ROOT, 'my-directory'));
        const actual = tree2.statSync('linked-directory');

        expect(actual.mode).to.equal(expected.mode);
        expect(actual.mtime.getTime()).to.equal(expected.mtime.getTime());
        expect(actual.size).to.equal(expected.size);
      });

      it('returnsthe target\'s stats for linked files', () => {
        tree2.symlinkToFacadeSync(tree, 'hello.txt', 'linked.txt');

        const expected = fs.statSync(path.join(ROOT, 'hello.txt'));
        const actual = tree2.statSync('linked.txt');

        expect(actual.mode).to.equal(expected.mode);
        expect(actual.mtime.getTime()).to.equal(expected.mtime.getTime());
        expect(actual.size).to.equal(expected.size);
      });

      it('throws for nonexistent paths', () => {
        expect(() => {
          tree.statSync('foo.js');
        }).to.throw('ENOENT: no such file or directory, stat \'foo.js\'');
      });
    });

    describe('.existsSync', () => {
      it('returns true for paths that resolve to the root dir', () => {
        expect(tree.existsSync('')).to.be.true;
        expect(tree.existsSync('.')).to.be.true;
        expect(tree.existsSync('my-directory/..')).to.be.true;
      });

      it('returns true if the normalized path exists', () => {
        expect(tree.existsSync('hello.txt')).to.be.true;
        expect(tree.existsSync('my-directory')).to.be.true;
        expect(tree.existsSync('./my-directory/foo/..////')).to.be.true;
      });

      it('returns false if the path does not exist', () => {
        expect(tree.existsSync('pretty-sure-this-isnt-real')).to.be.false;
        expect(tree.existsSync('my-directory/still-not-real')).to.be.false;
      });

      // We care about this for now while we're still writing symlinks.  When we
      // actually take advantage of our change tracking, we may not need this,
      // except possibly for the initial state (eg where app is a symlink or
      // perhaps more realistically something within node_modules)
      it('follows scanned symlinks', () => {
        fs.symlinkSync(`${ROOT}/this-dir-isnt-real`, `${ROOT}/broken-symlink`);
        fs.symlinkSync(`${ROOT}/hello.txt`, `${ROOT}/pretty-legit-symlink`);

        const treeWithLinks = treeFromDisk(ROOT, fstree.SourceTree);

        expect(treeWithLinks.existsSync('broken-symlink')).to.be.false;
        expect(treeWithLinks.existsSync('pretty-legit-symlink')).to.be.true;
      });
    });

    describe('readdirSync', () => {
      beforeEach(() => {
        tree.mkdirSync('my-directory/subdir');
        tree.writeFileSync('my-directory/ohai.txt', 'hi');
        tree.writeFileSync('my-directory/again.txt', 'hello');
        tree.writeFileSync('my-directory/subdir/sup.txt', 'guten tag');
        tree.writeFileSync('my-directory.annoying-file', 'better test this');
        tree.stop();
        tree.start();
      });

      it('throws if path is a file', () => {
        expect(() => {
          tree.readdirSync('hello.txt');
        }).to.throw('ENOTDIR: not a directory, scandir \'hello.txt\'');
      });

      it('throws if path does not exist', () => {
        expect(() => {
          tree.readdirSync('not-a-real-path');
        }).to.throw('ENOENT: no such file or directory, scandir \'not-a-real-path\'');
      });

      it('returns the contents of a dir', () => {
        expect(tree.readdirSync('my-directory')).to.deep.equal([
          'again.txt',
          'ohai.txt',
          'subdir',
        ]);
      });

      it('returns the contents of a symlinked directory', () => {
        // lazy tree
        tree = new fstree.SourceTree({ root: ROOT });
        tree2.symlinkToFacadeSync(tree, 'my-directory', 'linked-directory');

        expect(tree2.readdirSync('linked-directory')).to.deep.equal([
          'again.txt',
          'ohai.txt',
          'subdir',
        ]);
      });

      it('returns the contents of root', () => {
        expect(tree.readdirSync('./')).to.deep.equal([
          'hello.txt',
          'my-directory',
          'my-directory.annoying-file',
        ]);
      });

      it('chomps trailing / in returned dirs', () => {
        // reset entries via walksync so that subdir has a trailing slash
        const newTree = treeFromDisk(ROOT);

        expect(newTree.readdirSync('my-directory')).to.deep.equal([
          'again.txt',
          'ohai.txt',
          'subdir',
        ]);
      });

      describe('from symlinks', () => {
        it('should return the correct entries', () => {
          tree.mkdirSync('foo');
          tree.writeFileSync('foo/baz.txt', 'baz');
          tree2.symlinkToFacadeSync(tree, 'foo', 'c');

          expect(tree2.readdirSync('c')).to.deep.equal([
            'baz.txt',
          ]);
        });
      });

      describe('from symlinks with srcRelativePath as \'\'', () => {
        it('should return the correct entries', () => {
          tree2.symlinkToFacadeSync(tree, '', 'c');

          expect(tree2.readdirSync('c')).to.deep.equal([
            'hello.txt',
            'my-directory',
            'my-directory.annoying-file',
          ]);
        });
      });

      // FIXME: Directory handling in projections needs a rethink.
      describe.skip('on projections', () => {
        it('honors the files filter', () => {
          tree2 = tree.filtered({ files: [
            'hello.txt',
            'my-directory/ohai.txt',
            'my-directory/subdir/sup.txt',
          ] });

          expect(tree2.readdirSync('my-directory')).to.deep.equal([
            'ohai.txt',
            'subdir',  // Automatically created by the 'my-directory/subdir/sup.txt' entry above.
          ]);
        });

        it('honors the include filter', () => {
          tree2 = tree.filtered({ include: [ '**/ohai.*' ] });

          expect(tree2.readdirSync('my-directory')).to.deep.equal([
            'ohai.txt',
          ]);
        });
      });
    });

    describe('.paths', () => {
      it('returns the paths for all entries', () => {
        expect(sanitizePaths(tree.paths)).to.deep.equal([
          'hello.txt',
          'my-directory',
        ]);
      });

      it('respects cwd', () => {
        expect(tree.chdir('my-directory').paths).to.deep.equal([]);
      });

      it('respects filters', () => {
        expect(sanitizePaths(tree.filtered({
          include: ['*.txt'],
        }).paths)).to.deep.equal([
          'hello.txt',
        ]);
      });
    });

    describe('.entries', () => {
      it('returns all entries', () => {
        expect(sanitizeEntries(tree.entries)).to.deep.equal(sanitizeEntries([
          file('hello.txt'),
          directory('my-directory'),
        ]));
      });

      it('respects cwd', () => {
        expect(tree.chdir('my-directory').entries).to.deep.equal([]);
      });

      it('respects filters', () => {
        expect(sanitizeEntries(tree.filtered({
          include: ['*.txt'],
        }).entries)).to.deep.equal(sanitizeEntries([
          file('hello.txt'),
        ]));
      });

      it('expands symlinks', () => {
        tree.writeFileSync('my-directory/foo.txt', 'foo');
        tree2.symlinkToFacadeSync(tree, 'my-directory', 'bar');

        expect(sanitizeEntries(tree2.entries)).to.deep.equal(sanitizeEntries([
          directory('bar'),
          file('bar/foo.txt'),
        ]));
      });

      // This one is a bit complex because it replicates a scenario discovered in `ember new`.
      it('applies filters to expanded symlinks', () => {
        fixturify.writeSync(ROOT3, {
          bar: {
            'foo.js': 'let foo;',
          },
        });

        tree3 = treeFromDisk(ROOT3, fstree.SourceTree);
        tree2.symlinkToFacadeSync(tree3, '', '');
        tree.symlinkToFacadeSync(tree2, '', 'my-directory/baz');

        const projection = tree.chdir('my-directory');

        expect(sanitizeEntries(projection.entries)).to.deep.equal(sanitizeEntries([
          directory('baz'),
          directory('baz/bar'),
          file('baz/bar/foo.js'),
        ]));
      });
    });

    describe('.chdir', () => {
      it('throws if the path is to a file', () => {
        expect(() => {
          tree.chdir('hello.txt');
        }).to.throw('ENOTDIR: not a directory, hello.txt');
      });

      it('returns a new tree', () => {
        const result = tree.chdir('my-directory');

        expect(result).to.not.equal(tree);
        expect(result._parent).to.equal(tree);
        expect(result.cwd).to.equal('my-directory');
      });

      it('cannot escape a cwd', () => {
        tree.mkdirSync('my-directory/a');

        const projection = tree.chdir('my-directory/a');

        expect(() => {
          projection.chdir('my-directory');
        }).to.throw(/ENOENT/);
      });

      it('can chdir into symlinks', () => {
        tree.mkdirSync('my-directory/foo');
        tree.writeFileSync('my-directory/foo/bar.js', 'let bar;');
        tree2.mkdirSync('abc');
        tree2.symlinkToFacadeSync(tree, 'my-directory', 'abc/def');
        tree3.symlinkToFacadeSync(tree2, 'abc', 'xyz');

        const projection = tree3.chdir('xyz/def/foo');

        expect(projection.cwd).to.equal('xyz/def/foo');
        expect(sanitizePaths(projection.paths)).to.deep.equal([
          'bar.js',
        ]);
      });

      // It cannot elide the current tree, or filters will be lost.
      it('always projects the current tree', () => {
        tree2.symlinkToFacadeSync(tree, '', 'foo');

        const projection = tree2.chdir('foo');

        expect(projection._parent).to.equal(tree2);
      });

      it('throws when path does not exist', () => {
        expect(() => {
          tree.chdir('pretty-sure-this-dir-doesnt-exist');
        }).to.throw('ENOENT: no such file or directory, pretty-sure-this-dir-doesnt-exist');
      });

      describe('other operations', () => {
        beforeEach(() => {
          tree.writeFileSync('my-directory/ohai.txt', 'yes hello');
          tree.stop();
          tree.start();
        });

        it('is respected by statSync', () => {
          expect(tree._findByRelativePath('ohai.txt').entry).to.be.null;

          let newTree = tree.chdir('my-directory');

          let stat = newTree.statSync('ohai.txt');
          expect(stat).to.have.property('mode', Entry.FILE_MODE);
        });

        it('is respected by existsSync', () => {
          expect(tree.existsSync('ohai.txt')).to.be.false;

          let newTree = tree.chdir('my-directory');

          expect(newTree.existsSync('ohai.txt')).to.be.true;
        });

        it('is respected by readFileSync', () => {
          let newTree = tree.chdir('my-directory');

          expect(newTree.readFileSync('ohai.txt', 'UTF8')).to.equal('yes hello');
        });

        it('is respected by readdirSync', () => {
          tree.mkdirSync('my-directory/subdir');
          tree.writeFileSync('my-directory/ohai.txt', 'hi');
          tree.writeFileSync('my-directory/again.txt', 'hello');
          tree.writeFileSync('my-directory/subdir/sup.txt', 'guten tag');

          tree.stop();
          tree.start();

          expect(() => {
            tree.readdirSync('subdir');
          }).to.throw();

          let newTree = tree.chdir('my-directory');

          expect(newTree.readdirSync('subdir')).to.deep.equal([
            'sup.txt',
          ]);
        });

        it('is respected by changes', () => {
          tree.mkdirSync('my-directory/subdir');
          tree.writeFileSync('my-directory/subdir/ohai.txt', 'yes hello again');

          let newTree = tree.chdir('my-directory/subdir');

          expect(sanitizeChanges(newTree.changes())).to.deep.equal(sanitizeChanges([
            ['create', 'ohai.txt'],
          ]));

          expect(sanitizeChanges(tree.changes())).to.deep.equal(sanitizeChanges([
            ['mkdir', 'my-directory/subdir'],
            ['create', 'my-directory/subdir/ohai.txt'],
          ]));
        });
      });
    });

    describe('.filtered', () => {
      it('returns a new tree with filters set', () => {
        expect(tree.filtered({ include: ['*.js'] }).include).to.deep.equal(['*.js']);
        expect(tree.filtered({ exclude: ['*.js'] }).exclude).to.deep.equal(['*.js']);
        expect(tree.filtered({ files: ['foo.js'] }).files).to.deep.equal(['foo.js']);
        expect(tree.filtered({ cwd: 'my-directory' }).cwd).to.equal('my-directory');

        let projection = tree.filtered({
          include: ['*.js'],
          exclude: ['*.css'],
          cwd: 'my-directory',
        });

        expect(projection._parent).to.equal(tree);
        expect(projection.include).to.deep.equal(['*.js']);
        expect(projection.exclude).to.deep.equal(['*.css']);
        expect(projection.cwd).to.equal('my-directory');
      });
    });
  });

  describe('SourceTree', () => {
    describe('scanning', () => {
      beforeEach(() => {
        fixturify.writeSync(path.join(ROOT, 'my-directory'), {
          'goodbye.txt': '',
        });

        tree = new fstree.SourceTree({ root: ROOT });
      });

      describe('._ensureDirectoryScanned', () => {
        it('scans only the requested directory when scanning root', () => {
          tree._ensureDirectoryScanned('');

          expect(tree._scannedDirectories).to.have.all.keys('');
          expect(sanitizeEntries(tree._entries)).to.deep.equal(sanitizeEntries([
            file('hello.txt'),
            directory('my-directory'),
          ]));
        });

        it('scans only the requested directory when scanning a directory', () => {
          tree._ensureDirectoryScanned('my-directory');

          expect(tree._scannedDirectories).to.have.all.keys('my-directory');

          expect(sanitizeEntries(tree._entries)).to.deep.equal(sanitizeEntries([
            // hello.txt is not present
            // my-directory is not present
            file('my-directory/goodbye.txt'),
          ]));
        });

        it('silently fails when requesting a directory which doesn\'t exist', () => {
          tree._ensureDirectoryScanned('missing-dir');

          expect(tree._scannedDirectories).to.have.all.keys('missing-dir');
          expect(tree._entries).to.have.lengthOf(0);
        });

        it('won\'t scan the same directory twice', () => {
          tree._ensureDirectoryScanned('');

          fixturify.writeSync(ROOT, {
            'new-file.txt': 'You weren\' expecting me!',
          });

          tree._ensureDirectoryScanned('');

          expect(sanitizeEntries(tree._entries)).to.deep.equal(sanitizeEntries([
            file('hello.txt'),
            directory('my-directory'),
            // new-file.txt is not present
          ]));
        });
      });

      describe('._ensureSubtreeScanned', () => {
        it('scans nested directories', () => {
          tree._ensureSubtreeScanned('');

          expect(tree._scannedDirectories).to.have.all.keys('', 'my-directory');
          expect(sanitizeEntries(tree._entries)).to.deep.equal(sanitizeEntries([
            file('hello.txt'),
            directory('my-directory'),
            file('my-directory/goodbye.txt'),
          ]));
        });

        it('doesn\'t re-scan nested directories which have already been scanned', () => {
          tree._ensureDirectoryScanned('my-directory');

          fixturify.writeSync(path.join(ROOT, 'my-directory'), {
            'new-file.txt': 'You weren\' expecting me!',
          });

          tree._ensureSubtreeScanned('');

          expect(sanitizeEntries(tree._entries)).to.deep.equal(sanitizeEntries([
            file('hello.txt'),
            directory('my-directory'),
            file('my-directory/goodbye.txt'),
            // my-directory/new-file.txt is not present
          ]));
        });

        it('scans unscanned directories inside scanned nested directories', () => {
          fixturify.writeSync(path.join(ROOT, 'my-directory'), {
            subdirectory: {
              'deep-file.txt': '',
            },
          });

          tree._ensureDirectoryScanned('my-directory');
          tree._ensureSubtreeScanned('');

          expect(tree._scannedDirectories).to.have.all.keys('', 'my-directory', 'my-directory/subdirectory');
          expect(sanitizeEntries(tree._entries)).to.deep.equal(sanitizeEntries([
            file('hello.txt'),
            directory('my-directory'),
            file('my-directory/goodbye.txt'),
            directory('my-directory/subdirectory'),
            file('my-directory/subdirectory/deep-file.txt'),
          ]));
        });
      });

      describe('.existsSync', () => {
        it('DOES NOT scan the directory containing the target', () => {
          tree.existsSync('my-directory/goodbye.txt');

          expect(tree._scannedDirectories).to.not.have.any.keys('my-directory');
        });
      });

      describe('.reread', () => {
        it('resets scanning', () => {
          tree._ensureDirectoryScanned('');
          tree.reread();

          expect(tree._scannedDirectories).to.have.property('size', 0);  // no dedicated verb for set size
          expect(tree._entries).to.have.lengthOf(0);
        });
      });

      describe('.readFileSync', () => {
        it('scans the directory containing the target', () => {
          tree.readFileSync('my-directory/goodbye.txt');

          expect(tree._scannedDirectories).to.have.all.keys('my-directory');
        });
      });

      describe('.readdirSync', () => {
        it('scans the directory containing the target', () => {
          tree.readdirSync('my-directory');

          expect(tree._scannedDirectories).to.have.any.keys('');
        });

        it('scans the target', () => {
          tree.readdirSync('my-directory');

          expect(tree._scannedDirectories).to.have.any.keys('my-directory');
        });
      });

      describe('.statSync', () => {
        it('scans the directory containing the target', () => {
          tree.statSync('my-directory/goodbye.txt');

          expect(tree._scannedDirectories).to.have.all.keys('my-directory');
        });
      });

      it('scans the directory containing the target of a .symlinkToFacadeSync', () => {
        tree2.symlinkToFacadeSync(tree, 'my-directory', 'foo');

        expect(tree._scannedDirectories).to.have.all.keys('');
      });
    });
  });

  describe('WritableTree', () => {
    describe('._track', () => {
      // Note that sanitizeEntry, sanitizeChanges, etc. MUST NOT be used here;
      // they will strip out the meta property used to distinguish entries.

      let directoryEntry1;
      let directoryEntry2;
      let fileEntry1;
      let fileEntry2;

      beforeEach(() => {
        directoryEntry1 = directory('foo', { meta: 1 });
        directoryEntry2 = directory('foo', { meta: 2 });
        fileEntry1 = file('foo', { meta: 1 });
        fileEntry2 = file('foo', { meta: 2 });
      });

      it('tracks a change', () => {
        tree._track('create', fileEntry1);

        expect(tree.changes()).to.deep.equal([
          [ 'create', 'foo', fileEntry1 ],
        ]);
      });

      it('removes a previous unlink when tracking a create', () => {
        tree._track('unlink', fileEntry1);
        tree._track('create', fileEntry2);

        expect(tree.changes()).to.deep.not.include([ 'unlink', 'foo', fileEntry1]);
      });

      it('tracks a change instead of a create when a previous unlink exists', () => {
        tree._track('unlink', fileEntry1);
        tree._track('create', fileEntry2);

        expect(tree.changes()).to.deep.include([ 'change', 'foo', fileEntry2]);
      });

      it('removes a previous change when tracking a change', () => {
        tree._track('change', fileEntry1);
        tree._track('change', fileEntry2);

        expect(tree.changes()).to.deep.not.include([ 'change', 'foo', fileEntry1]);
      });

      it('removes a previous create when tracking a change', () => {
        // Uses IDs to differentiate because the change should also become a
        // create.  (See next test.)
        tree._track('create', fileEntry1);
        tree._track('change', fileEntry2);

        expect(tree.changes()).to.deep.not.include([ 'create', 'foo', fileEntry1]);
      });

      it('tracks a create instead of a change when a previous create exists', () => {
        tree._track('create', fileEntry1);
        tree._track('change', fileEntry2);

        expect(tree.changes()).to.deep.include([ 'create', 'foo', fileEntry2]);
      });

      it('removes a previous rmdir when tracking a mkdir', () => {
        tree._track('rmdir', directoryEntry1);
        tree._track('mkdir', directoryEntry2);

        expect(tree.changes()).to.deep.not.include([ 'rmdir', 'foo', directoryEntry1]);
      });

      it('does not track a mkdir when a previous rmdir exists', () => {
        tree._track('rmdir', directoryEntry1);
        tree._track('mkdir', directoryEntry2);

        expect(tree.changes()).to.deep.not.include([ 'mkdir', 'foo', directoryEntry2]);
      });

      it('removes a previous mkdir when tracking a rmdir', () => {
        tree._track('mkdir', directoryEntry1);
        tree._track('rmdir', directoryEntry2);

        expect(tree.changes()).to.deep.not.include([ 'mkdir', 'foo', directoryEntry1]);
      });

      it('does not track a rmdir when a previous mkdir exists', () => {
        tree._track('mkdir', directoryEntry1);
        tree._track('rmdir', directoryEntry2);

        expect(tree.changes()).to.deep.not.include([ 'rmdir', 'foo', directoryEntry2]);
      });

      it('removes a previous change when tracking an unlink', () => {
        tree._track('change', directoryEntry1);
        tree._track('unlink', directoryEntry2);

        expect(tree.changes()).to.deep.not.include([ 'change', 'foo', directoryEntry1]);
      });

      it('removes a previous create when tracking an unlink', () => {
        tree._track('create', directoryEntry1);
        tree._track('unlink', directoryEntry2);

        expect(tree.changes()).to.deep.not.include([ 'create', 'foo', directoryEntry1]);
      });

      it('does not track an unlink when a previous create exists', () => {
        tree._track('create', directoryEntry1);
        tree._track('unlink', directoryEntry2);

        expect(tree.changes()).to.deep.not.include([ 'unlink', 'foo', directoryEntry2]);
      });
    });

    describe('._untrack', () => {
      it('removes one matching changes', () => {
        compileChanges(tree, [
          [ 'create', 'foo' ],
          [ 'create', 'bar' ],
        ]);

        tree._untrack('create', 'foo');

        expect(sanitizeChanges(tree.changes())).to.deep.equal(sanitizeChanges([
          [ 'create', 'bar' ],
        ]));
      });

      it('removes the tracked change from the hash', () => {
        compileChanges(tree, [
          [ 'create', 'foo' ],
          [ 'create', 'bar' ],
        ]);

        tree._untrack('create', 'foo');

        expect(tree._changeHash.create.foo).to.be.undefined;
      });

      it('does not remove changes for which the operation does not match', () => {
        compileChanges(tree, [
          [ 'create', 'foo' ],
          [ 'create', 'bar' ],
        ]);

        tree._untrack('unlink', 'foo');

        expect(sanitizeChanges(tree.changes())).to.deep.equal(sanitizeChanges([
          // WritableTree#changes() sorts its ouput.
          [ 'create', 'bar' ],
          [ 'create', 'foo' ],
        ]));
      });

      it('does not remove changes for which the path does not match', () => {
        compileChanges(tree, [
          [ 'create', 'foo' ],
          [ 'create', 'bar' ],
        ]);

        tree._untrack('create', 'baz');

        expect(sanitizeChanges(tree.changes())).to.deep.equal(sanitizeChanges([
          // WritableTree#changes() sorts its ouput.
          [ 'create', 'bar' ],
          [ 'create', 'foo' ],
        ]));
      });

      it('returns true if matches were found and removed', () => {
        compileChanges(tree, [
          [ 'create', 'foo' ],
        ]);

        expect(tree._untrack('create', 'foo')).to.be.true;
      });

      it('returns false if no matches were found or removed', () => {
        compileChanges(tree, [
          [ 'create', 'foo' ],
        ]);

        expect(tree._untrack('unlink', 'bar')).to.be.false;
      });
    });
  });

  describe('projections', () => {
    beforeEach(() => {
      rimraf.sync(ROOT);
      fs.mkdirpSync(ROOT);

      fixturify.writeSync(ROOT, {
        'hello.txt': 'Hello, World!\n',
        'goodbye.txt': 'Goodbye, World\n',
        'a': {
          'foo': {
            'one.js': '',
            'one.css': '',
            'two.js': '',
            'two.css': '',
          },
          'bar': {
            'two.js': '',
            'two.css': '',
            'three.js': '',
            'three.css': '',
          }
        },
        'b': {
          'dotfiles': {
            '.file': 'dotfile',
          },
        },
      });

      tree = treeFromDisk(ROOT);
    });

    describe('files', () => {
      it('returns only matching files', () => {
        expect(sanitizePaths(tree.filtered({ files: ['hello.txt', 'a/foo/two.js', 'a/bar'] }).paths)).to.deep.equal([
          'a',
          'a/bar',
          'a/foo',
          'a/foo/two.js',
          'hello.txt',
        ]);
      });

      it('returns no files when set to an empty array', () => {
        expect(sanitizePaths(tree.filtered({ files: [] }).paths)).to.deep.equal([]);
      });

      it('returns all files when set to null', () => {
        expect(sanitizePaths(tree.filtered({ files: null }).paths)).to.deep.equal([
          'a',
          'a/bar',
          'a/bar/three.css',
          'a/bar/three.js',
          'a/bar/two.css',
          'a/bar/two.js',
          'a/foo',
          'a/foo/one.css',
          'a/foo/one.js',
          'a/foo/two.css',
          'a/foo/two.js',
          'b',
          'b/dotfiles',
          'b/dotfiles/.file',
          'goodbye.txt',
          'hello.txt',
        ]);
      });

      it('returns all files when set to undefined', () => {
        expect(sanitizePaths(tree.filtered({ files: undefined }).paths)).to.deep.equal([
          'a',
          'a/bar',
          'a/bar/three.css',
          'a/bar/three.js',
          'a/bar/two.css',
          'a/bar/two.js',
          'a/foo',
          'a/foo/one.css',
          'a/foo/one.js',
          'a/foo/two.css',
          'a/foo/two.js',
          'b',
          'b/dotfiles',
          'b/dotfiles/.file',
          'goodbye.txt',
          'hello.txt',
        ]);
      });

      it('respects cwd', () => {
        expect(sanitizePaths(tree.filtered({ cwd: 'a/foo', files: ['one.js', 'two.css'] }).paths)).to.deep.equal([
          'one.js',
          'two.css',
        ]);
      });

      it('normalizes paths before comparison', () => {
        expect(sanitizePaths(tree.filtered({ files: [ './c/../hello.txt' ]}).paths)).to.deep.equal([
          'hello.txt',
        ]);
      });

      it('is incompatible with include', () => {
        expect(() => {
          tree.filtered({ files: ['a/foo/one.js'], include: ['a/foo/one.css'] });
        }).to.throw('The "include" filter is incompatible with the "files" filter.');
      });

      it('is incompatible with exclude', () => {
        expect(() => {
          tree.filtered({ files: ['a/foo/one.js'], exclude: ['a/foo/one.css'] });
        }).to.throw('The "exclude" filter is incompatible with the "files" filter.');
      });

      it('must be null, undefined, or an array', () => {
        expect(() => tree.filtered({ files: 4 })).to.throw(/null or an array/);
        expect(() => tree.filtered({ files: true })).to.throw(/null or an array/);
        expect(() => tree.filtered({ files: 'foo.js' })).to.throw(/null or an array/);
        expect(() => tree.filtered({ files: new Date() })).to.throw(/null or an array/);
      });
    });

    describe('include', () => {
      it('matches by regexp', () => {
        expect(sanitizePaths(tree.filtered({ include: [new RegExp(/(hello|one)\.(txt|js)/)] }).paths)).to.deep.equal([
          'a',
          'a/foo',
          'a/foo/one.js',
          'hello.txt',
        ]);
      });

      it('matches by function', () => {
        expect(sanitizePaths(tree.filtered({ include: [p => p === 'a/bar/three.css'] }).paths)).to.deep.equal([
          'a',
          'a/bar',
          'a/bar/three.css',
        ]);
      });

      it('matches by string globs', () => {
        expect(sanitizePaths(tree.filtered({ include: ['**/*.{txt,js}'] } ).paths)).to.deep.equal([
          'a',
          'a/bar',
          'a/bar/three.js',
          'a/bar/two.js',
          'a/foo',
          'a/foo/one.js',
          'a/foo/two.js',
          'goodbye.txt',
          'hello.txt',
        ]);
      });

      it('matches by a mix of matchers', () => {
        expect(sanitizePaths(tree.filtered({ include: ['**/*.txt', new RegExp(/(hello|one)\.(txt|js)/), p => p === 'a/bar/three.js'] }).paths)).to.deep.equal([
          'a',
          'a/bar',
          'a/bar/three.js',
          'a/foo',
          'a/foo/one.js',
          'goodbye.txt',
          'hello.txt',
        ]);
      });

      it('respects cwd', () => {
        expect(sanitizePaths(tree.filtered({ cwd: 'a/foo', include: ['*.css'] }).paths)).to.deep.equal([
          'one.css',
          'two.css',
        ]);
      });

      it('must be an array', () => {
        expect(() => tree.filtered({ include: 4 })).to.throw(/an array/);
        expect(() => tree.filtered({ include: true })).to.throw(/an array/);
        expect(() => tree.filtered({ include: 'foo.js' })).to.throw(/an array/);
        expect(() => tree.filtered({ include: new Date() })).to.throw(/an array/);
      });
    });

    describe('exclude', () => {
      it('matches by regexp', () => {
        expect(sanitizePaths(tree.filtered({ exclude: [new RegExp(/(hello|one|two)\.(txt|js)/)] }).paths)).to.deep.equal([
          'a',
          'a/bar',
          'a/bar/three.css',
          'a/bar/three.js',
          'a/bar/two.css',
          'a/foo',
          'a/foo/one.css',
          'a/foo/two.css',
          'b',
          'b/dotfiles',
          'b/dotfiles/.file',
          'goodbye.txt',
        ]);
      });

      it('matches by function', () => {
        expect(sanitizePaths(tree.filtered({ cwd: 'a/bar', exclude: [p => p === 'three.css'] }).paths)).to.deep.equal([
          'three.js',
          'two.css',
          'two.js',
        ]);
      });

      it('matches by string globs', () => {
        expect(sanitizePaths(tree.filtered({ exclude: ['**/*.{txt,css}'] } ).paths)).to.deep.equal([
          'a',
          'a/bar',
          'a/bar/three.js',
          'a/bar/two.js',
          'a/foo',
          'a/foo/one.js',
          'a/foo/two.js',
          'b',
          'b/dotfiles',
          'b/dotfiles/.file',
        ]);
      });

      it('matches by a mix of matchers', () => {
        expect(sanitizePaths(tree.filtered({ exclude: ['**/*.css', /(hello|one)\.(txt|js)/, p => p === 'a/bar/three.js'] }).paths)).to.deep.equal([
          'a',
          'a/bar',
          'a/bar/two.js',
          'a/foo',
          'a/foo/two.js',
          'b',
          'b/dotfiles',
          'b/dotfiles/.file',
          'goodbye.txt',
        ]);
      });

      it('respects cwd', () => {
        expect(sanitizePaths(tree.filtered({ cwd: 'a/foo', exclude: ['*.css'] }).paths)).to.deep.equal([
          'one.js',
          'two.js',
        ]);
      });

      it('takes precedence over include', () => {
        expect(sanitizePaths(tree.filtered({ cwd: 'a/foo', include: ['one.css', 'one.js'], exclude: ['*.css'] }).paths)).to.deep.equal([
          'one.js',
        ]);
      });

      it('excludes entire trees', () => {
        expect(sanitizePaths(tree.filtered({ exclude: ['b/**/*'] }).paths)).to.deep.equal([
          'a',
          'a/bar',
          'a/bar/three.css',
          'a/bar/three.js',
          'a/bar/two.css',
          'a/bar/two.js',
          'a/foo',
          'a/foo/one.css',
          'a/foo/one.js',
          'a/foo/two.css',
          'a/foo/two.js',
          'b',
          'goodbye.txt',
          'hello.txt',
        ]);
      });

      it('must be an array', () => {
        expect(() => tree.filtered({ exclude: 4 })).to.throw(/an array/);
        expect(() => tree.filtered({ exclude: true })).to.throw(/an array/);
        expect(() => tree.filtered({ exclude: 'foo.js' })).to.throw(/an array/);
        expect(() => tree.filtered({ exclude: new Date() })).to.throw(/an array/);
      });
    });
  });

  describe('changes', () => {
    beforeEach(() => {
      tree.writeFileSync('omg.js', 'hi');
      tree.writeFileSync('hello.txt', 'Hello Again, World!\n');
      tree.writeFileSync('my-directory/goodbye.txt', 'Goodbye, World!\n');
    })

    it('hides no changes if all match', () => {
      let filter = { include: ['**/*'] };

      expect(sanitizeChanges(tree.filtered(filter).changes())).to.deep.equal(sanitizeChanges([
        // The projection is newly created, so gets changes for all entries.
        ['create', 'hello.txt'],
        ['mkdir', 'my-directory'],
        ['create', 'my-directory/goodbye.txt'],
        ['create', 'omg.js'],
      ]));
    });

    it('hides changes if none match', () => {
      expect(tree.filtered({ include: ['NO_MATCH'] }).changes()).to.have.lengthOf(0);
    });

    it('hides changes if they are outside of cwd', () => {
      expect(sanitizeChanges(tree.chdir('my-directory').changes())).to.deep.equal(sanitizeChanges([
        ['create', 'goodbye.txt'],
      ]));
    });

    it('hides changes if they do not match the include and exclude projection', () => {
      let filter = { include: ['**/include.css'], exclude: [e => e === 'excluded.js'] };
      let changes = tree.filtered(filter).changes();

      expect(changes).to.have.lengthOf(0);
    });

    it('honors chdir on the projected tree', () => {
      tree.mkdirSync('my-directory/foo');
      tree.writeFileSync('my-directory/foo/bar.txt', 'bar');

      const projection = tree.chdir('my-directory');

      tree2.symlinkToFacadeSync(projection, 'foo', 'abc');

      expect(sanitizeChanges(tree2.changes())).to.deep.equal(sanitizeChanges([
        ['mkdir', 'abc'],
        ['create', 'abc/bar.txt'],
      ]));
    });

    it('follows symlinks in its own cwd', () => {
      tree.mkdirSync('my-directory/foo');
      tree.writeFileSync('my-directory/foo/bar.txt', 'bar');
      tree2.symlinkToFacadeSync(tree, 'my-directory', 'abc');

      const projection = tree2.chdir('abc/foo');

      expect(sanitizeChanges(projection.changes())).to.deep.equal(sanitizeChanges([
        ['create', 'bar.txt'],
      ]));
    });

    // This one is a bit complex because it replicates a scenario discovered in `ember new`.
    it('reads changes from linked SourceTree', () => {
      fixturify.writeSync(ROOT3, {
        'foo.css': 'foo {}',
      });

      tree.stop();
      tree.start();

      tree3 = treeFromDisk(ROOT3, fstree.SourceTree);
      tree2.mkdirSync('baz');
      tree2.symlinkToFacadeSync(tree3, '', 'baz/bar');
      tree.symlinkToFacadeSync(tree2, 'baz', 'abc');

      const projection = tree.chdir('abc/bar');

      expect(sanitizeChanges(projection.changes())).to.deep.equal(sanitizeChanges([
        ['create', 'foo.css'],
      ]));
    });

    it('prefixes changes from existing symlinks', () => {
      tree2.symlinkToFacadeSync(tree, 'my-directory', 'foo');
      tree2.stop();
      tree2.start();

      expect(sanitizeChanges(tree2.changes())).to.deep.equal(sanitizeChanges([
        ['create', 'foo/goodbye.txt'],
      ]));
    });

    it('traverses root links', () => {
      tree.writeFileSync('foo.txt', 'foo');
      tree2.symlinkToFacadeSync(tree, '', 'abc');

      expect(sanitizeChanges(tree2.changes())).to.deep.equal(sanitizeChanges([
        ['mkdir', 'abc'],
        ['create', 'abc/foo.txt'],
        ['create', 'abc/hello.txt'],
        ['mkdir', 'abc/my-directory'],
        ['create', 'abc/my-directory/goodbye.txt'],
        ['create', 'abc/omg.js'],
      ]));
    });

    it('retains symlinked directories which contain matching files', () => {
      tree2.symlinkToFacadeSync(tree, '', 'abc');
      tree2.writeFileSync('def.js', 'let def;');
      tree3 = tree2.filtered({ include: [/.*\.js$/] });

      expect(sanitizeChanges(tree3.changes())).to.deep.equal(sanitizeChanges([
        ['mkdir', 'abc'],
        ['create', 'abc/omg.js'],
        ['create', 'def.js'],
      ]));
    });

    it('considers CWD when filtering changes created from symlinks\' entries', () => {
      tree2.mkdirSync('foo');
      tree2.symlinkToFacadeSync(tree, '', 'foo/bar');
      tree3 = tree2.filtered({ cwd: 'foo', include: ['bar/*.txt'] });

      expect(sanitizeChanges(tree3.changes())).to.deep.equal(sanitizeChanges([
        ['mkdir', 'bar'],
        ['create', 'bar/hello.txt'],
      ]));
    });

    it('includes changes caused by changing filters on a projection of a writable tree', () => {
      const projectedTree = tree.filtered({ include: [ '**/*.js' ] });

      tree.stop();
      tree.reread();
      tree.start();

      projectedTree.include = [ '**/*.txt' ];

      expect(sanitizeChanges(projectedTree.changes())).to.deep.equal(sanitizeChanges([
        ['unlink', 'omg.js'],
        ['create', 'hello.txt'],
        ['mkdir', 'my-directory'],
        ['create', 'my-directory/goodbye.txt'],
      ]));
    });

    it('includes changes caused by changing filters on a projection of a SourceTree', () => {
      tree = treeFromDisk(ROOT, fstree.SourceTree);

      const projectedTree = tree.filtered({ include: [ '**/*.js' ] });

      tree.reread();

      projectedTree.include = [ '**/*.txt' ];

      expect(sanitizeChanges(projectedTree.changes())).to.deep.equal(sanitizeChanges([
        ['unlink', 'omg.js'],
        ['create', 'hello.txt'],
        ['mkdir', 'my-directory'],
        ['create', 'my-directory/goodbye.txt'],
      ]));
    });

    describe('SourceTree', () => {
      beforeEach(() => {
        rimraf.sync(ROOT);
        fs.mkdirpSync(ROOT);

        fixturify.writeSync(ROOT, {
          'hello.txt': 'Hello, World!\n',
          'goodbye.txt': 'Goodbye, World\n',
          'a': {
            'foo': {
              'one.js': '',
              'one.css': '',
            },
            'bar': {
              'two.js': '',
              'two.css': '',
            }
          },
          'b': {
            'four.js': '',
            'four.txt': '',
          },
        });

        // Create a SourceTree.
        tree = treeFromDisk(ROOT, fstree.SourceTree);
      });

      it('include filters with multiple symlinked dir with included files', () => {
        tree2.symlinkToFacadeSync(tree, 'a', 'f')
        tree2.symlinkToFacadeSync(tree, 'b', 'd')

        tree3 = tree2.filtered({
          include: ['**/*.js'],
        });

        expect(sanitizeChanges(tree3.changes())).to.deep.equal(sanitizeChanges([
          ['mkdir', 'd'],
          ['create', 'd/four.js'],
          ['mkdir', 'f'],
          ['mkdir', 'f/bar'],
          ['create', 'f/bar/two.js'],
          ['mkdir', 'f/foo'],
          ['create', 'f/foo/one.js'],
        ]));
      });
    });

    describe('order', () => {
      beforeEach(() => {
        // Ignore previous changes.
        tree.stop();
        tree.start();

        tree.mkdirSync('a');
        tree.mkdirSync('a/b');
        tree.mkdirSync('a/b/c');
        tree.writeFileSync('a/b/c/d.txt', 'd is a great letter.');
      });

      it('additions/updates lexicographicaly', () => {
        expect(sanitizeChanges(tree.changes())).to.deep.equal(sanitizeChanges([
          ['mkdir', 'a'],
          ['mkdir', 'a/b'],
          ['mkdir', 'a/b/c'],
          ['create', 'a/b/c/d.txt'],
        ]));
      });

      it('removals reverse lexicographicaly', () => {
        tree.stop();
        tree.start();

        tree.unlinkSync('a/b/c/d.txt');
        tree.rmdirSync('a/b/c');
        tree.rmdirSync('a/b');
        tree.rmdirSync('a');

        expect(sanitizeChanges(tree.changes())).to.deep.equal(sanitizeChanges([
          ['unlink', 'a/b/c/d.txt'],
          ['rmdir', 'a/b/c'],
          ['rmdir', 'a/b'],
          ['rmdir', 'a'],
        ]));
      });

      it('sorts removals above additions/updates', () => {
        tree.writeFileSync('a/b/c/foo.txt', 'foo');

        tree.stop();
        tree.start();

        tree.writeFileSync('a/b/c/foo.txt', 'foo again');
        tree.writeFileSync('a/b/c/bar.txt', 'bar');
        tree.unlinkSync('a/b/c/d.txt');

        expect(sanitizeChanges(tree.changes())).to.deep.equal(sanitizeChanges([
          ['unlink', 'a/b/c/d.txt'],
          ['create', 'a/b/c/bar.txt'],
          ['change', 'a/b/c/foo.txt'],
        ]));
      });
    });
  });
});
