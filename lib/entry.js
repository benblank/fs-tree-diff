'use strict';

const ARBITRARY_START_OF_TIME = 0;

function chompLeadingAndTrailingSeparator(path_) {
  // strip leading and trailing path.sep (but both seps on posix and win32);
  return path_.replace(/^(\/|\\)|(\/|\\)$/g, '');
}

/** Represents a file or directory.
 *
 * Includes the relative path to the entry, its mode, and possibly its size,
 * modification time, and checksum as well.
 */
class Entry {
  /** Create an entry.
   *
   * @param {string} relativePath The path to the file or directory.
   * @param {number=} size The size of the file.
   * @param {number|Date=} mtime The time at which the file or directory was last modified.
   * @param {number} mode The file or directory's mode.
   * @param {number=} checksum The file's MD5 sum.
   */
  constructor(relativePath, size, mtime, mode, checksum) {
    const modeType = typeof mode;

    if (modeType !== 'number') {
      throw new TypeError(`Expected 'mode' to be of type 'number' but was of type '${modeType}' instead.`);
    }

    this.mode = mode;
    this.relativePath = this.isDirectory() ? chompLeadingAndTrailingSeparator(relativePath) : relativePath;
    this.size = size;
    this.mtime = mtime;
    this.checksum = checksum;
  }

  /** Create a shallow clone.
   *
   * @param {Entry} originalEntry The entry to clone.
   * @param {string=} newRelativePath If present, will be used instead of the original entry's path.
   * @returns {Entry} The new clone.
   */
  static clone(originalEntry, newRelativePath) {
    const newEntry = Object.create(Entry.prototype);

    Object.assign(newEntry, originalEntry);

    if (typeof newRelativePath !== 'undefined') {
      newEntry.relativePath = newRelativePath;
    }

    return newEntry;
  }

  /** Create a new entry for a path.
   *
   * The path is not checked for existence; instead, it is considered to be a
   * directory if the path ends with '/' or a file otherwise, to have no size
   * or checksum, and to have never been modified.
   *
   * @param {string} relativePath The path for the new entry.
   * @returns {Entry} The newly-created entry.
   */
  static fromPath(relativePath) {
    const mode = relativePath.charAt(relativePath.length - 1) === '/' ? Entry.DIRECTORY_MODE : Entry.FILE_MODE;

    return new Entry(relativePath, undefined, ARBITRARY_START_OF_TIME, mode);
  }

  /** Create an entry from a stat object.
   *
   * No checksum is recorded in the new entry.
   *
   * @param {string} relativePath The path for the new entry.
   * @param {fs.Stat} stat The stats to use for the new entry.
   * @param {number} stat.size The size of the new entry.
   * @param {number|Date} stat.mtime The modification time for the new entry.
   * @param {number} stat.mode The mode for the new entry.
   * @returns {Entry} The newly-created entry.
   */
  static fromStat(relativePath, stat) {
    return new Entry(relativePath, stat.size, stat.mtime, stat.mode);
  }

  /** Checks whether an entry is a directory.
   *
   * Symlinks to directories are considered to be directories.
   *
   * @param {Entry} entry The entry to check.
   * @returns {boolean} True if the entry is a directory; false, otherwise.
   */
  static isDirectory(entry) {
    if (Entry.isSymbolicLink(entry)) {
      // All directory symlinks are root links.
      return entry._symlink.entry === Entry.ROOT;
    }

    return entry === Entry.ROOT || (entry.mode & 0o170000) === 0o40000;
  }

  /** Checks whether an entry is a file.
   *
   * Symlinks to directories are not considered to be files.
   *
   * @param {Entry} entry The entry to check.
   * @returns {boolean} True if the entry is a file; false, otherwise.
   */
  static isFile(entry) {
    return !Entry.isDirectory(entry);
  }

  /** Checks whether an entry is a symbolic link.
   *
   * @param {Entry} entry The entry to check.
   * @returns {boolean} True if the entry is a symlink; false, otherwise.
   */
  static isSymbolicLink(entry) {
    return !!entry._symlink;
  }

  /** Checks whether this entry is a directory.
   *
   * Symlinks to directories are considered to be directories.
   *
   * @returns {boolean} True if the entry is a directory; false, otherwise.
   * @see Entry~isDirectory
   */
  isDirectory() {
    return Entry.isDirectory(this);
  }

  /** Checks whether this entry is a file.
   *
   * Symlinks to directories are not considered to be files.
   *
   * @returns {boolean} True if the entry is a file; false, otherwise.
   * @see Entry~isFile
   */
  isFile() {
    return Entry.isFile(this);
  }

  /** Checks whether this entry is a symbolic link.
   *
   * @returns {boolean} True if the entry is a symlink; false, otherwise.
   * @see Entry~isSymbolicLink
   */
  isSymbolicLink() {
    return Entry.isSymbolicLink(this);
  }
}

Object.defineProperties(Entry, {
  DIRECTORY_MODE: {
    value: 0o40777,
  },

  FILE_MODE: {
    value: 0o100777,
  },

  ROOT: {
    value: Object.create(Entry.prototype),
  },

  SYMLINK_MODE: {
    value: 0o120777,
  },
});

module.exports = Entry;
