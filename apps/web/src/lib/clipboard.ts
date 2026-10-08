/**
 * Putting text on the reader's clipboard, in one place (#212).
 *
 * Two things offer it now — a code block's Copy (#204) and a message's (#212) — and they have
 * to behave the same way, so the rule lives here rather than in the first component that
 * needed it.
 *
 * The async clipboard API needs a secure context, and a browser that will not give it one (a
 * refused permission, a plain-http origin) is not something to explain in a chat message: the
 * answer is `false`, and the button simply does not claim to have copied. Nothing is thrown
 * and nothing is reported — a copy that failed leaves the screen exactly as it was.
 */
export async function writeToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
