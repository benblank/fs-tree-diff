'use strict';

const { expect } = require('chai');

const verifyChanges = require('./verify-changes');

describe('verifyChanges', function() {
  it('disallows change+change', function() {
    expect(() => verifyChanges([
      [ 'change', 'foo' ],
      [ 'change', 'foo' ],
    ])).to.throw();
  });

  it('disallows change+create', function() {
    expect(() => verifyChanges([
      [ 'change', 'foo' ],
      [ 'create', 'foo' ],
    ])).to.throw();
  });

  it('disallows change+mkdir', function() {
    expect(() => verifyChanges([
      [ 'change', 'foo' ],
      [ 'mkdir', 'foo' ],
    ])).to.throw();
  });

  it('disallows change+rmdir', function() {
    expect(() => verifyChanges([
      [ 'change', 'foo' ],
      [ 'rmdir', 'foo' ],
    ])).to.throw();
  });

  it('disallows change+unlink', function() {
    expect(() => verifyChanges([
      [ 'change', 'foo' ],
      [ 'unlink', 'foo' ],
    ])).to.throw();
  });

  it('disallows create+change', function() {
    expect(() => verifyChanges([
      [ 'create', 'foo' ],
      [ 'change', 'foo' ],
    ])).to.throw();
  });

  it('disallows create+create', function() {
    expect(() => verifyChanges([
      [ 'create', 'foo' ],
      [ 'create', 'foo' ],
    ])).to.throw();
  });

  it('disallows create+mkdir', function() {
    expect(() => verifyChanges([
      [ 'create', 'foo' ],
      [ 'mkdir', 'foo' ],
    ])).to.throw();
  });

  it('disallows create+rmdir', function() {
    expect(() => verifyChanges([
      [ 'create', 'foo' ],
      [ 'rmdir', 'foo' ],
    ])).to.throw();
  });

  it('disallows create+unlink', function() {
    expect(() => verifyChanges([
      [ 'create', 'foo' ],
      [ 'unlink', 'foo' ],
    ])).to.throw();
  });

  it('disallows mkdir+change', function() {
    expect(() => verifyChanges([
      [ 'mkdir', 'foo' ],
      [ 'change', 'foo' ],
    ])).to.throw();
  });

  it('disallows mkdir+create', function() {
    expect(() => verifyChanges([
      [ 'mkdir', 'foo' ],
      [ 'create', 'foo' ],
    ])).to.throw();
  });

  it('disallows mkdir+mkdir', function() {
    expect(() => verifyChanges([
      [ 'mkdir', 'foo' ],
      [ 'mkdir', 'foo' ],
    ])).to.throw();
  });

  it('disallows mkdir+rmdir', function() {
    expect(() => verifyChanges([
      [ 'mkdir', 'foo' ],
      [ 'rmdir', 'foo' ],
    ])).to.throw();
  });

  it('disallows mkdir+unlink', function() {
    expect(() => verifyChanges([
      [ 'mkdir', 'foo' ],
      [ 'unlink', 'foo' ],
    ])).to.throw();
  });

  it('disallows rmdir+change', function() {
    expect(() => verifyChanges([
      [ 'rmdir', 'foo' ],
      [ 'change', 'foo' ],
    ])).to.throw();
  });

  it('allows rmdir+create', function() {
    expect(() => verifyChanges([
      [ 'rmdir', 'foo' ],
      [ 'create', 'foo' ],
    ])).to.not.throw();
  });

  it('disallows rmdir+mkdir', function() {
    expect(() => verifyChanges([
      [ 'rmdir', 'foo' ],
      [ 'mkdir', 'foo' ],
    ])).to.throw();
  });

  it('disallows rmdir+rmdir', function() {
    expect(() => verifyChanges([
      [ 'rmdir', 'foo' ],
      [ 'rmdir', 'foo' ],
    ])).to.throw();
  });

  it('disallows rmdir+unlink', function() {
    expect(() => verifyChanges([
      [ 'rmdir', 'foo' ],
      [ 'unlink', 'foo' ],
    ])).to.throw();
  });

  it('disallows unlink+change', function() {
    expect(() => verifyChanges([
      [ 'unlink', 'foo' ],
      [ 'change', 'foo' ],
    ])).to.throw();
  });

  it('disallows unlink+create', function() {
    expect(() => verifyChanges([
      [ 'unlink', 'foo' ],
      [ 'create', 'foo' ],
    ])).to.throw();
  });

  it('allows unlink+mkdir', function() {
    expect(() => verifyChanges([
      [ 'unlink', 'foo' ],
      [ 'mkdir', 'foo' ],
    ])).to.not.throw();
  });

  it('disallows unlink+rmdir', function() {
    expect(() => verifyChanges([
      [ 'unlink', 'foo' ],
      [ 'rmdir', 'foo' ],
    ])).to.throw();
  });

  it('disallows unlink+unlink', function() {
    expect(() => verifyChanges([
      [ 'unlink', 'foo' ],
      [ 'unlink', 'foo' ],
    ])).to.throw();
  });

  it('allows child-after-mkdir', function() {
    expect(() => verifyChanges([
      [ 'mkdir', 'foo' ],
      [ 'create', 'foo/bar' ],
    ])).to.not.throw();
  });

  it('disallows mkdir-after-child', function() {
    expect(() => verifyChanges([
      [ 'create', 'foo/bar' ],
      [ 'mkdir', 'foo' ],
    ])).to.throw();
  });

  it('disallows child-after-rmdir', function() {
    expect(() => verifyChanges([
      [ 'rmdir', 'foo' ],
      [ 'create', 'foo/bar' ],
    ])).to.throw();
  });

  it('allows rmdir-after-child', function() {
    expect(() => verifyChanges([
      [ 'create', 'foo/bar' ],
      [ 'rmdir', 'foo' ],
    ])).to.not.throw();
  });
});
