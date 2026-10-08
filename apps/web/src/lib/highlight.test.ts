import { describe, expect, it } from 'vitest'

import { highlight, type HighlightedCode } from './highlight'

/**
 * The highlighter's language table (U12, #227).
 *
 * The chat used to ship fourteen grammars, so a `rust` fence — or a `cpp`, a `swift`, a
 * `dockerfile` — came out as plain text. It now ships Shiki's whole bundled set, and this
 * file is the proof that the languages the issue names actually resolve *and* actually
 * tokenize: an id that is in the table but whose grammar refuses the text would look
 * highlighted in a comment and plain on screen.
 *
 * It is deliberately not a test of Shiki. What is asserted of every language is the shape the
 * code block depends on: the block's own ink and surface arrive as `--shiki-*` variables, at
 * least one token is coloured, and the text that went in is the text that comes out.
 *
 * Loading a grammar is real work — the wasm engine once per worker, then a chunk per language
 * — so these are slower than the rest of the folder on purpose; the timeout is the ceiling,
 * not a race. The aliases cost nothing extra: `c++` is the `cpp` grammar, already loaded.
 */
describe('the code highlighter', () => {
  /** Enough for the engine, the themes and the grammars this file asks for. */
  const loaded = { timeout: 60_000 }

  /** What went in must be what comes out, whatever the grammar decided to colour. */
  function text(code: HighlightedCode): string {
    return code.lines.map((line) => line.map((token) => token.content).join('')).join('\n')
  }

  function coloured(code: HighlightedCode): boolean {
    return code.lines.some((line) => line.some((token) => Object.keys(token.style).length > 0))
  }

  /**
   * The languages #227 named, each with a snippet its grammar has something to say about.
   *
   * The fence label is the left-hand value; the second is what a reader would actually paste.
   * A label here and a label in {@link ALIASES} resolving to the same grammar is the point of
   * the second test.
   */
  const LANGUAGES: readonly [label: string, code: string][] = [
    ['rust', 'fn main() {\n    let name = "world";\n}'],
    ['c', 'int main(void) {\n    return 0;\n}'],
    ['cpp', '#include <string>\nint main() { std::string s = "hi"; }'],
    ['csharp', 'public class P { public string Name = "hi"; }'],
    ['java', 'public class P { public static void main(String[] a) {} }'],
    ['kotlin', 'fun main() {\n    val name = "hi"\n}'],
    ['swift', 'let greeting = "hi"'],
    ['go', 'package main\n\nfunc main() {}'],
    ['ruby', 'def greet(name)\n  puts "hi #{name}"\nend'],
    ['php', '<?php\nfunction greet($n) { return "hi $n"; }'],
    ['powershell', 'Get-ChildItem | Where-Object { $_.Name -like "*.ts" }'],
    ['sql', 'SELECT id, name FROM users WHERE id = 1;'],
    ['toml', '[package]\nname = "web"'],
    ['xml', '<note id="1">hi</note>'],
    ['css', '.a { color: red; }'],
    ['scss', '.a { .b { color: red; } }'],
    ['makefile', 'build:\n\tyarn build'],
    ['dockerfile', 'FROM node:24\nRUN yarn install'],
    ['lua', 'local function greet(n)\n  return "hi " .. n\nend'],
    ['r', 'mean(c(1, 2, 3))'],
    ['scala', 'object Main extends App { println("hi") }'],
    ['dart', 'void main() {\n  print("hi");\n}'],
    ['elixir', 'defmodule Greeter do\n  def hi, do: "hi"\nend'],
    ['haskell', 'greet :: String -> String\ngreet n = "hi"'],
    ['graphql', 'type Query {\n  me: User\n}'],
    ['terraform', 'resource "aws_instance" "web" {\n  ami = "abc"\n}'],
    ['hcl', 'resource "aws_instance" "web" {\n  ami = "abc"\n}'],
    ['nginx', 'server {\n  listen 80;\n}'],
    ['ini', '[section]\nkey = value'],
    ['diff', '-old line\n+new line'],
    ['protobuf', 'message P {\n  string name = 1;\n}'],
    ['markdown', '# Title\n\nText with **bold**.'],
  ]

  it.each(LANGUAGES)('highlights %s', loaded, async (label, code) => {
    const result = await highlight(code, label)

    expect(result).not.toBeNull()
    // The block's own ink and surface, as the three palettes `index.css` picks between.
    expect(result?.style['--shiki-light']).toBeDefined()
    expect(result?.style['--shiki-dim']).toBeDefined()
    expect(result?.style['--shiki-dark']).toBeDefined()
    expect(coloured(result as HighlightedCode)).toBe(true)
    expect(text(result as HighlightedCode)).toBe(code)
  })

  /**
   * The aliases — the short forms models actually write.
   *
   * `rs`, `c++`, `cs`, `kt`, `rb`, `tf`, `docker` are Shiki's own; `golang` and `patch` are the
   * two the app adds (see `EXTRA_ALIASES`). Each is asserted to reach the *same grammar* as
   * the long label, not merely to produce something: a fence of `rs` that rendered the text
   * with a different grammar's colours would pass a weaker test and fail the reader.
   */
  const ALIASES: readonly [alias: string, canonical: string][] = [
    ['rs', 'rust'],
    ['c++', 'cpp'],
    ['cs', 'csharp'],
    ['kt', 'kotlin'],
    ['rb', 'ruby'],
    ['py', 'python'],
    ['sh', 'bash'],
    ['shell', 'shellscript'],
    ['zsh', 'bash'],
    ['yml', 'yaml'],
    ['tf', 'terraform'],
    ['docker', 'dockerfile'],
    ['md', 'markdown'],
    ['js', 'javascript'],
    ['ts', 'typescript'],
    ['golang', 'go'],
    ['patch', 'diff'],
  ]

  it.each(ALIASES)('reads %s as %s', loaded, async (alias, canonical) => {
    const code = 'const x = "hi"\n'
    const [viaAlias, viaCanonical] = await Promise.all([
      highlight(code, alias),
      highlight(code, canonical),
    ])

    expect(viaAlias).not.toBeNull()
    expect(viaAlias).toEqual(viaCanonical)
  })

  it('answers nothing for a label no grammar claims', loaded, async () => {
    // The block is drawn as plain text with its own label — a language nobody wrote a grammar
    // for is not a failure, and it is also not "still loading".
    await expect(highlight('nuqneH', 'klingon')).resolves.toBeNull()
    await expect(highlight('x', '')).resolves.toBeNull()
  })
})
