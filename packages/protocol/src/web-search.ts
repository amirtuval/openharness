/**
 * The `web_search` tool's name (epic #303, [#335](https://github.com/amirtuval/openharness/issues/335)).
 *
 * `web_search` is the one built-in tool this build does **not** run: it is offered by attaching
 * the chat model's own provider's native search tool to the request, and the provider executes
 * the search inside that one model request. Nothing about it is a `@openharness/hands` tool
 * ({@link https://github.com/amirtuval/openharness/issues/305} built it on an operator-paid
 * search API, and #335 removed that).
 *
 * The name still lives here, beside `ask_user` and `todo_write`, because it is the spelling
 * three packages have to agree on and none of them owns: a user's stored tool settings and a
 * mode's override are keyed by it (`builtin.web_search`, see `./resources/tool-settings`), a
 * request's `span.model_request_start.tools` records it, and a client renders it. Keeping the
 * name is what makes the settings a user already saved — and the modes they wrote — carry over
 * from the operator-key era unchanged.
 */

/** The name the model calls the tool by, and the name a reader looks for in the log. */
export const WEB_SEARCH_TOOL_NAME = 'web_search'
