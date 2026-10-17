/**
 * `@openharness/hands/testing` — the fixtures another package's tests are meant to reuse.
 *
 * Today that is the git fixture (epic #349, K3): a repository built from a map of files and
 * served over smart HTTP on loopback, which is how a clone is tested without an internet, a
 * forge account or a flake. It is a subpath rather than a file inside one suite because the
 * server's import tests and the end-to-end QA specs (#355) want the same repository, and
 * because a fixture that only one suite can reach is a fixture the next suite rewrites.
 *
 * Everything here needs a `git` executable on the path — that is the served side — and a test
 * asks {@link gitAvailable} first so a machine without one skips rather than fails.
 */

export {
  createGitFixture,
  gitAvailable,
  type GitFixture,
  type GitFixtureOptions,
  type GitFileMap,
} from './git-fixture'
