import { describe, expect, it } from 'vitest'

import { isGitUrlError, parseGitUrl, type GitUrlError } from './git-url'

/**
 * Reading an import's URL (epic #349, K3).
 *
 * A table, because this is a parser with a small number of shapes and a large number of ways
 * to be subtly wrong: a browse URL's ref and path have to come out as *those two fields* and
 * not as one, a clone URL has to survive untouched, and everything K3 refuses — another
 * scheme, credentials in the URL, a URL naming no repository — has to be refused rather than
 * quietly reinterpreted.
 */

/** The three fields a URL reads as, or the code it was refused with. */
function read(input: string): unknown {
  try {
    return parseGitUrl(input)
  } catch (error) {
    return isGitUrlError(error) ? `refused:${error.code}` : `threw:${String(error)}`
  }
}

describe('parseGitUrl', () => {
  it('reads a clone URL as a repository and nothing else', () => {
    expect(read('https://github.com/anthropics/skills')).toEqual({
      url: 'https://github.com/anthropics/skills',
      ref: null,
      path: null,
    })
    expect(read('https://github.com/anthropics/skills.git')).toEqual({
      url: 'https://github.com/anthropics/skills.git',
      ref: null,
      path: null,
    })
    expect(read('https://gitlab.com/group/project')).toEqual({
      url: 'https://gitlab.com/group/project',
      ref: null,
      path: null,
    })
  })

  it('splits a GitHub browse URL into the repository, the ref and the path', () => {
    expect(read('https://github.com/anthropics/skills/tree/main/skills/release-notes')).toEqual({
      url: 'https://github.com/anthropics/skills',
      ref: 'main',
      path: 'skills/release-notes',
    })
    // A ref with no path under it is a repository and a branch.
    expect(read('https://github.com/anthropics/skills/tree/main')).toEqual({
      url: 'https://github.com/anthropics/skills',
      ref: 'main',
      path: null,
    })
    // A deep path keeps its slashes.
    expect(read('https://github.com/a/b/tree/v1.2.3/x/y/z')).toEqual({
      url: 'https://github.com/a/b',
      ref: 'v1.2.3',
      path: 'x/y/z',
    })
  })

  it('splits a GitLab browse URL the same way, around its own `-`', () => {
    expect(read('https://gitlab.com/group/project/-/tree/main/skills')).toEqual({
      url: 'https://gitlab.com/group/project',
      ref: 'main',
      path: 'skills',
    })
    // A nested group is part of the repository, not of the ref.
    expect(read('https://gitlab.com/group/sub/project/-/tree/v2/one/two')).toEqual({
      url: 'https://gitlab.com/group/sub/project',
      ref: 'v2',
      path: 'one/two',
    })
  })

  it('keeps a self-hosted forge on its own host and port', () => {
    expect(read('https://git.example.com:8443/team/repo/tree/main/skills')).toEqual({
      url: 'https://git.example.com:8443/team/repo',
      ref: 'main',
      path: 'skills',
    })
  })

  it('drops the query, the fragment and a trailing slash', () => {
    expect(read('https://github.com/a/b/?tab=readme')).toEqual({
      url: 'https://github.com/a/b',
      ref: null,
      path: null,
    })
    expect(read('https://github.com/a/b#install')).toEqual({
      url: 'https://github.com/a/b',
      ref: null,
      path: null,
    })
    expect(read('  https://github.com/a/b/  ')).toEqual({
      url: 'https://github.com/a/b',
      ref: null,
      path: null,
    })
  })

  it('reads a percent-encoded ref or path as what it says', () => {
    expect(read('https://github.com/a/b/tree/release%2F1.0/my%20skill')).toEqual({
      url: 'https://github.com/a/b',
      ref: 'release/1.0',
      path: 'my skill',
    })
  })

  it('reads a repository that is itself called `tree`', () => {
    // The marker is only a marker when something can be in front of it: `owner/repo` needs two
    // segments, so this is a repository named `main` under an owner named `tree`.
    expect(read('https://github.com/tree/main')).toEqual({
      url: 'https://github.com/tree/main',
      ref: null,
      path: null,
    })
  })

  it('refuses anything that is not an https URL', () => {
    expect(read('http://github.com/a/b')).toBe('refused:not_https')
    expect(read('git://github.com/a/b')).toBe('refused:not_https')
    expect(read('ssh://git@github.com/a/b')).toBe('refused:not_https')
    expect(read('git@github.com:a/b.git')).toBe('refused:not_https')
    expect(read('file:///srv/git/b.git')).toBe('refused:not_https')
    expect(read('github.com/a/b')).toBe('refused:not_https')
    expect(read('')).toBe('refused:not_https')
  })

  it('refuses a URL that carries credentials', () => {
    expect(read('https://user:token@github.com/a/b')).toBe('refused:credentials')
    expect(read('https://ghp_secret@github.com/a/b')).toBe('refused:credentials')
    // The token never reaches the message, which may be shown or logged.
    try {
      parseGitUrl('https://ghp_secret@github.com/a/b')
      expect.unreachable()
    } catch (error) {
      expect((error as GitUrlError).message).not.toContain('ghp_secret')
    }
  })

  it('refuses a URL that names no repository', () => {
    expect(read('https://github.com')).toBe('refused:no_repository')
    expect(read('https://github.com/')).toBe('refused:no_repository')
  })
})
