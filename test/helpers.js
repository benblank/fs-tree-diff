'use strict';

const fixturify = require('fixturify');
const fs = require('fs-extra');
const md5hex = require('md5hex');
const os = require('os');
const path = require('path');
const walkSync = require('walk-sync');

const fstree = require('../lib');
const Entry = require('../lib/entry');

const RANDOM_ROOT_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const RANDOM_ROOT_LENGTH = 6;

module.exports.ROOT_CONTAINER = `${path.resolve(os.tmpdir())}/fs-tree-diff-test-roots`;

class EntryWithMeta extends Entry {
  constructor(options) {
    let checksum = options.checksum;
    let meta = options.meta;
    let mode = options.mode;
    let mtime = options.mtime;
    let relativePath = options.relativePath;
    let size = options.size;

    super(relativePath, size, mtime, mode, checksum);

    if (meta) {
      this.meta = meta;
    }
  };
}

module.exports.directory = function(relativePath, options) {
  return module.exports.entry(Object.assign({
    mode: Entry.DIRECTORY_MODE,
    relativePath,
  }, options));
};

module.exports.entry = function(options) {
  return new EntryWithMeta({
    checksum: options.checksum,
    meta: options.meta,
    mode: options.mode || 0,
    mtime: options.mtime || 0,
    relativePath: options.relativePath,
    size: options.size,
  });
};

module.exports.file = function(relativePath, options) {
  return module.exports.entry(Object.assign({
    mode: Entry.FILE_MODE,
    relativePath,
  }, options));
};

/** Get a randomly-named path for use as a tree root. */
module.exports.getTempRoot = function() {
  const randomChars = [];

  for (let i = 0; i < RANDOM_ROOT_LENGTH; i++) {
    randomChars.push(RANDOM_ROOT_CHARS[Math.floor(Math.random() * RANDOM_ROOT_CHARS.length)]);
  }

  return path.join(module.exports.ROOT_CONTAINER, randomChars.join(''));
}

/** Create a SourceTree pointing at the specified fixture. */
module.exports.sourceTreeFromFixture = function(fixture) {
  const root = module.exports.getTempRoot();

  fixturify.writeSync(root, fixture);

  return new fstree.SourceTree({ root });
}

/** Create a WritableTree pre-populated from the specified fixture. */
module.exports.writableTreeFromFixture = function(fixture) {
  const root = module.exports.getTempRoot();

  fs.mkdirpSync(root);

  const tree = new fstree.WritableTree({ root });

  tree.start();

  function createDirectory(path_, fixture) {
    for (const [ name, contents ] of Object.entries(fixture)) {
      if (!name) {
        throw new Error('name must be a non-empty string');
      }

      if (/^\.\.?$/.test(name)) {
        throw new Error('name cannot be . or ..');
      }

      if (/\/|\\/.test(name)) {
        throw new Error(`name cannot contain slashes: ${name}`)
      }

      if (typeof contents === 'object') {
        tree.mkdirSync(path.join(...path_, name));
        createDirectory([...path_, name], contents);
      } else {
        tree.writeFileSync(path.join(...path_, name), contents);
      }
    }
  }

  createDirectory([], fixture);

  return tree;
}
