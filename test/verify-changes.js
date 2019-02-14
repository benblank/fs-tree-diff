'use strict';

const path = require('path');

/** Verify that the passed changes are in a valid order and are not duplicated.
 *
 * For example, if there is a change to create a directory, ensure it does not
 * follow changes which affect that directory's contents.  Also ensures there
 * are no redundant changes (e.g. create+change).
 */
function verifyChangeOrder(changes) {
  const priorChanges = new Map();

  for (const [ type, relativePath ] of changes) {
    if (priorChanges.has(relativePath)) {
      const priorType = priorChanges.get(relativePath);

      // Replacing directories with files is allowed.
      if (priorType === 'rmdir' && type === 'create') {
        continue;
      }

      // Replacing files with directories is allowed.
      if (priorType === 'unlink' && type === 'mkdir') {
        continue;
      }

      // Otherwise, the same path should never be present twice in the same set of changes.
      if (priorType !== 'child path changed') {
        throw new Error(`Multiple changes for the same path: '${relativePath}'.`);
      }

      if (type === 'mkdir') {
        throw new Error(`Parent '${relativePath}' created after child modifications.`);
      }
    } else {
      priorChanges.set(relativePath, type);

      let parent = path.dirname(relativePath);

      while (parent !== '.') {
        if (priorChanges.has(parent)) {
          if (priorChanges.get(parent) === 'rmdir') {
            throw new Error(`Child '${relativePath}' modified after parent '${parent}' removed.`);
          }
        } else {
          priorChanges.set(parent, 'child path changed');
        }

        parent = path.dirname(parent);
      }
    }
  }
}

module.exports = verifyChangeOrder;
