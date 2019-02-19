'use strict';

const fs = require('fs');
const logger = require('heimdalljs-logger')('fs-tree-diff:');
const md5hex = require('md5hex');
const Minimatch = require('minimatch').Minimatch;
const path = require('path');
const symlinkOrCopy = require('symlink-or-copy');

const Entry = require('./entry');
const shared = require('./shared');

// Due to the interdependencies between some of these classes, (e.g. FacadeTree
// and Projection; Delegator and WritableTree), they have all been placed in a
// single file to avoid circular dependency import issues.

// ========================================================================= //
// ManualTree
// ========================================================================= //

const DEFAULT_DELEGATE = {
  change: function(inputPath, outputPath, relativePath) {
    // We no-op if the platform can symlink, because we assume the output path
    // is already linked via a prior create operation.
    if (symlinkOrCopy.canSymlink) {
      return;
    }

    fs.unlinkSync(outputPath);
    symlinkOrCopy.sync(inputPath, outputPath);
  },

  create: function(inputPath, outputPath, relativePath) {
    symlinkOrCopy.sync(inputPath, outputPath);
  },

  mkdir: function(inputPath, outputPath, relativePath) {
    fs.mkdirSync(outputPath);
  },

  rmdir: function(inputPath, outputPath, relativePath) {
    fs.rmdirSync(outputPath);
  },

  unlink: function(inputPath, outputPath, relativePath) {
    fs.unlinkSync(outputPath);
  },
};

function addCommand(entry) {
  return [Entry.isDirectory(entry) ? 'mkdir' : 'create', shared.entryRelativePath(entry), entry];
}

function applyOperation(input, output, operation, delegate) {
  const method = operation[0];
  const relativePath = operation[1];
  const inputPath = path.join(input, relativePath);
  const outputPath = path.join(output, relativePath);
  const delegateType = typeof delegate[method];

  if (delegateType === 'function') {
    delegate[method](inputPath, outputPath, relativePath);
  } else {
    throw new Error(`Unable to apply patch operation: ${method}. The value of delegate.${method} is of type ${delegateType}, and not a function. Check the 'delegate' argument to 'ManualTree.prototype.applyPatch'.`);
  }
}

function removeCommand(entry) {
  return [Entry.isDirectory(entry) ? 'rmdir' : 'unlink', shared.entryRelativePath(entry), entry];
}

function updateCommand(entry) {
  return ['change', shared.entryRelativePath(entry), entry];
}

function ManualTree(options_) {
  const options = options_ || {};

  this.entries = options.entries || [];

  if (options.sortAndExpand) {
    shared.sortAndExpand(this.entries);
  } else {
    shared.validateSortedUnique(this.entries);
  }
}

Object.assign(ManualTree, {
  applyPatch(input, output, patch, delegate_) {
    const delegate = Object.assign({}, DEFAULT_DELEGATE, delegate_);

    for (let i = 0; i < patch.length; i++) {
      applyOperation(input, output, patch[i], delegate);
    }
  },

  defaultIsEqual(entryA, entryB) {
    if (Entry.isDirectory(entryA) && Entry.isDirectory(entryB)) {
      // ignore directory changes by default
      return true;
    }

    const equal = entryA.size === entryB.size &&
      +entryA.mtime === +entryB.mtime &&
      entryA.mode === entryB.mode;


    if (!equal) {
      logger.info('invalidation reason: \nbefore %o\n entryB %o', entryA, entryB);
    }

    return equal;
  },

  // Can't use shorthand, as some client code uses 'new'.
  fromEntries: function(entries, options) {
    if (this.constructor === ManualTree.fromEntries) {
      shared.emitDeprecationWarning('fromEntries is not a constructor and should not be called with \'new\'.')
    }

    return new ManualTree(Object.assign({}, options || {}, {
      entries: entries,
    }));
  },

  // Can't use shorthand, as some client code uses 'new'.
  fromPaths: function(paths, options) {
    if (this.constructor === ManualTree.fromPaths) {
      shared.emitDeprecationWarning('fromPaths is not a constructor and should not be called with \'new\'.')
    }

    return new ManualTree(Object.assign({}, options || {}, {
      entries: paths.map(path_ => Entry.fromPath(path_)),
    }));
  },
});

Object.defineProperties(ManualTree.prototype, {
  size: {
    get() {
      return this.entries.length;
    }
  }
});

Object.assign(ManualTree.prototype, {
  addEntries(entries, options) {
    if (!Array.isArray(entries)) {
      throw new TypeError('entries must be an array');
    }

    if (!entries.length) {
      // Nothing to do.
      return;
    }

    if (options && options.sortAndExpand) {
      shared.sortAndExpand(entries);
    } else {
      shared.validateSortedUnique(entries);
    }

    this.entries = shared.mergeEntries(this.entries, entries, false);
  },

  addPaths(paths, options) {
    this.addEntries(paths.map(path_ => Entry.fromPath(path_)), options);
  },

  calculateAndApplyPatch(otherFSTree, input, output, delegate) {
    const patch = this.calculatePatch(otherFSTree);

    ManualTree.applyPatch(input, output, patch, delegate);
  },

  calculatePatch(otherFSTree, isEqual) {
    if (arguments.length > 1 && typeof isEqual !== 'function') {
      throw new TypeError('calculatePatch\'s second argument must be a function');
    }

    if (typeof isEqual !== 'function') {
      isEqual = ManualTree.defaultIsEqual;
    }

    let ours = this.entries;
    let theirs = otherFSTree.entries;
    let additions = [];

    let i = 0;
    let j = 0;

    let removals = [];

    while (i < ours.length && j < theirs.length) {
      let x = ours[i];
      let y = theirs[j];
      let xpath = shared.entryRelativePath(x);
      let ypath = shared.entryRelativePath(y);

      if (xpath < ypath) {
        // ours
        i++;

        removals.push(removeCommand(x));

        // remove additions
      } else if (xpath > ypath) {
        // theirs
        j++;
        additions.push(addCommand(y));
      } else {
        if (!isEqual(x, y)) {
          let xFile = Entry.isFile(x);
          let yFile = Entry.isFile(y);

          if (xFile === yFile) {
            // file -> file update or directory -> directory update
            additions.push(updateCommand(y));
          } else {
            // file -> directory or directory -> file
            removals.push(removeCommand(x));
            additions.push(addCommand(y));
          }
        }
        // both are the same
        i++; j++;
      }
    }

    // cleanup ours
    for (; i < ours.length; i++) {
      removals.push(removeCommand(ours[i]));
    }

    // cleanup theirs
    for (; j < theirs.length; j++) {
      additions.push(addCommand(theirs[j]));
    }

    // operations = removals (in reverse) then additions
    return removals.reverse().concat(additions);
  },
});

// ========================================================================= //
// FacadeTree
// ========================================================================= //

/** An error representing misuse of the abstract class FacadeTree.
 *
 * Specifically, errors of this type are thrown when attempting to instantiate
 * {@link FacadeTree} or failing to implement its abstract methods and
 * properties in a subclass.
 *
 * Only useful during development; client code should **never** see errors of
 * this type.
 */
function AbstractionError() {}
AbstractionError.prototype = Object.create(TypeError.prototype)
AbstractionError.prototype.constructor = AbstractionError;

/** Create an AbstractionError with a stock message for missing methods.
 *
 * @param {string} methodName The method which is missing.
 * @returns {AbstractionError} A new AbstractionError.
 */
AbstractionError.prototype.forMethod = function(methodName) {
  return new AbstractionError(`FacadeTree subclasses must implement the abstract method '${methodName}'.`)
};

/** A tree which represents a directory in the filesystem.
 *
 * FacadeTree is the base class from which all trees tied to the filesystem
 * descend.  All FacadeTrees are capable of reading the disk.
 *
 * @abstract
 */
function FacadeTree() {
  if (this.constructor === FacadeTree) {
    throw new AbstractionError('FacadeTree is abstract and cannot be directly instantiated.');
  }

  // Children must be tracked so that they can be notified of rereads.
  this._children = new Set();
}

Object.defineProperties(FacadeTree.prototype, {
  entries: {
    /** An array of Entry objects representing all paths managed by this tree.
     *
     * @abstract
     * @type {Entry[]}
     */
    get() {
      throw AbstractionError.forMethod('get entries');
    },
  },

  paths: {
    /** An array of strings representing all paths managed by this tree.
     *
     * @type {string[]}
     */
    get() {
      return this.entries.map(entry => entry.relativePath);
    },
  },

  root: {
    /** The absolute path to the directory managed by this tree.
     *
     * @type {string}
     */
    get() {
      return this._root;
    },
  },
});

Object.assign(FacadeTree.prototype, {
  /** The result of a call to _findByRelativePath.
   *
   * @typedef {object} FacadeTree~FindResult
   * @param {?FacadeTree} tree The tree in which the entry was found, or null.
   * @param {?Entry} entry The entry which was found, or null.
   */

  /** Find the entry and containing tree, if any, representing the specified path.
   *
   * This implementation requires an `_entries` array, so must only be used by
   * trees which provide one (e.g. SourceTree and WritableTree).
   *
   * @param {string} normalizedPath The path for which to search.  Normalized before use.
   * @private
   * @returns {FacadeTree~FindResult} The results of the search.
   */
  _findByRelativePath(normalizedPath) {
    return this._findInArrayByRelativePath(this._entries, normalizedPath);
  },

  /** Find the entry and containing tree, if any, representing the specified path.
   *
   * This is the implementation of _findByRelativePath, genericized so that it
   * can be used to search any array (such as the _entriesFromFiles used by
   * some Projections).
   *
   * @param {Entry[]} array The array of entries to search.
   * @param {string} normalizedPath The path for which to search.  Normalized before use.
   * @private
   * @returns {FacadeTree~FindResult} The results of the search.
   */
  _findInArrayByRelativePath(array, normalizedPath) {
    if (normalizedPath === '') {
      return { entry: Entry.ROOT, tree: this };
    }

    const index = shared.searchByRelativePath(array, normalizedPath);

    if (index === -1) {
      return { entry: null, tree: null };
    }

    return { entry: array[index], tree: this };
  },

  /** Returns only those entries immediately contained by the specified path.
   *
   * No distinction is made between a missing directory and an empty one — both
   * return an empty array.
   *
   * This implementation requires an `_entries` array, so must only be used by
   * trees which provide one (e.g. SourceTree and WritableTree).
   *
   * @param {string} normalizedPath The path to the directory whose entries should be returned.
   * @private
   * @returns {Entry[]} The entries which are immediate children of the specified path.
   */
  _getEntriesForDirectory(normalizedPath) {
    return this._getEntriesFromArrayForDirectory(this._entries, normalizedPath);
  },

  /** Returns only those entries immediately contained by the specified path.
   *
   * No distinction is made between a missing directory and an empty one — both
   * return an empty array.
   *
   * This is the implementation of _getEntriesForDirectory, genericized so that
   * it can be used to search any array (such as the _entriesFromFiles used by
   * some Projections).
   *
   * @param {Entry[]} array The array of entries to search.
   * @param {string} normalizedPath The path to the directory whose entries should be returned.
   * @private
   * @returns {Entry[]} The entries which are immediate children of the specified path.
   */
  _getEntriesFromArrayForDirectory(array, normalizedPath) {
    const normalizedPathWithSeparator = shared.ensureSeparator(normalizedPath);
    let index;

    // The _entries[0].….startsWith case can occur when a SourceTree's root has not been scanned.
    if (normalizedPath === '' || array.length && shared.startsWith(array[0].relativePath, normalizedPathWithSeparator)) {
      // Index will be incremented before use, so start at -1.
      index = -1;
    } else {
      index = shared.searchByRelativePath(array, normalizedPath);

      if (index === -1) {
        return [];
      }
    }

    // Increment index to skip the matched entry.
    let entry = array[++index];

    if (!entry) {
      // The entry for `normalizedPath` is the last one.
      return [];
    }

    // The directory's entry may not be immediately followed by its contents.
    while (!shared.startsWith(entry.relativePath, normalizedPathWithSeparator)) {
      index++;
      entry = array[index];

      if (!entry) {
        // Ran off the end of the array.
        return [];
      }
    }

    const foundEntries = [];

    while (shared.startsWith(entry.relativePath, normalizedPathWithSeparator)) {
      const relativePath = entry.relativePath.substring(normalizedPathWithSeparator.length);

      if (relativePath.indexOf('/') === -1) {
        foundEntries.push(Entry.clone(entry, relativePath));
      }

      index++;
      entry = array[index];

      if (!entry) {
        // Ran off the end of the array.
        return foundEntries;
      }
    }

    return foundEntries;
  },

  /** Get the stats object for this tree's root.
   *
   * This default implementation caches the stats read from the filesystem, as
   * the root directory is not expected to be altered.
   *
   * @private
   * @returns {fs.Stats} The stats of this tree's root directory.
   * @see Projection#_getRootStat
   */
  _getRootStat() {
    if (!this._rootStat) {
      this._rootStat = fs.statSync(this.root);
    }

    return this._rootStat;
  },

  /** Perform once-per-build-cycle tasks.
   *
   * For example, this is used by {@link SourceTree} instances to clear their
   * cached entries and reset directory scanning.  Also calls the _reread
   * method on all child trees; for this reason, all child class
   * implementations must call this super method as well.
   *
   * This is a separate method from {@link FacadeTree#reread} so that
   * {@link Delegator} instances can ignore calls to the public function while
   * still passing calls to the private function down to its children, as its
   * private function will already have been called by its delegate.
   *
   * @private
   */
  _reread(/* newRoot */) {
    for (const child of this._children) {
      child._reread();
    }
  },

  /** Obtain the absolute path corresponding to a relative path.
   *
   * This tree's root is used as the base.  The provided path is normalized
   * before use.
   *
   * Note that there is no guarantee that the returned path actually exists in
   * the tree or the filesystem.
   *
   * @param {string} normalizedPath The path to resolve.
   * @private
   * @returns {string} An absolute path corresponding to the provided path.
   */
  _resolvePath(normalizedPath) {
    return shared.joinPaths(this.root, normalizedPath);
  },

  /** An array of change objects representing the actions taken since the last build.
   *
   * @abstract
   * @type {Array[]}
   */
  changes() {
    throw AbstractionError.forMethod('changes');
  },

  /** Create a Projection rooted in the specified directory.
   *
   * The new {@link Projection} will act as a tree whose root is the specified
   * directory.
   *
   * @param {string} relativePath The CWD for the new Projection.
   * @returns {Projection} The new Projection.
   * @throws If relativePath does not exist.
   * @throws if relativePath is not a directory.
   */
  chdir(relativePath) {
    const normalizedPath = shared.normalizeRelativePath(relativePath);
    const result = this._findByRelativePath(normalizedPath);

    if (!result.entry) {
      throw new Error(`ENOENT: no such file or directory, ${relativePath}`);
    }

    if (result.entry.isFile()) {
      throw new Error(`ENOTDIR: not a directory, ${relativePath}`);
    }

    return new Projection({
      cwd: normalizedPath,
      parent: this,
    });
  },

  /** Determines whether the specified path exists.
   *
   * @param {string} relativePath The path to query.
   * @returns {boolean} True if the path exists; false, otherwise.
   */
  existsSync(relativePath) {
    const normalizedPath = shared.normalizeRelativePath(relativePath);
    const result = this._findByRelativePath(normalizedPath);

    return !!result.entry;
  },

  /** Creates a Projection of this tree with the specified filters.
   *
   * @param {Object} options See {@link Projection} for details.
   * @returns {Projection} The new Projection.
   */
  filtered(options) {
    return new Projection(Object.assign({}, options, { parent: this }));
  },

  /** Read a file's contents.
   *
   * @param {string} relativePath The path to the file to be read.
   * @param {Object|string} encoding
   * @returns {Buffer|string} The file's contents as a string if encoding is specified; otherwise, a Buffer.
   * @see https://nodejs.org/api/fs.html#fs_fs_readfilesync_path_options
   */
  readFileSync(relativePath, encoding) {
    const normalizedPath = shared.normalizeRelativePath(relativePath);
    const result = this._findByRelativePath(normalizedPath);

    if (!result.entry) {
      throw new Error(`ENOENT: no such file or directory, open '${relativePath}'`);
    } else if (result.entry.isDirectory()) {
      throw new Error(`EISDIR: illegal operation on a directory, read '${relativePath}'`);
    }

    return fs.readFileSync(result.tree._resolvePath(result.entry.relativePath), encoding);
  },

  /** Read the contents of a directory.
   *
   * Returns the basename of each of the entries immediately contained by the
   * specified path (i.e. not including the contents of subdirectories).
   *
   * @param {string} relativePath The directory to read.
   * @returns {string[]} The basename of each of the directory's contents.
   * @throws If relativePath does not exist.
   * @throws if relativePath is not a directory.
   */
  readdirSync(relativePath) {
    // TODO: Use stats rather than _findByRelativePath to reduce scanning.
    const normalizedPath = shared.normalizeRelativePath(relativePath);
    const result = this._findByRelativePath(normalizedPath);

    if (!result.entry) {
      throw new Error(`ENOENT: no such file or directory, scandir '${relativePath}'`);
    }

    if (result.entry.isFile()) {
      throw new Error(`ENOTDIR: not a directory, scandir '${relativePath}'`);
    }

    const entries = this._getEntriesForDirectory(normalizedPath);

    // _getEntriesForDirectory returns entries which are already relative to
    // the requested directory, so no additional processing needs done.
    return entries.map(entry => entry.relativePath);
  },

  /** Run tasks which must be executed once per build.
   *
   * This should be called exactly once per build cycle, e.g. from
   * broccoli-builder.  Notably, it should **not** be called each time the
   * owning plugin is built, as that will cause duplicate rereads when a plugin
   * is used as the input for multiple others.
   *
   * @param {string} newRoot The directory to reread; will become the tree's root.
   */
  reread(newRoot) {
    this._reread(newRoot);
  },

  /** Get the filesystem stats for the specified path.
   *
   * Note that stats typically come from the tree's internal representation of
   * filesystem state and so will contain only the subset of stats tracked by
   * the tree.
   *
   * @param {string} relativePath The path to query.
   * @returns {helpers.Stats} The stats for the specified path.
   * @throws If the specified path does not exist.
   */
  statSync(relativePath) {
    const normalizedPath = shared.normalizeRelativePath(relativePath);
    const result = this._findByRelativePath(normalizedPath);

    if (!result.entry) {
      throw new Error(`ENOENT: no such file or directory, stat '${relativePath}'`);
    }

    if (result.entry === Entry.ROOT) {
      return result.tree._getRootStat();
    }

    return new shared.Stats(result.entry.size, new Date(result.entry.mtime), result.entry.mode);
  },
});

// ========================================================================= //
// Delegator
// ========================================================================= //

/** A FacadeTree which delegates all of its methods to another.
 *
 * This is used by WritableTrees (via prototype switching) when linking the
 * root of the tree to another.
*/
function Delegator(options) {
  if (this.constructor === Delegator) {
    throw new TypeError('Delegators cannot be instantiated.');
  }

  this._delegate = options.delegate;
  this._delegate._children.add(this);
}

Delegator.prototype = Object.create(FacadeTree.prototype);

Object.defineProperties(Delegator.prototype, {
  /** The tree to which this one deletates. */
  delegate: {
    get() {
      return this._delegate;
    },
  },

  /** {@see FacadeTree#entries} */
  entries: {
    get() {
      return this._delegate.entries;
    },
  },

  /** {@see FacadeTree#paths} */
  paths: {
    get() {
      return this._delegate.paths;
    },
  },

  /** {@see FacadeTree#root} */
  root: {
    get() {
      return this._delegate.root;
    },
  },
});

Object.assign(Delegator.prototype, {
  /** {@see FacadeTree#_findByRelativePath} */
  _findByRelativePath(normalizedPath) {
    return this._delegate._findByRelativePath(normalizedPath);
  },

  /** {@see FacadeTree#_getEntriesForDirectory} */
  _getEntriesForDirectory(normalizedPath) {
    return this._delegate._getEntriesForDirectory(normalizedPath);
  },

  /** {@see FacadeTree#_getRootStat} */
  _getRootStat() {
    return this._delegate._getRootStat();
  },

  /** {@see FacadeTree#changes} */
  changes() {
    return this._delegate.changes();
  },

  /** Does nothing.
   *
   * Direct calls to the public reread method are discarded by Delegators, as
   * the trees to which they delegate will have already had their reread
   * methods called, and rereads must not be triggered twice during the same
   * build cycle.
   *
   * Note that the *private* _reread method is *not* overridden, so that the
   * normal reread operations take place when the delegate's public reread
   * method is called.
   */
  reread() {},

  /** {@see WritableTree#start} */
  start() {
    WritableTree.prototype.start.call(this);
  },

  /** {@see WritableTree#stop} */
  stop() {
    WritableTree.prototype.stop.call(this);
  },

  /** {@see FacadeTree#existsSync} */
  existsSync(relativePath) {
    return this._delegate.existsSync(relativePath);
  },

  /** Removes the root symlink which created this Delegator.
   *
   * Delegators are created from WritableTrees when their root is symlinked to
   * another tree.  This method undoes that root symlink, causing the tree to
   * become a normal WritableTree again.
   */
  undoRootSymlinkSync() {
    WritableTree.prototype._throwOnCommonErrors.call(this, 'undoRootSymlink');

    logger.info(`Converting delegator back into writable tree rooted at '${this._root}'.`);

    // Create changes representing movement from the delegate's prior build to an empty tree.
    const delegateEntriesTree = ManualTree.fromEntries(this._delegate.entries);
    const emptyTree = ManualTree.fromEntries([]);
    const changes = this._delegate.changes().concat(delegateEntriesTree.calculatePatch(emptyTree));

    // Remove delegation links.
    this._delegate._children.delete(this);
    this._delegate = undefined;

    // Restore prototype.
    Object.setPrototypeOf(this, WritableTree.prototype);

    const changesLength = changes.length;

    // This ensures that the deduplication logic from `_track` is applied.
    for (let i = 0; i < changesLength; i++) {
      const change = changes[i];

      this._track(change[0], change[2]);
    }

    // Recreate root directory.
    fs.unlinkSync(this._root);
    fs.mkdirSync(this._root);
  },
});

// ========================================================================= //
// Projection
// ========================================================================= //

/** Determine how many ancestor directories a path contains.
 *
 * For example, 'foo' has a directory depth of 0 (no ancestors), while
 * 'foo/bar/baz.js' has a directory depth of 2.
 *
 * This function is used to determine which entries can be discarded from a
 * directory stack when moving back up the directory tree.
 *
 * @param {string} normalizedPath The normalized path to check.
 * @returns {number} The directory depth of the provided path.
 */
function calculateDirectoryDepth(normalizedPath) {
  return normalizedPath.split(path.sep).length - 1;
}

/** Determines whether a path matches the specified filters.
 *
 * Each type of filter has its own rules:
 *
 * * If cwd is non-empty, the path must be contained within it in order to match.
 * * If files is an array, it must contain the path in order to match.
 * * A path which matches, or has any ancestor which matches, any of the matchers in the exlude array does not match.
 * * A path which matches any of the matchers in the include array matches.
 *
 * Any path which is neither qualified nor disqualified by the above rules is
 * considered to match.
 *
 * @param {string} normalizedPath The normalized path to check.
 * @param {string} cwd A directory which must contain the provided path.
 * @param {null|string[]} files If present, an array which must contain the provided path.
 * @param {(Function|Minimatch|RegExp)[]} include An array of matchers which cause the path to match.
 * @param {(Function|Minimatch|RegExp)[]} exclude An array of matchers which cause the path to not match.
 */
function filterMatches(normalizedPath, cwd, files, include, exclude) {
  // exclude if outside of cwd
  if (!shared.startsWith(normalizedPath, shared.ensureSeparator(cwd)) || cwd === normalizedPath) {
    return false;
  }

  // Can't happen: this is checked in the setters.
  if (files && (include.length || exclude.length)) {
    throw new TypeError('Cannot pass files option and an include/exlude filter.  You can only have one or the other');
  }

  if (cwd) {
    normalizedPath = normalizedPath.substring(shared.ensureSeparator(cwd).length);
  }

  // include only if it matches an entry in files
  if (files) {
    return files.indexOf(normalizedPath) > -1;
  }

  if (shouldExcludeDirectory(normalizedPath, exclude)) {
    return false;
  }

  if (include.length > 0) {
    // exclude unless matched by something in includes
    if (include.every(matcher => !match(normalizedPath, matcher))) {
      return false;
    }
  }

  return true;
}

/** Determine whether a path matches the specified matcher.
 *
 * This is a convenience method which abstracts out the APIs of different types
 * of matcher.
 *
 * A matcher is one of:
 *
 * * A function which, when passed the path as its sole argument, returns
 *   truthy or falsy to indicate a pass or fail, respectively.
 * * A Minimatch, where the the path is passed to its match method to determine
 *   pass or fail.
 * * A RegExp, where the path is passed to its test method to determine pass or
 *   fail.
 *
 * @param {string} normalizedPath The normalized path to check.
 * @param {Function|Minimatch|RegExp} matcher The match to check against.
 * @returns {boolean} True if the path matches the matcher; false, otherwise.
 */
function match(normalizedPath, matcher) {
  // TODO: Duck typing?
  if (matcher instanceof RegExp) {
    return matcher.test(normalizedPath);
  } else if (matcher instanceof Minimatch) {
    return matcher.match(normalizedPath);
  } else if (typeof matcher === 'function') {
    return matcher(normalizedPath);
  }

  // Can't happen: this is checked in #_setFilter.
  throw new TypeError(`Matcher must be a RegExp, string, or function.  Got '${matcher}'.`);
}

/** Determines whether it is possible for a path's descendants to match the specified filter.
 *
 * In many cases, it is possible for non-matching directories to contain
 * matching files.  (For example, 'foo' doesn't match '**​/*.js', but it could
 * contain 'foo/bar.js', which does.)  When all supplied include matchers are
 * Minimatches (globs), it is possible to partially apply those matchers to
 * directory paths in order to determine whether they can potentially contain
 * matching files.  (Or, more significantly, whether they cannot.)
 *
 * This function returns `false` iff it can be determined that the supplied
 * path cannot possibly contain any matching paths (at any level of descent).
 *
 * @param {string} normalizedPath The normalized path to check.
 * @param {(Function|Minimatch|RegExp)[]} include An array of matchers to check against.
 * @returns {boolean} False iff the supplied path cannot possibly contain matching files; true, otherwise.
 * @see https://github.com/stefanpenner/matcher-collection/blob/v1.0.4/index.js#L23
 */
function mayContain(normalizedPath, include) {
  if (include.length && include.every(matcher => matcher instanceof Minimatch)) {
    const parts = normalizedPath.split(path.sep);
    const includeLength = include.length;

    for (let i = 0; i < includeLength; i++) {
      const matcher = include[i];
      const setLength = matcher.set.length;

      for (let j = 0; j < setLength; j++) {
        const part = matcher.set[j];

        if (matcher.matchOne(parts, part, true)) {
          return true;
        }
      }
    }

    return false;
  }

  return true;
}

/** Determine whether a directory should be excluded.
 *
 * When a directory matches any exclude matcher, its entire subtree (the
 * directory and all of its contents) are excluded.
 *
 * @param {string} normalizedPath The normalized path to check.
 * @param {(Function|Minimatch|RegExp)[]} exclude An array of matchers to check against.
 * @returns {boolean} True if the directory should be excluced; false, otherwise.
 */
function shouldExcludeDirectory(normalizedPath, exclude) {
  if (exclude.length > 0) {
    // exclude if any ancestor directory matches anything in exclude
    let currentDir = shared.dirname(normalizedPath);

    while (currentDir !== '') {
      if (exclude.some(matcher => match(currentDir, matcher))) {
        return true;
      }

      currentDir = shared.dirname(currentDir);
    }

    // exclude if matched by anything in exclude
    if (exclude.some(matcher => match(normalizedPath, matcher))) {
      return true;
    }
  }

  return false;
}

/** A tree which is a filtered view into another.
 *
 * Projections support filtering by narrowing another tree down to a subtree
 * (the contents of a specific directory), an explicit set of matching files
 * and their ancestor directories, or by whitelist/blacklist.
 *
 * The 'files' filter (explicit file list) is incompatible with the 'include'
 * and 'exclude' filters (whitelist and blacklist, respectively), but all other
 * combinations of filters are valid.
 */
/** Create a projection.
 *
 * @param {Object} options The options used when initializing the projection.
 * @param {FacadeTree} options.parent The parent tree, of which this projection is a view.
 * @param {string} [options.cwd] If provided, the directory in which this view is rooted.
 * @param {?string[]} [options.files] If not null, an array of paths which are explicity present.
 * @param {(string|Function|RegExp)[]} include If not empty, paths must match at least one matcher in order to be seen.
 * @param {(string|Function|RegExp)[]} exclude Paths must not match any matchers in order to be seen.
 */
function Projection(options) {
  if (!(options.parent instanceof FacadeTree)) {
    throw new TypeError(`Expected parent to be a FacadeTree, not '${options && options.parent}'.`);
  }

  FacadeTree.call(this, options);

  this._parent = options.parent;
  this._parent._children.add(this);

  // Set the filters.  Most of these setters have side effects.
  this.cwd = options.cwd;
  this.files = options.files;
  this.include = options.include;
  this.exclude = options.exclude;
}

Projection.prototype = Object.create(FacadeTree.prototype);
Projection.prototype.constructor = Projection;

Object.defineProperties(Projection.prototype, {
  cwd: {
    /** Get the directory in which this projection is rooted.
     *
     * @returns {string} The current working directory.
     */
    get() {
      return this._cwd;
    },

    /** Set the directory in which this projection is rooted.
     *
     * If empty or falsy, the projection will be rooted in the parent's root
     * directory.
     *
     * @param {?string} value The new current working directory.
     */
    set(value) {
      this._cwd = shared.normalizeRelativePath(value || '');
    },
  },


  entries: {
    /** {@see FacadeTree#entries}
     *
     * This accessor works by iterating over viewable, matching entries from its
     * parent rather than simply filtering its parent's full set of entries.
     * This allows projections of SourceTrees to omit scanning of directories
     * which are known to not contain matching files.
     *
     * @returns {Entry[]} All matching entries from this projection's parent.
     */
    get() {
      if (this._entriesFromFiles) {
        return Array.from(this._entriesFromFiles, entry => Entry.clone(entry));
      }

      // Can't simply filter _parent.entries, as that would cause source trees to
      // scan directories that don't match the projection's filters.

      let directoryStack = [];
      let directoryDepth = 0;
      const filteredEntries = [];

      const filterEntries = (normalizedPath) => {
        const entries = this._parent._getEntriesForDirectory(normalizedPath).map(entry => {
          // Entry paths are relative to the requested directory; change them to
          // be relative to root.
          return Entry.clone(entry, shared.joinPaths(normalizedPath, entry.relativePath));
        });

        const entriesLength = entries.length;

        for (let i = 0; i < entriesLength; i++) {
          const entry = entries[i];

          if (entry.isDirectory() && this._shouldExcludeDirectory(entry.relativePath)) {
            // If the directory is explicitly excluded, just skip it entirely.
            continue;
          }

          if (this._filterMatches(entry.relativePath)) {
            const directoryStackLength = directoryStack.length;

            for (let j = 0; j < directoryStackLength; j++) {
              const directory = directoryStack[j];

              if (shared.startsWith(entry.relativePath, shared.ensureSeparator(directory.relativePath))) {
                filteredEntries.push(directory);
              }
            };

            directoryStack = [];
            directoryDepth = 0;

            filteredEntries.push(entry);
            // TODO: Leverage mayContain?
          } else if (entry.isDirectory()) {
            // Track non-matching directories in case they contain matching files.

            const newDirectoryDepth = calculateDirectoryDepth(entry.relativePath);

            while (directoryStack.length && directoryDepth >= newDirectoryDepth) {
              directoryStack.pop();
              directoryDepth--;
            }

            directoryStack.push(entry);
            directoryDepth = newDirectoryDepth;
          }

          if (entry.isDirectory()) {
            const pathWithoutCwd = entry.relativePath.substring(shared.ensureSeparator(this.cwd).length);

            if (mayContain(pathWithoutCwd, this._processedInclude)) {
              filterEntries(entry.relativePath);
            }
          }
        }
      }

      filterEntries(this._cwd);

      return filteredEntries.map(entry => {
        return Entry.clone(entry, entry.relativePath.substring(shared.ensureSeparator(this._cwd).length));
      }).sort(shared.compareEntries);
    },
  },

  exclude: {
    /** Get the blacklist matchers.
     *
     * @returns {(string|Function|RegExp)[]} An array of matchers.
     */
    get() {
      return this._exclude;
    },

    /** Set the blacklist matchers.
     *
     * Any path matching any blacklisted matcher will be excluded from the view
     * (including any contents, if that path is a directory).
     *
     * @param {(string|Function|RegExp)[]} value An array of matchers.
     */
    set(value) {
      this._setFilter('exclude', value);
    },
  },

  files: {
    /** Get the list of explicit paths.
     *
     * @returns {?string[]} An array of paths.
     */
    get() {
      return this._files;
    },

    /** Set the list of explicit paths.
     *
     * If non-null, only the paths contained in this array (and their ancestor
     * directories) are considered to exist.  An empty array results in an empty
     * tree!
     */
    set(value) {
      const newValue = value === undefined ? null : value;
      const oldValue = this._files;

      if (newValue !== null && !Array.isArray(newValue)) {
        throw new Error(`files must be null or an array, got ${value}`);
      }

      if (newValue === oldValue || newValue && oldValue && newValue.length === oldValue.length && newValue.every((v, i) => v === oldValue[i])) {
        // No change.
        return;
      }

      if (newValue && (this._exclude && this._exclude.length) || (this._include && this._include.length)) {
        throw new TypeError('The "files" filter is incompatible with the "include" and "exclude" filters.');
      }

      this._files = newValue;

      if (newValue) {
        this._processedFiles = newValue.map(path_ => shared.normalizeRelativePath(path_));
        this._entriesFromFiles = this._processedFiles.map(path_ => Entry.fromPath(path_));

        shared.sortAndExpand(this._entriesFromFiles);
      } else {
        this._processedFiles = undefined;
        this._entriesFromFiles = undefined;
      }
    },
  },

  include: {
    /** Get the whitelist matchers.
     *
     * @returns {(string|Function|RegExp)[]} An array of matchers.
     */
    get() {
      return this._include;
    },

    /** Set the whitelist matchers.
     *
     * A path must match at least one whitelisted matcher (if any) to be included
     * in the view.
     *
     * @param {(string|Function|RegExp)[]} value An array of matchers.
     */
    set(value) {
      this._setFilter('include', value);
    },
  },

  root: {
    /** {@see FacadeTree#root} */
    get() {
      return shared.joinPaths(this._parent.root, this._cwd);
    },
  },
});

Object.assign(Projection.prototype, {
  /** Actions performed when a projection is no longer needed.
   *
   * Significantly, this removes the projection from its parent's child
   * tracking so that it can be garbage collected.
   *
   * @private
   */
  _cleanup() {
    this._parent._children.delete(this);
  },

  /** Determines whether a path matches this projection's filters.
   *
   * @param {string} normalizedPath The normalized path to check.
   * @returns {boolean} True if the path matches; false, otherwise.
   */
  _filterMatches(normalizedPath) {
    const exclude = this._processedExclude || [];
    const files = this._processedFiles || null;
    const include = this._processedInclude || [];

    return filterMatches(normalizedPath, this._cwd, files, include, exclude);
  },

  /** {@see FacadeTree#_findByRelativePath} */
  _findByRelativePath(normalizedPath) {
    if (this._entriesFromFiles) {
      return this._findInArrayByRelativePath(this._entriesFromFiles, normalizedPath);
    }

    if (shouldExcludeDirectory(normalizedPath, this._processedExclude)) {
      return { entry: null, tree: null };
    }

    // Note that the CWD is included in the full path.
    const fullNormalizedPath = shared.joinPaths(this._cwd, normalizedPath);
    const parentResult = this._parent._findByRelativePath(fullNormalizedPath);
    const parentEntry = parentResult.entry;

    if (parentEntry) {
      if (fullNormalizedPath === this._cwd || this._filterMatches(fullNormalizedPath)) {
        return parentResult;
      }

      const parentEntryRelativePath = this._cwd ? parentEntry.relativePath.substring(this._cwd.length + 1) : parentEntry.relativePath;

      if (parentEntry.isDirectory() && mayContain(parentEntryRelativePath, this._processedInclude)) {
        return parentResult;
      }
    }

    return { entry: null, tree: null };
  },

  /** {@see FacadeTree#_getEntriesForDirectory} */
  _getEntriesForDirectory(normalizedPath) {
    if (this._entriesFromFiles) {
      return this._getEntriesFromArrayForDirectory(this._entriesFromFiles, normalizedPath);
    }

    const parentEntries = this._parent._getEntriesForDirectory(shared.joinPaths(this._cwd, normalizedPath));

    return parentEntries.filter(entry => {
      if (this._filterMatches(shared.joinPaths(this._cwd, normalizedPath, entry.relativePath))) {
        return true;
      }

      if (entry.isDirectory() && mayContain(shared.joinPaths(normalizedPath, entry.relativePath), this._processedInclude)) {
        return true;
      }

      return false;
    });
  },

  /** {@see FacadeTree#_getRootStat} */
  _getRootStat() {
    return this._parent.statSync(this.cwd);
  },

  /** {@see FacadeTree#_reread}
   *
   * Notably, this caches a copy of the current entries, which is used to
   * calculate the changes which occurred since this reread.
   */
  _reread() {
    this._previousEntries = Array.from(this.entries, entry => Entry.clone(entry));

    FacadeTree.prototype._reread.call(this);
  },

  /** Set the whitelist or blacklist.
   *
   * This is an abstracted method for setting matcher-based filters.
   *
   * @param {string} filter The filter to set.
   * @param {(string|Function|RegExp)[]} value An array of matchers.
   */
  _setFilter(filter, value) {
    const newValue = value || [];
    const oldValue = this[`_${filter}`];

    if (!Array.isArray(newValue)) {
      throw new Error(`${filter} must be an array, got ${value}`);
    }

    // TODO: Should we duck-type instead?  See also `match`.
    newValue.forEach(matcher => {
      if (typeof matcher === 'function') {
        return;
      }

      if (typeof matcher === 'string') {
        return;
      }

      if (matcher instanceof RegExp) {
        return;
      }

      throw new TypeError(`Matcher must be a RegExp, string, or function.  Got '${matcher}'.`);
    });

    if (newValue === oldValue || newValue && oldValue && newValue.length === oldValue.length && newValue.every((v, i) => v === oldValue[i])) {
      // No change.
      return;
    }

    if (newValue.length && this._files) {
      throw new TypeError(`The "${filter}" filter is incompatible with the "files" filter.`);
    }

    this[`_${filter}`] = newValue;
    this[`_processed${filter.replace(/\w/, c => c.toUpperCase())}`] = newValue.map(matcher => {
      if (typeof matcher === 'string') {
        return new Minimatch(matcher);
      }

      return matcher;
    });
  },

  /** Determine whether a directory should be excluded.
   *
   * @param {string} normalizedPath The normalized path to check.
   * @returns {boolean} True if the directory and its descendants should be excluded.
   */
  _shouldExcludeDirectory(normalizedPath) {
    const exclude = this._processedExclude || [];

    return shouldExcludeDirectory(normalizedPath.substring(shared.ensureSeparator(this._cwd).length), exclude);
  },

  /** {@see FacadeTree#changes}
   *
   * This method calculates the changes between the snapshot taken during the
   * last reread and the current state of the tree.
   */
  changes() {
    // Can't simply filter _parent.changes, as that would cause source trees to
    // scan directories that don't match the projection's filters.

    return ManualTree.fromEntries(this._previousEntries || []).calculatePatch(this);
  },
});

// ========================================================================= //
// SourceTree
// ========================================================================= //

/** A tree which scans a directory on disk.
 *
 * SourceTrees minimize I/O by only scanning directories as they are accessed
 * and caching the result.  The cache is then emptied during reread.
 */
/** Create a SourceTree.
 *
 * @param {Object} options The options used when initializing the tree.
 * @param {string} options.root The path to the directory scanned by this tree.
 */
function SourceTree(options_) {
  const options = options_ || {};

  FacadeTree.call(this, options);

  this._entries = [];
  this._root = shared.normalizeRoot(options.root);
  this._scannedDirectories = new Set();
}

SourceTree.prototype = Object.create(FacadeTree.prototype);
SourceTree.prototype.constructor = SourceTree;

Object.defineProperties(SourceTree.prototype, {
  entries: {
    /** {@see FacadeTree#entries} */
    get() {
      this._ensureSubtreeScanned('');

      return Array.from(this._entries, entry => Entry.clone(entry));
    },
  },
});

Object.assign(SourceTree.prototype, {
  /** Ensure that a directory has been scanned.
   *
   * This method scans only a single level of the directory tree.  For
   * convenience ({@see SourceTree#_ensureSubtreeScanned},
   * {@see SourceTree#_getEntriesForDirectory}), the scanned entries are
   * returned when scanning occurs.
   *
   * @param {string} normalizedPath The relative path to the directory to be scanned.
   * @returns {?Entry[]} Iff the directory has not been previously scanned, the newly-found entries; undefined, otherwise.
   * @see SourceTree#_scanEntriesForDirectory
   */
  _ensureDirectoryScanned(normalizedPath) {
    if (this._scannedDirectories.has(normalizedPath)) {
      return;
    }

    const entries = this._scanEntriesForDirectory(normalizedPath);

    this._entries = shared.mergeEntries(this._entries, entries, true);
    this._scannedDirectories.add(normalizedPath);

    return entries;
  },

  /** Ensures that a subtree has been scanned.
   *
   * This method scans the specified directory, then recursively scans each
   * directory it contains.
   *
   * @param {string} normalizedPath The relative path to the subtree to be scanned.
   */
  _ensureSubtreeScanned(normalizedPath) {
    let entries;

    if (this._scannedDirectories.has(normalizedPath)) {
      // This is very similar to super._getEntriesForDirectory, but doesn't
      // mess around with the entries' relativePaths.

      let index = shared.searchByRelativePath(this._entries, normalizedPath);

      if (index === -1) {
        entries = [];
      } else {
        const normalizedPathWithSeparator = shared.ensureSeparator(normalizedPath);
        let entry = this._entries[++index];

        // The directory's entry may not be immediately followed by its contents.
        while (!shared.startsWith(entry.relativePath, normalizedPathWithSeparator)) {
          index++;
          entry = this._entries[index];

          if (!entry) {
            // Ran off the end of the array.
            break;
          }
        }

        entries = [];

        while (shared.startsWith(entry.relativePath, normalizedPathWithSeparator)) {
          if (entry.relativePath.substring(normalizedPathWithSeparator.length).indexOf('/') === -1) {
            entries.push(entry);
          }

          index++;
          entry = this._entries[index];

          if (!entry) {
            // Ran off the end of the array.
            break;
          }
        }
      }
    } else {
      entries = this._ensureDirectoryScanned(normalizedPath);
    }

    const entriesLength = entries.length;

    for (let i = 0; i < entriesLength; i++) {
      const entry = entries[i];

      if (entry.isDirectory()) {
        this._ensureSubtreeScanned(entry.relativePath);
      }
    }
  },

  /** {@see FacadeTree#_findByRelativePath} */
  _findByRelativePath(normalizedPath) {
    if (normalizedPath !== '') {
      this._ensureDirectoryScanned(shared.dirname(normalizedPath));
    }

    return FacadeTree.prototype._findByRelativePath.call(this, normalizedPath);
  },

  /** {@see FacadeTree#_getEntriesForDirectory}
   *
   * Uses the entries produced during scanning, if available.
   */
  _getEntriesForDirectory(normalizedPath) {
    const entries = this._ensureDirectoryScanned(normalizedPath);

    if (entries) {
      return entries.map(entry => {
        // Entry paths must be relative to the requested directory.
        return Entry.clone(entry, entry.relativePath.substring(shared.ensureSeparator(normalizedPath).length));
      });
    }

    // #_ensureDirectoryScanned returns nothing if the directory has already
    // been scanned.
    return FacadeTree.prototype._getEntriesForDirectory.call(this, normalizedPath);
  },

  /** {@see FacadeTree#_reread} */
  _reread(newRoot) {
    if (newRoot !== undefined) {
      this._root = shared.normalizeRoot(newRoot);
    }

    // Stash current entries so we can calculate a diff.
    this._previousEntries = Array.from(this._entries, entry => Entry.clone(entry));

    // Allow children to grab a copy of their entries before we clear them.
    FacadeTree.prototype._reread.call(this);

    // Don't eagerly read, but invalidate our current entries and scanning.
    this._entries = [];
    this._scannedDirectories.clear();
  },

  /** Construct entries for the contents of a directory.
   *
   * If the directory cannot be read because it doesn't exist (ENOENT), an
   * empty array is returned, as though the directory existed but was empty.
   * This case covers projections whose working directory has been deleted from
   * the disk.
   *
   * @param {string} normalizedPath The normalized path to the directory to scan.
   * @returns {Entry[]} Entries corresponding to the directory's contents.
   */
  _scanEntriesForDirectory(normalizedPath) {
    const names = this._scanEntriesForDirectoryReaddirSync(shared.joinPaths(this._root, normalizedPath));

    // Directory could not be read.
    if (!names) {
      // This can occur, for example, when a projection's CWD no longer
      // exists in its parent or when attempting to readdirSync a non-
      // existent directory.
      logger.info(`Cannot scan missing directory '${normalizedPath}'.`)

      return [];
    }

    const entries = [];

    names.forEach(name => {
      const relativePath = shared.joinPaths(normalizedPath, name);
      const stats = fs.statSync(shared.joinPaths(this.root, relativePath));

      // Indicates a broken symlink; skip it.
      if (stats.mode === undefined) {
        return;
      }

      const entry = new Entry(relativePath, stats.size, stats.mtime, stats.mode);

      entries.push(entry);
    });

    return entries;
  },

  /** Read the contents of a directory.
   *
   * This is separated from _scanEntiresForDirectory for performance reasons;
   * CrankShaft can't optimize functions containing try/catch blocks.
   *
   * ENOENT errors are swallowed, and return `undefined`.
   *
   * @param {string} absolutePath The absolute path on disk to be read.
   * @returns {string[]=} The response from readdirSync, if any; otherwise, undefined.
   * @throws {Exception} Re-throws any exception raised by readdirSync, except ENOENT.
   */
  _scanEntriesForDirectoryReaddirSync(absolutePath) {
    try {
      return fs.readdirSync(absolutePath);
    } catch (ex) {
      if (/^ENOENT\b/.test(ex.message)) {
        return;
      }

      throw ex;
    }
  },

  /** {@see FacadeTree#changes}
   *
   * Scans the entire tree.  To reduce scanning, either use a Projection or
   * walk it yourself (see FSTreeMerge for an example of this).
   */
  changes() {
    return ManualTree.fromEntries(this._previousEntries || []).calculatePatch(this);
  },

  /** {@see FacadeTree#existsSync} */
  existsSync(relativePath) {
    const normalizedPath = shared.normalizeRelativePath(relativePath);

    // If the parent directory has not yet been scanned, go to the filesystem.
    // TODO: Possible alternative: use the super implementation, allowing
    // _findByRelativePath to scan the parent directory (more short-term I/O,
    // but potentially less long-term I/O).
    if (normalizedPath !== '' && !this._scannedDirectories.has(shared.dirname(normalizedPath))) {
      return fs.existsSync(this._resolvePath(normalizedPath));
    }

    return FacadeTree.prototype.existsSync.call(this, relativePath);
  },
});

// ========================================================================= //
// WritableTree
// ========================================================================= //
/** A tree which can write to, and controls the contents of, a directory.
 *
 * WritableTrees "own" a directory on disk, tracking the entirety of its
 * contents, by knowing that the directory is empty when the tree is created
 * (though this is not verified, to reduce I/O) and having itself performed
 * every write operation to that directory's contents.
 *
 * Write operations may only be performed while the tree is "started".
 */
/** Create a WritableTree.
 *
 * @param {Object} options The options used when initializing the tree.
 * @param {string} options.root The path to the directory managed by this tree.
 */
function WritableTree(options_) {
  const options = options_ || {};

  FacadeTree.call(this, options);

  this._entries = [];
  this._root = shared.normalizeRoot(options.root);

  this.stop();
}

WritableTree.prototype = Object.create(FacadeTree.prototype);
WritableTree.prototype.constructor = WritableTree;

Object.defineProperties(WritableTree, {
  /** A status value indicating the tree can be written to. */
  STARTED: {
    value: 'started',
  },

  /** A status value indicating the tree is read-only. */
  STOPPED: {
    value: 'stopped',
  },
});

Object.defineProperties(WritableTree.prototype, {
  entries: {
    /** {@see FacadeTree#entries} */
    get() {
      let combinedEntries = [];

      this._entries.forEach(entry => {
        combinedEntries.push(entry);

        if (entry.isSymbolicLink() && entry.isDirectory()) {
          combinedEntries = combinedEntries.concat(entry._symlink.tree.entries.map(linkedEntry => {
            return Entry.clone(linkedEntry, shared.joinPaths(entry.relativePath, linkedEntry.relativePath));
          }));
        }
      });

      return combinedEntries.map(entry => Entry.clone(entry)).sort(shared.compareEntries);
    },
  },

  state: {
    /** The tree's state, indicating whether it can be written to.
     *
     * @returns {string} `WritableTree~STARTED` if writable; `WritableTree~STOPPED` otherwise.
     */
    get() {
      return this._state;
    },
  },
});

Object.assign(WritableTree.prototype, {
  /** {@see FacadeTree#_findByRelativePath} */
  _findByRelativePath(normalizedPath, options) {
    if (normalizedPath === '') {
      return { entry: Entry.ROOT, tree: this };
    }

    const resolveSymlinks = options && options.resolveSymlinks !== undefined ? options.resolveSymlinks : true;
    let index = shared.searchByRelativePath(this._entries, normalizedPath, true);

    // No match at all.
    if (index === -1) {
      return { entry: null, tree: null };
    }

    let entry = this._entries[index];

    // Exact match.
    if (entry.relativePath === normalizedPath) {
      if (resolveSymlinks && entry.isSymbolicLink() && !entry._symlink.external) {
        return entry._symlink;
      }

      return { entry, tree: this };
    }

    while (index !== -1 && !shared.startsWith(normalizedPath, entry.relativePath)) {
      entry = this._entries[--index];
    }

    // This occurs when entries lie between where a symlink would be and where
    // its target would be, but the symlink doesn't actually exist.
    if (index === -1) {
      return { entry: null, tree: null };
    }

    // No exact match, but the returned index potentially points to a symlink
    // which may contain the target.
    if (entry.isSymbolicLink() && entry.isDirectory()) {
      const relativePathWithSeparator = shared.ensureSeparator(entry.relativePath);

      // If the found entry is a symlink which prefixes the target, ask the symlinked tree.
      if (shared.startsWith(normalizedPath, relativePathWithSeparator)) {
        return entry._symlink.tree._findByRelativePath(normalizedPath.substring(relativePathWithSeparator.length), options);
      }
    }

    // Preceeding entry either wasn't a directory symlink or didn't prefix the
    // target.
    return { entry: null, tree: null };
  },

  /** {@see FacadeTree#_getEntriesForDirectory} */
  _getEntriesForDirectory(normalizedPath) {
    // No need to do anything fancy for the root directory.
    if (normalizedPath === '') {
      return FacadeTree.prototype._getEntriesForDirectory.call(this, '');
    }

    let index = shared.searchByRelativePath(this._entries, normalizedPath, true);

    // No match at all (target would be before `this._entries[0]`).
    if (index === -1) {
      return [];
    }

    let entry = this._entries[index];

    // Exact match.
    if (entry.relativePath === normalizedPath) {
      if (entry.isDirectory()) {
        if (entry.isSymbolicLink()) {
          // The directory is a link; defer to target tree.
          return entry._symlink.tree._getEntriesForDirectory('');
        }

        // Normal directory; use super implementation.
        return FacadeTree.prototype._getEntriesForDirectory.call(this, normalizedPath);
      }

      throw new Error(`ENOTDIR: not a directory, scandir '${normalizedPath}'`);
    }

    while (index !== -1 && !shared.startsWith(normalizedPath, entry.relativePath)) {
      entry = this._entries[--index];
    }

    // This occurs when entries lie between where a symlink would be and where
    // its target would be, but the symlink doesn't actually exist.
    if (index === -1) {
      return [];
    }

    // No exact match, but the returned index potentially points to a symlink
    // which may contain the target.
    if (entry.isSymbolicLink() && entry.isDirectory()) {
      const relativePathWithSeparator = shared.ensureSeparator(entry.relativePath);

      if (shared.startsWith(normalizedPath, relativePathWithSeparator)) {
        // Path crosses a symlink; defer to the target tree.
        return entry._symlink.tree._getEntriesForDirectory(normalizedPath.substring(relativePathWithSeparator.length));
      }
    }

    return [];
  },

  /** Insert an entry into the tree's entries array.
   *
   * If an entry with the same path already exists, it is replaced.
   *
   * @private
   * @param {Entry} entry The entry to insert.
   */
  _insertEntry(entry) {
    const index = shared.searchByRelativePath(this._entries, entry.relativePath, true);

    if (index === -1) {
      this._entries.unshift(entry);
    } else if (this._entries[index].relativePath === entry.relativePath) {
      this._entries[index] = entry;
    } else {
      this._entries.splice(index + 1, 0, entry);
    }
  },

  /** Remove an entry from the tree's entries array.
   *
   * If an entry with the same path as the supplied entry is present, it is
   * removed.  If no matching entry is found, no action is taken.
   *
   * @private
   * @param {Entry} entry The entry to remove.
   */
  // FIXME: Pass only path instead of entry, as we ignore the rest, anyway.
  _removeEntry(entry) {
    if (!entry) {
      throw new TypeError('No entry provided for removal.');
    }

    if (entry === Entry.ROOT) {
      throw new TypeError('Cannot remove a "root" entry.');
    }

    const index = shared.searchByRelativePath(this._entries, entry.relativePath);

    if (index !== -1) {
      this._entries.splice(index, 1);
    }
  },

  /** {@see FacadeTree#_reread} */
  _reread(newRoot) {
    if (newRoot !== undefined) {
      const resolvedRoot = shared.normalizeRoot(newRoot);

      if (resolvedRoot !== this.root) {
        throw new Error(`Cannot change root from '${this.root}' to '${newRoot}' of a writable tree.`);
      }
    }

    FacadeTree.prototype._reread.call(this);
  },

  /** Check for several problems which may occur during write.
   *
   * There are several problems common to most or all write operations.  This
   * method checks for them and, if appropriate, throws a related exception.
   *
   * Checks for:
   *
   * * writing to a stopped tree
   * * writing to the root of the tree
   * * missing ancestor directories
   * * writing to a path stored in another tree (via symlink)
   *
   * @param {string} operation The write operation being performed, e.g. unlink or mkdir.
   * @param {string=} normalizedPath The path being modified.
   * @param {string=} relativePath The path being modified, as presented to the user.
   * @param {Object=} options Additional options.
   * @param {boolean=false} options.allowRoot Whether modifications to the root should be allowed.
   * @param {boolean=false} options.allowSymlinks Whether the operation can target a symlink.
   */
  _throwOnCommonErrors(operation, normalizedPath, relativePath, options) {
    const allowRoot = options && options.allowRoot;
    const allowSymlinks = options && options.allowSymlinks;

    if (this._state === WritableTree.STOPPED) {
      throw new Error(`Cannot '${operation}' on a stopped tree.`);
    }

    if (normalizedPath !== undefined) {
      if (!allowRoot || normalizedPath !== '') {
        if (normalizedPath === '') {
          throw new Error(`Cannot ${operation} the tree's root.`);
        }

        if (operation !== 'mkdirp') {
          const parentPath = shared.dirname(normalizedPath);

          if (parentPath !== '') {
            const parentIndex = shared.searchByRelativePath(this._entries, parentPath);

            if (parentIndex === -1 || this._entries[parentIndex].isSymbolicLink()) {
              throw new Error(`ENOENT: no such file or directory, ${operation} '${relativePath}'`);
            }
          }
        }
      }

      if (!allowSymlinks) {
        const targetIndex = shared.searchByRelativePath(this._entries, normalizedPath);

        if (targetIndex !== -1 && this._entries[targetIndex].isSymbolicLink()) {
          throw new Error(`Cannot ${operation} a symlink, '${relativePath}'`);
        }
      }
    }
  },

  /** Track a change.
   *
   * Changes for WritableTrees are tracked directly at the time of modification
   * rather than by comparing snapshots.
   *
   * Some pairs of changes are replaced with a single change which produces the
   * same result (e.g. an 'unlink' followed by a 'create' becoming a 'change')
   * or are removed entirely (e.g. a 'mkdir' followed by a 'rmdir').
   *
   * @param {string} operation_ The type of change to track.
   * @param {Entry} entry The new or modified entry being tracked.
   */
  // TODO: Pairing changes to approximate a diff between snapshots is becoming
  // complex; should we give up on real-time tracking and just diff the way
  // Projections and SourceTrees do?
  _track(operation_, entry) {
    let operation = operation_;

    // In order to make the tracked changes look more like the output of a
    // snapshot diff, we simplify them when they would produce the same end
    // result.
    //
    // * unlink … create → (nothing) … change
    // * change … change → (nothing) … change
    // * create … change → (nothing) … create
    // * rmdir  … mkdir  → (nothing) … (nothing)
    // * mkdir  … rmdir  → (nothing) … (nothing)
    // * change … unlink → (nothing) … unlink
    // * create … unlink → (nothing) … (nothing)
    switch (operation_) {
      case 'create':
        // If there was a previous unlink, wipe it out and make a change instead.
        if (this._untrack('unlink', entry.relativePath)) {
          operation = 'change';
        }

        break;

      case 'change':
        // If there was a prior change, wipe it out.
        this._untrack('change', entry.relativePath);

        // If there was a prior create, replace it.
        if (this._untrack('create', entry.relativePath)) {
          operation = 'create';
        }

        break;

      case 'mkdir':
        // If there was a prior rmdir, wipe it out and skip the mkdir.
        if (this._untrack('rmdir', entry.relativePath)) {
          return;
        }

        break;

      case 'rmdir':
        // If there was a prior mkdir, wipe it out and skip the rmdir.
        if (this._untrack('mkdir', entry.relativePath)) {
          return;
        }

        break;

      case 'unlink':
        // If there was a prior change, wipe it out.
        this._untrack('change', entry.relativePath);

        // If there was a prior create, wipe it out and skip the unlink.
        if (this._untrack('create', entry.relativePath)) {
          return;
        }

        break;
    }

    const change = [operation, entry.relativePath, entry, this._lastChange, undefined];

    this._changeHash[operation][entry.relativePath] = change;

    if (this._lastChange) {
      this._lastChange[4] = change;
    }

    this._lastChange = change;

    if (!this._firstChange) {
      this._firstChange = change;
    }
  },

  /** Removes a matching change from tracking.
   *
   * Only removes a single change; by the rules used in _track, multiple
   * matching changes cannot exist.
   *
   * @returns true if a change was removed; false otherwise.
   */
  _untrack(operation, normalizedPath) {
    const change = this._changeHash[operation][normalizedPath];

    if (change) {
      this._changeHash[operation][normalizedPath] = undefined;

      const previous = change[3];
      const next = change[4];

      if (previous) {
        previous[4] = next;
      } else {
        this._firstChange = next;
      }

      if (next) {
        next[3] = previous;
      } else {
        this._lastChange = previous;
      }

      return true;
    }

    return false;
  },

  /** {@see FacadeTree#changes} */
  changes() {
    const traversedSymlinks = new Set();
    let combinedChanges = [];

    let change = this._firstChange;

    while (change) {
      combinedChanges.push([change[0], change[1], change[2]]);

      // Create changes for the contents of symlinked directories.
      if (change[2].isSymbolicLink() && change[2].isDirectory()) {
        const linkedChanges = change[2]._symlink.tree.entries.map(entry => {
          const relativePath = shared.joinPaths(change[1], entry.relativePath);

          return [entry.isDirectory() ? 'mkdir' : 'create', relativePath, Entry.clone(entry, relativePath)];
        });

        combinedChanges = combinedChanges.concat(linkedChanges);
        traversedSymlinks.add(change[1]);
      }

      change = change[4];
    };

    // Collect the changes from any unchanged symlinks.
    const entriesLength = this._entries.length;

    for (let i = 0; i < entriesLength; i++) {
      const entry = this._entries[i];

      if (entry.isSymbolicLink() && entry.isDirectory() && !traversedSymlinks.has(entry.relativePath)) {
        combinedChanges = combinedChanges.concat(entry._symlink.tree.changes().map(change => {
          const relativePath = shared.joinPaths(entry.relativePath, change[1]);

          return [change[0], relativePath, Entry.clone(change[2], relativePath)];
        }));
      }
    };

    // TODO: is this really necessary?  It's pretty slow for large change arrays.
    combinedChanges.sort(shared.compareChanges);

    return combinedChanges;
  },

  /** Recursively empties a directory of any contents.
   *
   * @param {string} relativePath The path to the directory to empty.
   */
  emptySync(relativePath) {
    const normalizedPath = shared.normalizeRelativePath(relativePath);

    this._throwOnCommonErrors('empty', normalizedPath, relativePath, { allowRoot: true });

    const result = this._findByRelativePath(normalizedPath);

    if (!result.entry) {
      throw new Error(`ENOENT: no such file or directory, empty '${relativePath}'`);
    }

    if (result.entry.isFile()) {
      throw new Error(`ENOTDIR: not a directory, empty '${relativePath}'`);
    }

    const normalizedPathWithSeparator = shared.ensureSeparator(normalizedPath);
    let entries;

    if (normalizedPath === '') {
      entries = Array.from(this._entries);
    } else {
      entries = [];

      let index = shared.searchByRelativePath(this._entries, normalizedPath);

      // Increment index to skip the matched entry.
      let entry = this._entries[++index];

      // The directory's entry may not be immediately followed by its contents.
      while (entry && !shared.startsWith(entry.relativePath, normalizedPathWithSeparator)) {
        index++;
        entry = this._entries[index];
      }

      while (entry && shared.startsWith(entry.relativePath, normalizedPathWithSeparator)) {
        entries.push(entry);
        index++;
        entry = this._entries[index];
      }
    }

    entries.reverse().forEach(entry => {
      if (entry.isSymbolicLink() || entry.isFile()) {
        this.unlinkSync(entry.relativePath);
      } else {
        this.rmdirSync(entry.relativePath);
      }
    });
  },

  /** {@see FacadeTree#existsSync} */
  existsSync(relativePath) {
    const normalizedPath = shared.normalizeRelativePath(relativePath);
    const result = this._findByRelativePath(normalizedPath);

    // If it's a symlink that doesn't point to another tree, ask the filesystem.
    if (result.entry && result.entry.isSymbolicLink() && result.entry._symlink.external) {
      return fs.existsSync(result.entry._symlink.external);
    }

    return !!result.entry;
  },

  /** Create a new directory.
   *
   * @param {string} relativePath The path to the new directory.
   * @throws {EEXIST} If the path already exists.
   */
  mkdirSync(relativePath) {
    const normalizedPath = shared.normalizeRelativePath(relativePath);

    this._throwOnCommonErrors('mkdir', normalizedPath, relativePath);

    const result = this._findByRelativePath(normalizedPath);

    if (result.entry) {
      throw new Error(`EEXIST: file already exists, mkdir '${relativePath}'`);
    }

    fs.mkdirSync(this._resolvePath(normalizedPath));

    const entry = new Entry(normalizedPath, undefined, Date.now(), Entry.DIRECTORY_MODE);

    this._track('mkdir', entry);
    this._insertEntry(entry);
  },

  /** Ensure a directory exists, recursively creating it if necessary.
   *
   * @param {string} relativePath The path to create.
   * @throws {EEXIST} If the path already exists and is not a directory.
   */
  mkdirpSync(relativePath) {
    const normalizedPath = shared.normalizeRelativePath(relativePath);

    this._throwOnCommonErrors('mkdirp', normalizedPath, relativePath);

    const result = this._findByRelativePath(normalizedPath);

    if (result.entry) {
      if (result.entry.isDirectory()) {
        logger.info('mkdirpSync %s noop, directory exists', relativePath);

        return;
      } else {
        throw new Error(`EEXIST: file already exists, mkdirp '${relativePath}'`);
      }
    }

    let subpath = '';

    // TODO: Its O(N2) should change it to O(N)
    const tokens = normalizedPath.split(path.sep);
    const tokensLength = tokens.length;

    for (let i = 0; i < tokensLength; i++) {
      const token = tokens[i];

      subpath = shared.joinPaths(subpath, token);

      const entry = this._findByRelativePath(subpath).entry;

      // Let #mkdirSync handle the errors when it already exists.
      if (!entry || entry.isSymbolicLink() || entry.isFile()) {
        this.mkdirSync(subpath);
      }
    }
  },

  /** Read the contents of a file.
   *
   * If an encoding is specified, a string will be returned; otherwise, a
   * Buffer.
   *
   * @param {string} relativePath The path to read.
   * @param {?encoding} encoding The string encoding used by the file.
   * @returns {string|Buffer} The contents of the file.
   */
  readFileSync(relativePath, encoding) {
    const normalizedPath = shared.normalizeRelativePath(relativePath);
    const result = this._findByRelativePath(normalizedPath, { resolveSymlinks: false });

    // For external links, fall back to the filesystem.
    if (result.entry && result.entry.isSymbolicLink() && result.entry._symlink.external) {
      return fs.readFileSync(result.entry._symlink.external, encoding);
    }

    return FacadeTree.prototype.readFileSync.call(this, relativePath, encoding);
  },

  /** Read the contents of a directory.
   *
   * @param {string} relativePath The path to read.
   * @returns {string[]} An array of names representing the directory's contents.
   */
  readdirSync(relativePath) {
    const normalizedPath = shared.normalizeRelativePath(relativePath);
    const result = this._findByRelativePath(normalizedPath);

    // For external links, fall back to the filesystem.
    if (result.entry && result.entry.isSymbolicLink() && result.entry._symlink.external) {
      return fs.readdirSync(result.entry._symlink.external);
    }

    return FacadeTree.prototype.readdirSync.call(this, relativePath);
  },

  /** Remove a path.
   *
   * If the specified path is a file or symlink, functions as 'unlink'.  If it
   * is a directory, functions as 'rmdir'.
   *
   * @param {string} relativePath The path to remove.
   * @throws {ENOENT} If the path does not exist.
   */
  removeSync(relativePath) {
    const normalizedPath = shared.normalizeRelativePath(relativePath);

    this._throwOnCommonErrors('remove', normalizedPath, relativePath, { allowSymlinks: true });

    const result = this._findByRelativePath(normalizedPath, { resolveSymlinks: false });

    if (!result.entry) {
      throw new Error(`ENOENT: no such file or directory, remove '${relativePath}'`);
    }

    if (result.entry.isSymbolicLink() || result.entry.isFile()) {
      this.unlinkSync(relativePath);
    } else {
      this.rmdirSync(relativePath);
    }
  },

  /** Remove a directory.
   *
   * @param {string} relativePath The directory to remove.
   * @throws {ENOENT} If the path does not exist.
   * @throws {ENOTDIR} If the path is not a directory.
   */
  rmdirSync(relativePath) {
    const normalizedPath = shared.normalizeRelativePath(relativePath);

    this._throwOnCommonErrors('rmdir', normalizedPath, relativePath);

    const result = this._findByRelativePath(normalizedPath);

    if (!result.entry) {
      throw new Error(`ENOENT: no such file or directory, rmdir '${relativePath}'`);
    }

    if (result.entry.isSymbolicLink() || !result.entry.isDirectory()) {
      throw new Error(`ENOTDIR: not a directory, rmdir '${relativePath}'`);
    }

    fs.rmdirSync(this._resolvePath(result.entry.relativePath));
    this._track('rmdir', result.entry);
    this._removeEntry(result.entry);
  },

  /** Make the tree writable.
   *
   * Causes the tree to empty it's array of tracked changes and begin accepting
   * writes.
   */
  start() {
    // The ends of the doubly-linked list of changes.
    this._firstChange = undefined;
    this._lastChange = undefined;

    // A multidentional hash of which paths have been affected by which
    // operations.  Used for untracking.
    this._changeHash = {
      change: {},
      create: {},
      mkdir: {},
      rmdir: {},
      unlink: {},
    };

    this._state = WritableTree.STARTED;
  },

  /** Gets stats for a path.
   *
   * @param {string} relativePath The path to read.
   */
  statSync(relativePath) {
    const normalizedPath = shared.normalizeRelativePath(relativePath);
    const result = this._findByRelativePath(normalizedPath);

    // For external links, fall back to the filesystem.
    if (result.entry && result.entry.isSymbolicLink() && result.entry._symlink.external) {
      return fs.statSync(result.entry._symlink.external);
    }

    return FacadeTree.prototype.statSync.call(this, relativePath);
  },

  /** Make the tree read-only.
   *
   * Causes the tree to stop accepting writes.
   */
  stop() {
    this._state = WritableTree.STOPPED;
  },

  /** Create a symlink to an external file.
   *
   * This method is used to link to an arbitrary path elsewhere on the file
   * system.  It SHOULD NOT be used to link to an entry in another FacadeTree.
   *
   * @param {string} target The absolute path to the file being linked to.
   * @param {string} relativePath The path where the link will be created.
   * @throws {EEXIST} If the path already exists.
   * @see WritableTree#symlinkToFacadeSync
   */
  symlinkSync(target, relativePath) {
    const normalizedPath = shared.normalizeRelativePath(relativePath);

    this._throwOnCommonErrors('symlink', normalizedPath, relativePath);

    const result = this._findByRelativePath(normalizedPath);

    if (result.entry) {
      throw new Error(`EEXIST: file already exists, symlink '${target}' -> '${relativePath}'`);
    }

    symlinkOrCopy.sync(target, this._resolvePath(normalizedPath));

    const entry = new Entry(normalizedPath, undefined, Date.now(), Entry.FILE_MODE);

    entry._symlink = { external: target };

    this._track('create', entry);
    this._insertEntry(entry);
  },

  /** Create a symlink to a path contained in another FacadeTree.
   *
   * @param {FacadeTree} targetFacade The tree containing the path being linked to.
   * @param {string} targetRelativePath The path in the target tree being linked to.
   * @param {string} localRelativePath The path in this tree where the link will be created.
   * @throws {ENOTEMPTY} If attempting to link this tree's root while the tree is not empty.
   * @throws {ENOENT} If the target path does not exist in the target tree.
   * @throws {EEXIST} If the local path already exists.
   */
  symlinkToFacadeSync(targetFacade, targetRelativePath, localRelativePath) {
    const localNormalizedPath = shared.normalizeRelativePath(localRelativePath);
    const targetNormalizedPath = shared.normalizeRelativePath(targetRelativePath);

    this._throwOnCommonErrors('symlinkToFacade', localNormalizedPath, localRelativePath, { allowRoot: true });

    if (localNormalizedPath === '') {
      logger.info(`Converting writable tree rooted at '${this.root}' to a delegator.`);

      if (this._entries.length) {
        throw new Error('ENOTEMPTY: directory not empty, rmdir \'\'');
      }

      fs.rmdirSync(this.root);
      symlinkOrCopy.sync(targetFacade._resolvePath(targetNormalizedPath), this.root);

      Delegator.call(this, { delegate: targetFacade.chdir(targetNormalizedPath) });
      Object.setPrototypeOf(this, Delegator.prototype);

      return;
    }

    const targetResult = targetFacade._findByRelativePath(targetNormalizedPath);

    if (!targetResult.entry) {
      throw new Error(`ENOENT: no such file or directory, symlink '${targetRelativePath}' -> '${localRelativePath}'`);
    }

    const localResult = this._findByRelativePath(localNormalizedPath, { followSymlinks: false });

    if (localResult.entry) {
      throw new Error(`EEXIST: file already exists, symlink '${targetRelativePath}' -> '${localRelativePath}'`);
    }

    let mode;
    let operation;
    let symlink;

    if (targetResult.entry.isDirectory()) {
      mode = Entry.DIRECTORY_MODE;
      operation = 'mkdir';
      symlink = { tree: targetFacade.chdir(targetNormalizedPath), entry: Entry.ROOT };
    } else {
      mode = Entry.FILE_MODE;
      operation = 'create';
      symlink = targetResult;
    }

    symlinkOrCopy.sync(targetFacade._resolvePath(targetNormalizedPath), this._resolvePath(localNormalizedPath));

    const entry = new Entry(localNormalizedPath, undefined, Date.now(), mode);

    entry._symlink = symlink;

    this._track(operation, entry);
    this._insertEntry(entry);
  },

  /** Remove a file or symlink.
   *
   * @param {string} relativePath The path to remove.
   * @throws {ENOENT} If the path does not exist.
   * @throws {EPERM} If the path is a directory.
   */
  unlinkSync(relativePath) {
    const normalizedPath = shared.normalizeRelativePath(relativePath);

    this._throwOnCommonErrors('unlink', normalizedPath, relativePath, { allowSymlinks: true });

    const result = this._findByRelativePath(normalizedPath, { resolveSymlinks: false });

    if (!result.entry) {
      throw new Error(`ENOENT: no such file or directory, unlink '${relativePath}'`)
    }

    if (!result.entry.isSymbolicLink() && result.entry.isDirectory()) {
      // unlink produces EPERM, not EISDIR, when trying to delete a directory.
      // http://www.gnu.org/software/libc/manual/html_node/Deleting-Files.html
      throw new Error(`EPERM: operation not permitted, unlink '${relativePath}'`);
    }

    if (result.entry.isSymbolicLink() && result.entry.isDirectory()) {
      // Symlinks to directories are projections and need cleaned up.
      result.entry._symlink.tree._cleanup();
    }

    // Symlinks to directories produce a 'mkdir' change when created, so must
    // produce a 'rmdir' when destroyed.
    const operation = result.entry.isDirectory() ? 'rmdir' : 'unlink';

    fs.unlinkSync(this._resolvePath(normalizedPath));
    this._track(operation, result.entry);
    this._removeEntry(result.entry);
  },

  /** Write to a file.
   *
   * If the path already exists, it will be overwritten.
   *
   * @param {string} relativePath The path to write to.
   * @param {string} content The data to write.
   * @param {?Object} options Passed to `fs.writeFileSync`, which see.
   * @throws {EISDIR} If the path is a directory.
   */
  writeFileSync(relativePath, content, options) {
    const normalizedPath = shared.normalizeRelativePath(relativePath);

    this._throwOnCommonErrors('writeFile', normalizedPath, relativePath);

    const result = this._findByRelativePath(normalizedPath);

    if (result.entry) {
      if (result.entry.isDirectory()) {
        throw new Error(`EISDIR: illegal operation on a directory, open '${relativePath}'`);
      }

      // For external links, go directly to the filesystem.
      if (result.entry.isSymbolicLink() && result.entry._symlink.external) {
        fs.writeFileSync(result.entry._symlink.external, content, options);
        // return?
      }
    }

    let mode = Entry.FILE_MODE;
    const checksum = md5hex('' + content);

    if (result.entry) {
      mode = result.entry.mode;

      if (result.entry.checksum === checksum) {
        logger.info('writeFileSync %s noop, checksum did not change: %s === %s', relativePath, checksum, result.entry.checksum);

        return;
      }
    }

    fs.writeFileSync(this._resolvePath(normalizedPath), content, options);

    const entry = new Entry(normalizedPath, content.length, Date.now(), mode, checksum);

    this._track(result.entry ? 'change' : 'create', entry);
    this._insertEntry(entry);
  },
});

// ========================================================================= //
// API
// ========================================================================= //

// The existing API has been moved to a separate file with a new class name,
// but is still the primary export of the module, to support the old method of
// creating trees.
const fstree = ManualTree;

fstree.Delegator = Delegator;  // For typechecking; cannot be instantiated.
fstree.FacadeTree = FacadeTree;  // For typechecking; cannot be instantiated.
fstree.ManualTree = ManualTree;
fstree.Projection = Projection;
fstree.SourceTree = SourceTree;
fstree.WritableTree = WritableTree;

module.exports = fstree;
