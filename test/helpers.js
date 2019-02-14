'use strict';

const fs = require('fs-extra');
const md5hex = require('md5hex');
const path = require('path');
const walkSync = require('walk-sync');

const fstree = require('../lib');
const Entry = require('../lib/entry');

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

/** Creates a FacadeTree and manually populates its entries.
 *
 * HACK: This function, and most tests, were created before the entires + root
 * combination was disallowed, so this function hacks around that limitation.
 * Real trees are *not* composed this way, and so all tests relying on this
 * behavior need to re-written to use more realistic trees.  See FPE-495.
 */
module.exports.treeFromDisk = function(root, Tree_) {
  const Tree = Tree_ || fstree.WritableTree;

  if (Tree !== fstree.SourceTree && Tree !== fstree.WritableTree) {
    throw new TypeError('This helper only supports SourceTrees and WritableTrees.');
  }

  const tree = new Tree({ root });

  // Populate the private property containing the scanned/created entries.
  tree._entries = walkSync.entries(root);

  if (tree instanceof fstree.SourceTree) {
    // Source trees elide broken symlinks.
    tree._entries = tree._entries.filter(entry => entry.mode !== undefined);
  } else {
    // Convert scanned symlinks to external links.
    tree._entries.forEach(entry => {
      try {
        entry._symlink = { external: fs.readlinkSync(path.join(root, entry.relativePath)) };
      } catch (ex) {
        // EINVAL is thrown if it wasn't a link.
        if (!/^EINVAL\b/.test(ex.message)) {
          throw ex;
        }
      }
    });
  }

  tree._entries = tree._entries.map(entry => {
    // Convert to real Entry objects so that .isDirectory, .isSymbolicLink,
    // etc. work.  Automatically strips trailing slashes.
    return new Entry(entry.relativePath, entry.size, entry.mtime, entry.mode);
  });

  // walk-sync sorts with trailing slashes on directories; we must re-sort now
  // that they've been trimmed.
  tree._entries.sort((a, b) => {
    if (a.relativePath < b.relativePath) {
      return -1;
    }

    if (b.relativePath < a.relativePath) {
      return 1;
    }

    return 0;
  });

  if (tree instanceof fstree.SourceTree) {
    // Source trees track which directories have been scanned; populate that as well.
    const directories = tree._entries.filter(entry => entry.isDirectory());
    const paths = directories.map(entry => entry.relativePath);

    paths.forEach(path_ => tree._scannedDirectories.add(path_));
  } else {
    // Writable trees will only contain files they wrote; in other words, the
    // checksum will always be present.
    tree._entries.filter(entry => entry.isFile()).forEach(entry => {
      const content = fs.readFileSync(path.join(tree.root, entry.relativePath));
      const checksum = md5hex('' + content);

      entry.checksum = checksum;
    });

    // Writable trees must be started before writing.
    tree.start();
  }

  return tree;
};
