'use strict';

const expect = require('chai').expect;

const Entry = require('../lib/entry');
const shared = require('../lib/shared');

const basename = shared._basename;
const commonPrefix = shared._commonPrefix;
const compareChanges = shared.compareChanges;
const computeImpliedEntries = shared._computeImpliedEntries;
const entryRelativePath = shared.entryRelativePath;
const sortAndExpand = shared.sortAndExpand;

require('chai').config.truncateThreshold = 0;

describe('shared', function() {
  const originalNow = Date.now;

  beforeEach(function() {
    Date.now = (() => 0);
  });

  afterEach(function() {
    Date.now = originalNow;
  });

  describe('.commonPrefix', function() {
    it('computes no common prefix if none exists', function() {
      expect(commonPrefix('a', 'b')).to.equal('');
    });

    it('computes the common prefix between two strings', function() {
      expect(commonPrefix('a/b/c/', 'a/b/c/d/e/f/', '/')).to.equal('a/b/c/');
    });

    it('strips the suffix (of the common prefix) after the last occurrence of the terminal character', function() {
      expect(commonPrefix('a/b/c/ohai', 'a/b/c/obai', '/')).to.equal('a/b/c/');
    });
  });

  describe('.basename', function() {
    it('computes the basename of files', function() {
      expect(basename(Entry.fromPath('a/b/c'))).to.equal('a/b/');
    });

    it('computes the basename of directories', function() {
      expect(basename(Entry.fromPath('a/b/c/'))).to.equal('a/b/');
    });
  });

  describe('.computeImpliedEntries', function() {
    it('computes implied entries', function() {
      let entries = computeImpliedEntries('a/b/', 'c/d/e/');

      expect(entries).to.deep.equal([
        new Entry('a/b/c/', undefined, 0, Entry.DIRECTORY_MODE),
        new Entry('a/b/c/d/', undefined, 0, Entry.DIRECTORY_MODE),
        new Entry('a/b/c/d/e/', undefined, 0, Entry.DIRECTORY_MODE),
      ]);
    });

    it('does not compute existing entries', function() {
      let entries = computeImpliedEntries('a/', 'b/c/');

      expect(entries.map(e => e.relativePath)).to.deep.equal([
        'a/b', 'a/b/c'
      ]);
    });
  });

  describe('.sortAndExpand', function() {
    it('sorts and expands entries in place', function() {
      let entries = [
        'a/b/q/r/bar.js',
        'a/b/c/d/foo.js',
      ].map(e => Entry.fromPath(e));

      var sortedAndExpandedEntries = sortAndExpand(entries);

      expect(entries).to.equal(sortedAndExpandedEntries);
      expect(sortedAndExpandedEntries.map(function(e) { return e.relativePath; })).to.deep.equal([
        'a',
        'a/b',
        'a/b/c',
        'a/b/c/d',
        'a/b/c/d/foo.js',
        'a/b/q',
        'a/b/q/r',
        'a/b/q/r/bar.js',
      ]);
      expect(sortedAndExpandedEntries).to.deep.equal([
        new Entry('a', undefined, 0, Entry.DIRECTORY_MODE),
        new Entry('a/b', undefined, 0, Entry.DIRECTORY_MODE),
        new Entry('a/b/c', undefined, 0, Entry.DIRECTORY_MODE),
        new Entry('a/b/c/d', undefined, 0, Entry.DIRECTORY_MODE),
        new Entry('a/b/c/d/foo.js', undefined, 0, Entry.FILE_MODE),
        new Entry('a/b/q', undefined, 0, Entry.DIRECTORY_MODE),
        new Entry('a/b/q/r', undefined, 0, Entry.DIRECTORY_MODE),
        new Entry('a/b/q/r/bar.js', undefined, 0, Entry.FILE_MODE),
      ]);
    });
  });

  describe('.entryRelativePath', function() {
    it('strips nothing for file entries', function() {
      expect(entryRelativePath(new Entry('my-path', 0, 0, 0))).to.eql('my-path');
      expect(entryRelativePath(new Entry('my-path/', 0, 0, 0))).to.eql('my-path/');
      expect(entryRelativePath(new Entry('my-path\\', 0, 0, 0))).to.eql('my-path\\');
    });

    it('strips trailing / or \\ for directory entries', function() {
      expect(
        entryRelativePath(new Entry('my-path', 0, 0, Entry.DIRECTORY_MODE))
      ).to.eql('my-path');
      expect(
        entryRelativePath(new Entry('my-path/', 0, 0, Entry.DIRECTORY_MODE))
      ).to.eql('my-path');
      expect(
        entryRelativePath(new Entry('my-path\\', 0, 0, Entry.DIRECTORY_MODE))
      ).to.eql('my-path');
    });
  });

  describe('.compareChanges', () => {
    it('sorts remove operations together', () => {
      expect(compareChanges(['rmdir', ''], ['rmdir', ''])).to.equal(0);
      expect(compareChanges(['rmdir', ''], ['unlink', ''])).to.equal(0);
      expect(compareChanges(['unlink', ''], ['rmdir', ''])).to.equal(0);
      expect(compareChanges(['unlink', ''], ['unlink', ''])).to.equal(0);
    });

    it('sorts add/update operations together', () => {
      expect(compareChanges(['change', ''], ['change', ''])).to.equal(0);
      expect(compareChanges(['change', ''], ['create', ''])).to.equal(0);
      expect(compareChanges(['change', ''], ['mkdir', ''])).to.equal(0);
      expect(compareChanges(['create', ''], ['change', ''])).to.equal(0);
      expect(compareChanges(['create', ''], ['create', ''])).to.equal(0);
      expect(compareChanges(['create', ''], ['mkdir', ''])).to.equal(0);
      expect(compareChanges(['mkdir', ''], ['change', ''])).to.equal(0);
      expect(compareChanges(['mkdir', ''], ['create', ''])).to.equal(0);
      expect(compareChanges(['mkdir', ''], ['mkdir', ''])).to.equal(0);
    });

    it('sorts remove operations above add/update operations', () => {
      expect(compareChanges(['rmdir', ''], ['mkdir', ''])).to.equal(-1);
      expect(compareChanges(['mkdir', ''], ['rmdir', ''])).to.equal(1);
    });

    it('sorts remove operations in reverse lexicographic order', () => {
      expect(compareChanges(['rmdir', 'a'], ['rmdir', 'b'])).to.equal(1);
      expect(compareChanges(['rmdir', 'b'], ['rmdir', 'a'])).to.equal(-1);
    });

    it('sorts add/update operations in lexicographic order', () => {
      expect(compareChanges(['mkdir', 'a'], ['mkdir', 'b'])).to.equal(-1);
      expect(compareChanges(['mkdir', 'b'], ['mkdir', 'a'])).to.equal(1);
    });

    it('sorts by operation before path', () => {
      expect(compareChanges(['rmdir', 'a'], ['mkdir', 'b'])).to.equal(-1);
      expect(compareChanges(['rmdir', 'b'], ['mkdir', 'a'])).to.equal(-1);
      expect(compareChanges(['mkdir', 'a'], ['rmdir', 'b'])).to.equal(1);
      expect(compareChanges(['mkdir', 'b'], ['rmdir', 'a'])).to.equal(1);
    });
  });

  describe('.searchByRelativePath', () => {
    function expectResult(haystack, needle, expected, closest) {
      const entries = haystack.map(Entry.fromPath);

      expect(shared.searchByRelativePath(entries, needle, closest)).to.equal(expected);
    }

    const letters = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];

    it('returns -1 for an empty array', () => {
      expectResult([], 'foo', -1);
      expectResult([], 'foo', -1, true);
    });

    it('finds a match at the beginning of the array', () => {
      expectResult(letters, 'a', 0);
      expectResult(letters, 'a', 0, true);
    });

    it('finds a match at the end of the array', () => {
      expectResult(letters, 'i', 8);
      expectResult(letters, 'i', 8, true);
    });

    it('finds a match in the middle of the array', () => {
      expectResult(letters, 'b', 1);
      expectResult(letters, 'c', 2);
      expectResult(letters, 'f', 5);
      expectResult(letters, 'h', 7);

      expectResult(letters, 'b', 1, true);
      expectResult(letters, 'c', 2, true);
      expectResult(letters, 'f', 5, true);
      expectResult(letters, 'h', 7, true);
    });

    describe('when closest is false', () => {
      it('returns -1 for an target before the beginning of the array', () => {
        expectResult(letters, ' ', -1);
      });

      it('returns -1 for an target after the end of the array', () => {
        expectResult(letters, 'j', -1);
      });

      it('returns -1 for an target missing from the array', () => {
        expectResult(letters, 'e/js', -1);
      });
    });

    describe('when closest is true', () => {
      it('returns -1 for a target before the beginning of the array', () => {
        expectResult(letters, ' ', -1, true);
      });

      it('returns the last index for a target after the end of the array', () => {
        expectResult(letters, 'j', 8, true);
      });

      it('returns the previous index for a target missing from the array', () => {
        debugger;
        expectResult(letters, 'e/js', 4, true);
      });
    });
  });
});
