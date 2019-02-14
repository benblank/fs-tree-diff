'use strict';

const fs = require('fs-extra');
const path = require('path');
const expect = require('chai').expect;
const walkSync = require('walk-sync');
const fstree = require('../lib/index');
const context = describe;
const defaultIsEqual = fstree.ManualTree.defaultIsEqual;

const helpers = require('./helpers');
const entry = helpers.entry;
const file = helpers.file;
const directory = helpers.directory;

require('chai').config.truncateThreshold = 0;

let fsTree;

describe('ManualTree patch', function() {
  const originalNow = Date.now;

  beforeEach(function() {
    Date.now = (() => 0);
  });

  afterEach(function() {
    Date.now = originalNow;
  });

  describe('#calculatePatch', function() {
    it('input validation', function() {
      expect(function() {
        fstree.ManualTree.fromPaths([]).calculatePatch(fstree.ManualTree.fromPaths([]), '');
      }).to.throw(TypeError, 'calculatePatch\'s second argument must be a function');
    });

    context('from an empty tree', function() {
      beforeEach(function() {
        fsTree = fstree.ManualTree.fromPaths([]);
      });

      context('to an empty tree', function() {
        it('returns 0 operations', function() {
          expect(fsTree.calculatePatch(fstree.ManualTree.fromPaths([]))).to.deep.equal([]);
        });
      });

      // this occurs in ember-browserify/lib/stub-generator.js
      context('to a lazy empty tree', function() {
        it('does not throw', function() {
          expect(function() {
            fsTree.calculatePatch(new fstree.ManualTree());
          }).to.not.throw();
        });
      });

      context('to a non-empty tree', function() {
        it('returns n create operations', function() {
          expect(fsTree.calculatePatch(fstree.ManualTree.fromPaths([
            'bar/',
            'bar/baz.js',
            'foo.js',
          ]))).to.deep.equal([
            ['mkdir',  'bar',        directory('bar/')],
            ['create', 'bar/baz.js', file('bar/baz.js')],
            ['create', 'foo.js',     file('foo.js')],
          ]);
        });
      });
    });

    context('from a simple non-empty tree', function() {
      beforeEach( function() {
        fsTree = fstree.ManualTree.fromPaths([
          'bar/',
          'bar/baz.js',
          'foo.js',
        ]);
      });

      context('to an empty tree', function() {
        it('returns n rm operations', function() {
          expect(fsTree.calculatePatch(fstree.ManualTree.fromPaths([]))).to.deep.equal([
            ['unlink', 'foo.js',     file('foo.js')],
            ['unlink', 'bar/baz.js', file('bar/baz.js')],
            ['rmdir',  'bar',        directory('bar/')],
          ]);
        });
      });
    });

    context('ManualTree with entries', function() {
      function metaIsEqual(a, b) {
        let aMeta = a.meta;
        let bMeta = b.meta;
        let metaKeys = aMeta ? Object.keys(aMeta) : [];
        let otherMetaKeys = bMeta ? Object.keys(bMeta) : [];

        if (metaKeys.length !== Object.keys(otherMetaKeys).length) {
          return false;
        } else {
          for (let i=0; i<metaKeys.length; ++i) {
            if (aMeta[metaKeys[i]] !== bMeta[metaKeys[i]]) {
              return false;
            }
          }
        }

        return true;
      }

      function userProvidedIsEqual(a, b) {
        return defaultIsEqual(a, b) && metaIsEqual(a, b);
      }

      context('of files', function() {
        beforeEach(function() {
          fsTree = new fstree.ManualTree({
            entries: [
              directory('a/'),
              file('a/b.js', { mode: 0o666, size: 1, mtime: 1 }),
              file('a/c.js', { mode: 0o666, size: 1, mtime: 1 }),
              directory('c/'),
              file('c/d.js', { mode: 0o666, size: 1, mtime: 1, meta: { rev: 0 } })
            ]
          });
        });

        it('detects additions', function() {
          let result = fsTree.calculatePatch(new fstree.ManualTree({
            entries: [
              directory('a/'),
              file('a/b.js', { mode: 0o666, size: 1, mtime: 1 }),
              file('a/c.js', { mode: 0o666, size: 1, mtime: 1 }),
              file('a/j.js', { mode: 0o666, size: 1, mtime: 1 }),
              directory('c/'),
              file('c/d.js', { mode: 0o666, size: 1, mtime: 1, meta: { rev: 0 } }),
            ]
          }));

          expect(result).to.deep.equal([
            ['create', 'a/j.js', file('a/j.js', { mode: 0o666, size: 1, mtime: 1 })]
          ]);
        });

        it('detects removals', function() {
          let result = fsTree.calculatePatch(new fstree.ManualTree({
            entries: [
              directory('a/'),
              entry({ relativePath: 'a/b.js', mode: 0o666, size: 1, mtime: 1 })
            ]
          }));

          expect(result).to.deep.equal([
            ['unlink', 'c/d.js', file('c/d.js', { mode: 0o666, size: 1, mtime: 1, meta: { rev: 0 } })],
            ['rmdir',  'c',      directory('c/')],
            ['unlink', 'a/c.js', file('a/c.js', { mode: 0o666, size: 1, mtime: 1 })],
          ]);
        });

        it('detects file updates', function() {
          let entries = [
            directory('a/'),
            file('a/b.js', { mode: 0o666, size: 1, mtime: 2 }),
            file('a/c.js', { mode: 0o666, size: 10, mtime: 1 }),
            directory('c/'),
            file('c/d.js', { mode: 0o666, size: 1, mtime: 1, meta: { rev: 1 } }),
          ];

          let result = fsTree.calculatePatch(new fstree.ManualTree({
            entries: entries
          }), userProvidedIsEqual);

          expect(result).to.deep.equal([
            ['change', 'a/b.js', entries[1]],
            ['change', 'a/c.js', entries[2]],
            ['change', 'c/d.js', entries[4]],
          ]);
        });

        it('detects directory updates from user-supplied meta', function () {
          let entries = [
            directory('a/', { meta: { link: true } }),
            file('a/b.js', { mode: 0o666, size: 1, mtime: 1 }),
            file('a/c.js', { mode: 0o666, size: 1, mtime: 1 }),
            directory('c/'),
            file('c/d.js', { mode: 0o666, size: 1, mtime: 1, meta: { rev: 0 } })
          ];

          let result = fsTree.calculatePatch(new fstree.ManualTree({
            entries: entries
          }), userProvidedIsEqual);

          expect(result).to.deep.equal([
            ['change', 'a', entries[0]]
          ]);
        });

        it('passes the rhs user-supplied entry on updates', function () {
          let bEntry = file('a/b.js', {
            mode: 0o666, size: 1, mtime: 2, meta: { link: true }
          });
          let entries = [
            directory('a/'),
            bEntry,
            file('a/c.js', { mode: 0o666, size: 1, mtime: 1 }),
            directory('c/'),
            file('c/d.js', { mode: 0o666, size: 1, mtime: 1, meta: { rev: 0 } }),
          ];

          let result = fsTree.calculatePatch(new fstree.ManualTree({
            entries: entries
          }));

          expect(result).to.deep.equal([
            ['change', 'a/b.js', bEntry],
          ]);
        });
      });
    });

    context('ManualTree with updates at several different depths', function () {
      beforeEach( function() {
        fsTree = new fstree.ManualTree({
          entries: [
            entry({ relativePath: 'a.js', mode: 0o666, size: 1, mtime: 1 }),
            entry({ relativePath: 'b.js', mode: 0o666, size: 1, mtime: 1 }),
            entry({ relativePath: 'one/a.js', mode: 0o666, size: 1, mtime: 1 }),
            entry({ relativePath: 'one/b.js', mode: 0o666, size: 1, mtime: 1 }),
            entry({ relativePath: 'one/two/a.js', mode: 0o666, size: 1, mtime: 1 }),
            entry({ relativePath: 'one/two/b.js', mode: 0o666, size: 1, mtime: 1 }),
          ]
        });
      });

      it('catches each update', function() {
        let result = fsTree.calculatePatch(new fstree.ManualTree({
          entries: [
            entry({ relativePath: 'a.js', mode: 0o666, size: 1, mtime: 2 }),
            entry({ relativePath: 'b.js', mode: 0o666, size: 1, mtime: 1 }),
            entry({ relativePath: 'one/a.js', mode: 0o666, size: 10, mtime: 1 }),
            entry({ relativePath: 'one/b.js', mode: 0o666, size: 1, mtime: 1 }),
            entry({ relativePath: 'one/two/a.js', mode: 0o667, size: 1, mtime: 1 }),
            entry({ relativePath: 'one/two/b.js', mode: 0o666, size: 1, mtime: 1 }),
          ]
        }));

        expect(result).to.deep.equal([
          ['change', 'a.js', entry({ relativePath: 'a.js', size: 1, mtime: 2, mode: 0o666 })],
          ['change', 'one/a.js', entry({ relativePath: 'one/a.js', size: 10, mtime: 1, mode: 0o666})],
          ['change', 'one/two/a.js', entry({ relativePath: 'one/two/a.js', mode: 0o667, size: 1, mtime: 1})],
        ]);
      });
    });

    context('with unchanged paths', function() {
      beforeEach( function() {
        fsTree = fstree.ManualTree.fromPaths([
          'bar/',
          'bar/baz.js',
          'foo.js',
        ]);
      });

      it('returns an empty changeset', function() {
        expect(fsTree.calculatePatch(fstree.ManualTree.fromPaths([
          'bar/',
          'bar/baz.js',
          'foo.js'
        ]))).to.deep.equal([
          // when we work with entries, will potentially return updates
        ]);
      });
    });

    context('from a non-empty tree', function() {
      beforeEach( function() {
        fsTree = fstree.ManualTree.fromPaths([
          'bar/',
          'bar/one.js',
          'bar/two.js',
          'foo/',
          'foo/one.js',
          'foo/two.js',
        ]);
      });

      context('with removals', function() {
        it('reduces the rm operations', function() {
          expect(fsTree.calculatePatch(fstree.ManualTree.fromPaths([
            'bar/',
            'bar/two.js'
          ]))).to.deep.equal([
            ['unlink', 'foo/two.js', file('foo/two.js')],
            ['unlink', 'foo/one.js', file('foo/one.js')],
            ['rmdir',  'foo',        directory('foo/')],
            ['unlink', 'bar/one.js', file('bar/one.js')],
          ]);
        });
      });

      context('with removals and additions', function() {
        it('works', function() {
          expect(fsTree.calculatePatch(fstree.ManualTree.fromPaths([
            'bar/',
            'bar/three.js'
          ]))).to.deep.equal([
            ['unlink', 'foo/two.js',    file('foo/two.js')],
            ['unlink', 'foo/one.js',    file('foo/one.js')],
            ['rmdir',  'foo',           directory('foo/')],
            ['unlink', 'bar/two.js',    file('bar/two.js')],
            ['unlink', 'bar/one.js',    file('bar/one.js')],
            ['create', 'bar/three.js',  file('bar/three.js')],
          ]);
        });
      });
    });

    context('from a deep non-empty tree', function() {
      beforeEach( function() {
        fsTree = fstree.ManualTree.fromPaths([
          'bar/',
          'bar/quz/',
          'bar/quz/baz.js',
          'foo.js',
        ]);
      });

      context('to an empty tree', function() {
        it('returns n rm operations', function() {
          expect(fsTree.calculatePatch(fstree.ManualTree.fromPaths([]))).to.deep.equal([
            ['unlink', 'foo.js',          file('foo.js')],
            ['unlink', 'bar/quz/baz.js',  file('bar/quz/baz.js')],
            ['rmdir',  'bar/quz',         directory('bar/quz/')],
            ['rmdir',  'bar',             directory('bar/')],
          ]);
        });
      });
    });

    context('from a deep non-empty tree \w intermediate entry', function() {
      beforeEach( function() {
        fsTree = fstree.ManualTree.fromPaths([
          'bar/',
          'bar/foo.js',
          'bar/quz/',
          'bar/quz/baz.js',
        ]);
      });

      context('to an empty tree', function() {
        it('returns one unlink operation', function() {
          expect(fsTree.calculatePatch(fstree.ManualTree.fromPaths([
            'bar/',
            'bar/quz/',
            'bar/quz/baz.js'
          ]))).to.deep.equal([
            ['unlink', 'bar/foo.js', file('bar/foo.js')]
          ]);
        });
      });
    });

    context('another nested scenario', function() {
      beforeEach( function() {
        fsTree = fstree.ManualTree.fromPaths([
          'subdir1/',
          'subdir1/subsubdir1/',
          'subdir1/subsubdir1/foo.png',
          'subdir2/',
          'subdir2/bar.css'
        ]);
      });

      context('to an empty tree', function() {
        it('returns one unlink operation', function() {
          expect(fsTree.calculatePatch(fstree.ManualTree.fromPaths([
            'subdir1/',
            'subdir1/subsubdir1/',
            'subdir1/subsubdir1/foo.png'
          ]))).to.deep.equal([
            ['unlink', 'subdir2/bar.css', file('subdir2/bar.css')],
            ['rmdir',  'subdir2',         directory('subdir2/')]
          ]);
        });
      });
    });

    context('folder => file', function() {
      beforeEach( function() {
        fsTree = fstree.ManualTree.fromPaths([
          'subdir1/',
          'subdir1/foo'
        ]);
      });

      it('it unlinks the file, and rmdir the folder and then creates the file', function() {
        expect(fsTree.calculatePatch(fstree.ManualTree.fromPaths([
          'subdir1'
        ]))).to.deep.equal([
          ['unlink', 'subdir1/foo', file('subdir1/foo')],
          ['rmdir',  'subdir1',     directory('subdir1')],
          ['create', 'subdir1',     file('subdir1')],
        ]);
      });
    });

    context('file => folder', function() {
      beforeEach( function() {
        fsTree = fstree.ManualTree.fromPaths([
          'subdir1'
        ]);
      });

      it('it unlinks the file, and makes the folder and then creates the file', function() {
        expect(fsTree.calculatePatch(fstree.ManualTree.fromPaths([
          'subdir1/',
          'subdir1/foo'
        ]))).to.deep.equal([
          ['unlink', 'subdir1',     file('subdir1')],
          ['mkdir',  'subdir1',     directory('subdir1')],
          ['create', 'subdir1/foo', file('subdir1/foo')]
        ]);
      });
    });

    context('folders', function() {
      beforeEach( function() {
        fsTree = fstree.ManualTree.fromPaths([
          'dir/',
          'dir2/',
          'dir2/subdir1/',
          'dir3/',
          'dir3/subdir1/'
        ]);
      });

      it('it unlinks the file, and makes the folder and then creates the file', function() {
        let result = fsTree.calculatePatch(fstree.ManualTree.fromPaths([
          'dir2/',
          'dir2/subdir1/',
          'dir3/',
          'dir4/',
        ]));

        expect(result).to.deep.equal([
          ['rmdir', 'dir3/subdir1',   directory('dir3/subdir1')],
          ['rmdir', 'dir',            directory('dir')],
          // This no-op (rmdir dir3; mkdir dir3) is not fundamental: a future
          // iteration could reasonably optimize it away
          ['mkdir', 'dir4',           directory('dir4')],
        ]);
      });
    });

    context('walk-sync like tree', function () {
      beforeEach( function() {
        fsTree = new fstree.ManualTree({
          entries: [
            entry(directory('parent/')),
            entry(directory('parent/subdir/')),
            entry(file('parent/subdir/a.js'))
          ]
        });
      });

      it('moving a file out of a directory does not edit directory structure', function () {
        let newTree = new fstree.ManualTree({
          entries: [
            entry(directory('parent/')),
            entry(file('parent/a.js')),
            entry(directory('parent/subdir/')),
          ]
        });
        let result = fsTree.calculatePatch(newTree);

        expect(result).to.deep.equal([
          ['unlink', 'parent/subdir/a.js',  file('parent/subdir/a.js')],
          ['create', 'parent/a.js',         file('parent/a.js')],
        ]);
      });

      it('moving a file out of a subdir and removing the subdir does not recreate parent', function () {
        let newTree = new fstree.ManualTree({
          entries: [
            entry(directory('parent/')),
            entry(file('parent/a.js'))
          ]
        });
        let result = fsTree.calculatePatch(newTree);

        expect(result).to.deep.equal([
          ['unlink', 'parent/subdir/a.js',  file('parent/subdir/a.js')],
          ['rmdir', 'parent/subdir',        directory('parent/subdir')],
          ['create', 'parent/a.js',         file('parent/a.js')],
        ]);
      });

      it('moving a file into nest subdir does not recreate subdir and parent', function () {
        let newTree = new fstree.ManualTree({
          entries: [
            entry(directory('parent/')),
            entry(directory('parent/subdir/')),
            entry(directory('parent/subdir/subdir/')),
            entry(file('parent/subdir/subdir/a.js'))
          ]
        });
        let result = fsTree.calculatePatch(newTree);

        expect(result).to.deep.equal([
          ['unlink', 'parent/subdir/a.js',        file('parent/subdir/a.js')],
          ['mkdir', 'parent/subdir/subdir',       directory('parent/subdir/subdir')],
          ['create', 'parent/subdir/subdir/a.js', file('parent/subdir/subdir/a.js')],
        ]);
      });

      it('always remove files first if dir also needs to be removed', function() {
        let newTree = new fstree.ManualTree({
          entries: [
            entry(directory('parent/'))
          ]
        });

        let result = fsTree.calculatePatch(newTree);

        expect(result).to.deep.equal([
          ['unlink', 'parent/subdir/a.js',  file('parent/subdir/a.js')],
          ['rmdir', 'parent/subdir',        directory('parent/subdir')]
        ]);
      });

      it('renaming a subdir does not recreate parent', function () {
        let newTree = new fstree.ManualTree({
          entries: [
            entry(directory('parent/')),
            entry(directory('parent/subdir2/')),
            entry(file('parent/subdir2/a.js'))
          ]
        });

        let result = fsTree.calculatePatch(newTree);

        expect(result).to.deep.equal([
          ['unlink', 'parent/subdir/a.js',  file('parent/subdir/a.js')],
          ['rmdir', 'parent/subdir',        directory('parent/subdir')],
          ['mkdir', 'parent/subdir2',       directory('parent/subdir2')],
          ['create', 'parent/subdir2/a.js', file('parent/subdir2/a.js')],
        ]);
      });
    });
  });

  describe('.applyPatch', function() {
    let inputDir = 'tmp/fixture/input';
    let outputDir = 'tmp/fixture/output';

    beforeEach(function() {
      fs.mkdirpSync(inputDir);
      fs.mkdirpSync(outputDir);
    });

    afterEach(function() {
      fs.removeSync('tmp');
    });

    it('applies all types of operations', function() {
      let firstTree = fstree.ManualTree.fromEntries(walkSync.entries(inputDir));

      let fooIndex = path.join(inputDir, 'foo/index.js');
      let barIndex = path.join(inputDir, 'bar/index.js');
      let barOutput = path.join(outputDir, 'bar/index.js')

      fs.outputFileSync(fooIndex, 'foo'); // mkdir + create
      fs.outputFileSync(barIndex, 'bar'); // mkdir + create

      let secondTree = fstree.ManualTree.fromEntries(walkSync.entries(inputDir));
      let patch = firstTree.calculatePatch(secondTree);

      fstree.ManualTree.applyPatch(inputDir, outputDir, patch);
      expect(walkSync(outputDir)).to.deep.equal([
        'bar/',
        'bar/index.js',
        'foo/',
        'foo/index.js'
      ]);
      expect(fs.readFileSync(barOutput, 'utf-8')).to.equal('bar');

      fs.removeSync(path.dirname(fooIndex)); // unlink + rmdir
      fs.outputFileSync(barIndex, 'boo'); // change

      let thirdTree = fstree.ManualTree.fromEntries(walkSync.entries(inputDir));
      patch = secondTree.calculatePatch(thirdTree);

      fstree.ManualTree.applyPatch(inputDir, outputDir, patch);
      expect(walkSync(outputDir)).to.deep.equal([
        'bar/',
        'bar/index.js'
      ]);
      expect(fs.readFileSync(barOutput, 'utf-8')).to.equal('boo');
    });

    it('supports custom delegate methods', function() {
      let inputDir = 'tmp/fixture/input';
      let outputDir = 'tmp/fixture/output';

      let stats = {
        unlink: 0,
        rmdir: 0,
        mkdir: 0,
        change: 0,
        create: 0
      };
      let delegate = {
        unlink: function() {
          stats.unlink++;
        },
        rmdir: function() {
          stats.rmdir++;
        },
        mkdir: function() {
          stats.mkdir++;
        },
        change: function() {
          stats.change++;
        },
        create: function() {
          stats.create++;
        }
      };

      let patch = [
        [ 'mkdir', 'bar/' ],
        [ 'create', 'bar/index.js' ],
        [ 'mkdir', 'foo/' ],
        [ 'create', 'foo/index.js' ],
        [ 'unlink', 'foo/index.js' ],
        [ 'rmdir', 'foo/' ],
        [ 'change', 'bar/index.js' ]
      ];

      fstree.ManualTree.applyPatch(inputDir, outputDir, patch, delegate);

      expect(stats).to.deep.equal({
        unlink: 1,
        rmdir: 1,
        mkdir: 2,
        change: 1,
        create: 2
      });
    });

    it('throws an error when a patch has an unknown operation type', function() {
      let patch = [ [ 'delete', '/foo.js' ] ];
      expect(function() {
        fstree.ManualTree.applyPatch('/fixture/input', '/fixture/output', patch)
      }).to.throw('Unable to apply patch operation: delete. The value of delegate.delete is of type undefined, and not a function. Check the \'delegate\' argument to \'ManualTree.prototype.applyPatch\'.');
    });
  });

  describe('.calculateAndApplyPatch', function() {
    let inputDir = 'tmp/fixture/input';
    let outputDir = 'tmp/fixture/output';

    beforeEach(function() {
      fs.mkdirpSync(inputDir);
      fs.mkdirpSync(outputDir);
    });

    afterEach(function() {
      fs.removeSync('tmp');
    });

    it('calculates and applies a patch properly', function() {
      let firstTree = fstree.ManualTree.fromEntries(walkSync.entries(inputDir));

      let fooIndex = path.join(inputDir, 'foo/index.js');
      let barIndex = path.join(inputDir, 'bar/index.js');
      let barOutput = path.join(outputDir, 'bar/index.js')

      fs.outputFileSync(fooIndex, 'foo');
      fs.outputFileSync(barIndex, 'bar');

      let secondTree = fstree.ManualTree.fromEntries(walkSync.entries(inputDir));
      firstTree.calculateAndApplyPatch(secondTree, inputDir, outputDir);

      expect(walkSync(outputDir)).to.deep.equal([
        'bar/',
        'bar/index.js',
        'foo/',
        'foo/index.js'
      ]);
    });

    it('calculates and applies a patch properly with custom delegates', function() {
      let stats = {
        mkdir: 0,
        create: 0
      };
      let delegate = {
        mkdir: function() {
          stats.mkdir++;
        },
        create: function() {
          stats.create++;
        }
      };

      let firstTree = fstree.ManualTree.fromEntries(walkSync.entries(inputDir));

      let fooIndex = path.join(inputDir, 'foo/index.js');
      let barIndex = path.join(inputDir, 'bar/index.js');

      fs.outputFileSync(fooIndex, 'foo');
      fs.outputFileSync(barIndex, 'bar');

      let secondTree = fstree.ManualTree.fromEntries(walkSync.entries(inputDir));
      firstTree.calculateAndApplyPatch(secondTree, inputDir, outputDir, delegate);

      expect(stats).to.deep.equal({
        mkdir: 2,
        create: 2
      });
    });
  });
});

