/**
 * Escape `<` and `>` for use inside Feishu interactive card markdown content.
 *
 * Why only these two characters:
 * - `<` and `>` are the only chars Feishu treats as HTML-like in card markdown
 *   (they can leak raw tags or break code spans that use angle brackets).
 * - We intentionally do NOT escape markdown metacharacters like `*` `_` `` ` ``
 *   `~` — session titles and previews legitimately contain them, and stripping
 *   them would corrupt the displayed text. The card layout is robust to those.
 * - `&` is also left alone: replacing it with `&amp;` would force callers who
 *   re-escape to track the order (`&` first, then `<`/`>`), and there is no
 *   Feishu rendering hazard from leaving raw `&` in card text.
 *
 * Callers that put user-controlled strings into card content MUST pass them
 * through `esc()` (or `preview(text) → esc()` for truncated previews).
 */
export function esc(text: string): string {
  return text.replace(/[<>]/g, c => (c === '<' ? '&lt;' : '&gt;'));
}
