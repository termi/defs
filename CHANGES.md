## v0.5.0 2013-09-30
 * Loop closure IIFE transformation support
 * Search for defs-config.json upwards in filesystem
 * Improved error messages

## v0.4.3 2013-09-05
 * Improved loop closure detection as to remove false positives
 * Improved wrapper shell script (symlink handling)

## v0.4.2 2013-09-01
 * Improved wrapper script and runner for Linux compat
 * breakout module ast-traverse

## v0.4.1 2013-07-28
 * Bugfix named function expressions (issue #12)

## v0.4 2013-07-10
 * defs became self aware
 * NPM package includes (and defaults to) the self-transpiled version
 * Bugfix renaming of index-expressions such as `arr[i]` (issue #10)

## v0.3 2013-07-05
 * defs used as a library returns errors collected to `ret.errors` instead
   of writing to stderr. This also deprecates `ret.exitcode`
