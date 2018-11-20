'use strict';

const path = require('path');

const Entry = require('./entry');

const TRAILING_SLASH_PATTERN = new RegExp(`${path.sep}$`);

const emittedDeprecations = new Set();
const normalizedPaths = {};

// TODO: do we actually have to have Stats?
// it's here because we added support for walksync to accept us (an fs facade)
// as a custom fs API.
//
// This means walksync will be calling statSync on us, and walksync expects the
// stats it gets back to have `mtime`'s that are `Date`s, not `Number`s.
function Stats(size, mtime, mode) {
  this.size = size;
  this.mtime = mtime;
  this.mode = mode;
}

Object.assign(Stats.prototype, {
  isDirectory() {
    return Entry.isDirectory(this);
  },

  isFile() {
    return Entry.isFile(this);
  },

  isSymbolicLink() {
    return Entry.isSymbolicLink(this);
  },
});

module.exports = {
  _basename(entry) {
    const path_ = module.exports.entryRelativePath(entry);
    const end = path_.length - 2;

    for (let i = end; i >= 0; --i) {
      if (path_[i] === '/') {
        return path_.substr(0, i + 1);
      }
    }

    return '';
  },

  _chompSeparator(path_) {
    return path_.replace(TRAILING_SLASH_PATTERN, '');
  },

  _commonPrefix(a, b, term) {
    const max = Math.min(a.length, b.length);
    let end = -1;

    for (let i = 0; i < max; ++i) {
      if (a[i] !== b[i]) {
        break;
      } else if (a[i] === term) {
        end = i;
      }
    }

    return a.substr(0, end + 1);
  },

  _comparePaths(a, b) {
    if (a > b) {
      return 1;
    }

    if (a < b) {
      return -1;
    }

    return 0;
  },

  _computeImpliedEntries(basePath, relativePath) {
    let rv = [];

    for (let i = 0; i < relativePath.length; ++i) {
      if (relativePath[i] === '/') {
        let path_ = basePath + relativePath.substr(0, i + 1);
        rv.push(Entry.fromPath(path_));
      }
    }

    return rv;
  },

  Stats,

  compareChanges(a, b) {
    const operationTypeA = (a[0] === 'rmdir' || a[0] === 'unlink') ? 'remove' : 'add';
    const operationTypeB = (b[0] === 'rmdir' || b[0] === 'unlink') ? 'remove' : 'add';

    if (operationTypeA === 'remove' && operationTypeB === 'add') {
      return -1;
    } else if (operationTypeA === 'add' && operationTypeB === 'remove') {
      return 1;
    }

    // Operation types are now known to be the same, so we only need to check one.
    if (operationTypeA === 'remove') {
      // Reverse the sort order for remove operations.
      return -module.exports._comparePaths(a[1], b[1]);
    }

    return module.exports._comparePaths(a[1], b[1]);
  },

  /** Compare two entries by their relative paths.
   *
   * Suitable for use with `Array.prototype.sort`.
   *
   * This sorting is necessary when entries are not collected in the same order
   * in which they must appear.  For example, if a `WritableTree` contains the
   * entries "foo" (a symlinked directory) and "foo.js", the symlink's contents
   * will be inserted between the two ("foo", "foo/bar.js", "foo.js") and then
   * need re-sorted ("foo", "foo.js", "foo/bar.js").
   */
  compareEntries(a, b) {
    return module.exports._comparePaths(a.relativePath, b.relativePath);
  },

  /** Emit a deprecation warning.
   *
   * Each unique message is only emitted once per process.
   *
   * If `process.emitWarning` is available, it will be used, and the
   * deprecation parameters to Node will therefore be honored.  Otherwise,
   * `console.warn` will be used to produce similar output, honoring
   * equivalent environment variables:
   *
   * * --no-deprecation -> NODE_NO_DEPRECATION
   * * --throw-deprecation -> NODE_THROW_DEPRECATION
   * * --trace-deprecation -> NODE_TRACE_DEPRECATION
   *
   * @param {string} message The deprecation warning to emit.
   */
  emitDeprecationWarning(message) {
    // Emit each deprecation only once.
    if (emittedDeprecations.has(message)) {
      return;
    }

    emittedDeprecations.add(message);

    // Use Node's built-in handling, if available.
    if (process.emitWarning) {
      process.emitWarning(message, 'DeprecationWarning');

      return;
    }

    // Don't warn if deprecation reporting is disabled.
    if (process.env.NODE_NO_DEPRECATION) {
      return;
    }

    console.warn(`DeprecationWarning: ${message}`);

    // No need to construct an error unless we're going to use it.
    if (process.env.NODE_THROW_DEPRECATION || process.env.NODE_TRACE_DEPRECATION) {
      const error = new Error(message);

      if (process.env.NODE_THROW_DEPRECATION) {
        error.name = 'DeprecationWarning';

        throw error;
      }

      console.warn(error.trace);
    }
  },

  ensureSeparator(path_) {
    return !path_.length || path_[path_.length - 1] === path.sep ? path_ : `${path_}${path.sep}`;
  },

  entryRelativePath(entry) {
    if (Entry.isDirectory(entry)) {
      return module.exports._chompSeparator(entry.relativePath);
    }

    return entry.relativePath;
  },

  /** Just like `path.join`, but return '' instead of '.'.
   *
   * Unlike `path.resolve`, `path.join` returns '.' for the current directory.
   * As much of FacadeTrees' logic is based on `normalizePath`, which is in
   * turn based on `path.resolve`, it is necessary to join paths without
   * encountering '.' or always passing the result through `normalizePath`.
   */
  joinPaths() {
    const result = path.join.apply(path, arguments);

    return result === '.' ? '' : result;
  },

  /** Merge two sorted arrays into a new sorted array.
   *
   * Both provided arrays must already be sorted, but no checking is done to
   * verify this.  If both arrays are known not to contain duplicates
   * (internally or mutually), be sure to pass the `ignoreDuplcates` flag for a
   * permormance boost.
   */
  mergeEntries(first, second, ignoreDuplicates) {
    // FIXME: This is significantly faster for large arrays (>4x @ ~1000), but
    // a bit slower for small ones (~.75x @ ~10).  Pick a cutoff point?
    if (ignoreDuplicates) {
      return first.concat(second).sort(module.exports.compareEntries);
    }

    const firstLength = first.length;
    let firstIndex = 0;
    const secondLength = second.length;
    let secondIndex = 0;
    const resultLength = firstLength + secondLength;
    const result = new Array(resultLength);
    let trim = 0;

    for (let i = 0; i < resultLength - trim; i++) {
      if (firstIndex < firstLength) {
        if (secondIndex < secondLength) {
          const firstEntry = first[firstIndex];
          const firstPath = firstEntry.relativePath;
          const secondEntry = second[secondIndex];
          const secondPath = secondEntry.relativePath;

          if (firstPath < secondPath) {
            result[i] = firstEntry;
            firstIndex++;
          } else if (firstPath > secondPath) {
            result[i] = secondEntry;
            secondIndex++;
          } else {
            result[i] = secondEntry; // === firstEntry
            firstIndex++;
            secondIndex++;
            trim++;
          }
        } else {
          result[i] = first[firstIndex++];
        }
      } else {
        result[i] = second[secondIndex++];
      }
    }

    if (trim) {
      result.splice(-trim);
    }

    return result;
  },

  normalizeRelativePath(relativePath) {
    if (typeof relativePath !== 'string') {
      throw new TypeError('Relative path must be a string.');
    }

    // If we've normalized this path before, return the cached result.
    if (relativePath in normalizedPaths) {
      const normalizedPath = normalizedPaths[relativePath];

      if (typeof normalizedPath === 'string') {
        return normalizedPath;
      }

      // Otherwise, it's an Error indicating that the relativePath escapes root.
      throw normalizedPath;
    }

    const parts = relativePath.split(path.sep);

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];

      if (part === '' || part === '.') {
        parts.splice(i, 1);

        // Decrement the index by the number of elements removed.
        i -= 1;
      } else if (part === '..') {
        if (i === 0) {
          const error = normalizedPaths[relativePath] = new Error(`Invalid path: '${relativePath}' not within root.`);

          throw error;
        }

        parts.splice(i - 1, 2);

        // Decrement the index by the number of elements removed.
        i -= 2;
      }
    }

    const normalizedPath = parts.join(path.sep);

    normalizedPaths[relativePath] = normalizedPath;

    if (!(normalizedPath in normalizedPaths)) {
      normalizedPaths[normalizedPath] = normalizedPath;
    }

    return normalizedPath;
  },

  normalizeRoot(root) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) {
      throw TypeError(`Root must be an absolute path, not '${root}'.`);
    }

    return module.exports._chompSeparator(path.normalize(root));
  },

  /** Search an array of entries for a specific path.
   *
   * Uses a binary search to locate the appropriate entry.
   *
   * @param {Entry[]} entries The array of entries to search.
   * @param {string} normalizedPath The path to search for.
   * @param {boolean} closest If true, returns the highest match less than or equal to the target.
   * @returns {number} The index of the matching entry if found, otherwise -1.
   */
  searchByRelativePath(entries, normalizedPath, closest) {
    if (!entries.length) {
      return -1;
    }

    if (normalizedPath < entries[0].relativePath) {
      return -1;
    }

    if (normalizedPath > entries[entries.length - 1].relativePath) {
      return closest ? entries.length - 1 : -1;
    }

    let low = 0;
    let high = entries.length - 1;

    while (low <= high) {
      // `~~` === `Math.floor`, but slightly faster.
      const middle = low + ~~((high - low) / 2);
      const middleRelativePath = entries[middle].relativePath;

      if (normalizedPath === middleRelativePath) {
        return middle;
      }

      if (normalizedPath < middleRelativePath) {
        high = middle - 1;
      } else {
        low = middle + 1;
      }
    }

    if (closest) {
      if (low >= entries.length) {
        return high;
      }

      if (low < 0) {
        return -1;
      }

      return entries[low].relativePath < normalizedPath ? low : low - 1;
    }

    return -1;
  },

  sortAndExpand(entries) {
    entries.sort(module.exports.compareEntries);

    let path_ = '';

    for (let i = 0; i < entries.length; ++i) {
      let entry = entries[i];

      // update our path eg
      //    path_ = a/b/c/d/
      //    entry = a/b/q/r/s/
      //    path_' = a/b/
      let entryPath = entry.relativePath;
      path_ = module.exports._commonPrefix(path_, entryPath, '/');

      // a/b/ -> a/
      // a/b  -> a/
      let base = module.exports._basename(entry);
      // base - path_
      let entryBaseSansCommon = base.substr(path_.length);
      // determine what intermediate directories are missing eg
      //    path_ = a/b/
      //    entryBaseSansCommon = c/d/e/
      //    impliedEntries = [a/b/c/, a/b/c/d/, a/b/c/d/e/]
      let impliedEntries = module.exports._computeImpliedEntries(path_, entryBaseSansCommon);

      // actually add our implied entries to entries
      if (impliedEntries.length > 0) {
        entries.splice.apply(entries, [i, 0].concat(impliedEntries));
        i += impliedEntries.length;
      }

      // update path.  Now that we've created all the intermediate directories, we
      // don't need to recreate them for subsequent entries.
      if (Entry.isDirectory(entry)) {
        path_ = entry.relativePath + '/';
      } else {
        path_ = base;
      }
    }

    return entries;
  },

  validateSortedUnique(entries) {
    for (let i = 1; i < entries.length; i++) {
      let previous = entries[i - 1].relativePath;
      let current = entries[i].relativePath;

      if (previous < current) {
        continue;
      } else {
        throw new Error('expected entries[' + (i -1) + ']: `' + previous +
                        '` to be < entries[' + i + ']: `' + current + '`, but was not. Ensure your input is sorted and has no duplicate paths');
      }
    }
  },
};
