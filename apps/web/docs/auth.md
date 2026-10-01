# Authentication in the web app

Why the sign-in page, the device-approval page and the Model providers card are shaped the way
they are (issue #62, epic #65). `AGENTS.md` has the tour and the commands; this is the
reasoning behind the choices.

## The session is a cookie, and the app never sees it

A browser's session is a signed, httpOnly cookie the server sets (epic #65, A2). The app cannot
read it, does not store it, and never puts it in a header — `@openharness/client` sends
`credentials: 'include'` on every request, and that is the whole mechanism. There is no token
in `localStorage` and no `Authorization` header in the browser at all; the CLI's bearer token
is the other, separate way into the same API.

Two consequences run through everything below:

- **Who am I?** can only be answered by asking: `client.me()` (`GET /v1/me`). The app does that
  once per client instance, and the answer is the `user` the sidebar shows.
- **Am I still signed in?** is only answered by a request failing. A 401 is the signal.

## One store, one rule: a 401 means sign in again

`src/lib/auth-store.ts` holds the app's auth state (`checking`, `signed-out`,
`signed-in` + `user`) and the rule the whole app follows:

> Any call that comes back 401 is `noteAuthenticationError(client, error)`, and that puts the
> sign-in page in place of whatever was on screen.

It is a module-level store rather than React state because the callers are not components. The
four places that catch errors — `use-session`, `use-sessions`, `use-agents` and
`use-provider-credentials` — each do the same one-line thing, and the shell re-renders. That is
why a revoked session cannot leave the reader on a screen of broken panels: the first request
that fails replaces the screen.

The state is **per client instance** (`authStateFor(client)`). A settings change or a test
builds a new client, and until that client has been asked, its answer is `checking` — never
another client's answer.

**Two failures are deliberately not routed.** The Model providers card handles a 401 from a
_credential write_ itself, because the server wants a **fresh** session there (Better Auth's
`freshAge`) and "your session is too old" is a different message from "you are signed out" —
the card shows it with a link to sign in again and leaves the reader where they were. And a
failed _transport_ is not a session problem at all.

## Sign-in (`src/screens/sign-in-screen.tsx`, `#/signin`)

`GET /v1/auth-config` — unauthenticated, and not part of `@openharness/protocol`, so
`src/lib/auth-config.ts` fetches it directly and validates it with a local zod schema — says
which providers this server has configured and whether the development login is on. The screen
draws one button per provider and the dev form only when `dev_login` is true (A7).

The call itself is Better Auth's browser client (`better-auth/client` with the
`device-authorization` plugin), wrapped in `src/lib/auth-client.ts` — a small, explicitly typed
adapter over the six calls this app makes. Better Auth's own client methods are inferred from a
server type this app does not have; the wrapper is the seam, and it is also the module boundary
the tests mock.

| what the reader does | what the app calls                         | where it goes                          |
| -------------------- | ------------------------------------------ | -------------------------------------- |
| clicks a provider    | `signIn.social({ provider, callbackURL })` | to the provider, back to `callbackURL` |
| submits the dev form | `signIn.email({ email, password })`        | stays; the app re-reads `me()`         |
| clicks Sign out      | `signOut()`                                | the sign-in page                       |

**Returning to where they were** is the interesting part. The app is a hash-routed SPA, so the
route _is_ the URL: `callbackURL` is the current `location.href` resolved to an absolute URL
(`absoluteUrl(returnHash)`), which carries the hash through the provider round trip. The dev
form needs no redirect at all — signing in re-checks `me()`, and the shell renders the route
again, which never moved. A `#/signin?next=…` link (the Model providers prompt uses one) names
its destination explicitly, and the shell follows it once a session exists.

## Device approval (`src/screens/device-screen.tsx`, `#/device?user_code=…`)

`oh login` (A6) asks the server for a device code, prints it, and opens
`verification_uri_complete` in a browser. **The web app's route for that URL is
`#/device?user_code=<code>`** — `deviceHash()` in `src/lib/router.ts` is the shape, and the
server should configure its `verificationUri`/`verificationUriComplete` accordingly:

```
https://<public-url>/#/device?user_code=WXYZ-1234
```

The page keeps the code visible and large and asks the reader to compare it with their
terminal before approving — which is the point of the flow: a phishing page cannot show the
code the terminal has.

What it calls, in order:

1. `device({ query: { user_code } })` — verify. **This is not a read.** It claims the pending
   code for the browser's session, and only that session can approve or deny it afterwards.
   That is why the page needs a session: signed out, the shell shows the sign-in page first
   and comes back here afterwards, with the code still in the URL.
2. `device.approve({ userCode })` or `device.deny({ userCode })`.

The screens states are explicit — verifying, ready, approved, denied, failed — and the two
decisions are the same page with different copy afterwards, so the reader is never left
wondering whether something happened.

## Model providers (`src/components/settings/model-providers.tsx`)

Settings → Model providers is the write-only credential API (A5) with a UI:

- `providerCredentials.list()` → the rows: provider, `…last4`, when it was validated.
- `providerCredentials.put(provider, { type: 'api_key', api_key })` → add **or** replace;
  there is one credential per provider per user, which is why the form has one button that
  says "Save key" or "Replace key".
- `providerCredentials.delete(provider)` → the row's Delete, confirmed in the page (a
  `window.confirm` would block the page and cannot be tested or styled like the rest of the
  app).

The password field is cleared the moment a save succeeds, and the key is never rendered
anywhere: not in a list, not in a status line, not in an error. The tests assert exactly that
against the DOM after a save.

The provider picker offers the common router providers and a "Custom…" entry with a free-text
id, because the API takes any provider name Mastra's router knows — the list is a convenience,
not a limit.

Two failures get words of their own, because they are the two a reader can act on:

- **422 `invalid_provider_credential`** — the provider refused the key (the server validates on
  save with one cheap call). Shown next to the form, in the server's words.
- **401 on a write** — the session is not fresh enough for a credential write. Shown with a
  link to sign in again, and the reader stays on Settings.

## Where credentials show up elsewhere

A model resolves only if its provider has a key, and the app says so before the first turn
instead of letting the server say it after:

- **The agent form** (`src/components/agents/agent-form.tsx`) marks each suggestion whose
  provider has no saved credential ("no key"), and a typed model whose provider has none gets a
  line linking to Settings → Model providers.
- **A chat** whose turn ended with `session.error` of type `missing_provider_credential` (A5)
  renders that error with the same link — the one error in the log the reader can fix
  themselves, and no retry will help until they do.

## The dev login (A7)

`OPENHARNESS_DEV_LOGIN=1` on the server enables a Better Auth email/password sign-in for one
seeded user (`dev@localhost` / `dev`), and `/v1/auth-config` reports `dev_login: true`, which is
the only thing that makes the form appear. It is email/password under the hood — the form's
field is labelled "Username" because that is what the reader types, but the value goes to
`signIn.email` as the email. The server refuses to boot with it enabled on a non-localhost URL.

## Testing

`sign-in-screen.test.tsx`, `device-screen.test.tsx` and `settings-screen.test.tsx` drive the
real app against the client's fake server, with two seams:

- **Better Auth** is mocked at the module boundary in `vitest.setup.ts` (both
  `better-auth/client` and its plugin entry), for every test file. The double lives in
  `src/test-support/better-auth-client-mock.ts` and records arguments, so a test asserts the
  exact call the app makes (`{ provider, callbackURL }`, `{ query: { user_code } }`, …) and can
  script a failure with `mockResolvedValueOnce`.
- **`GET /v1/auth-config`** is the one request outside `@openharness/client`, so tests stub
  `fetch` for it (and unstub in `afterEach`).

A signed-out fake rejects every `/v1` call with `AuthenticationError` — that is the 401 path —
and comes back with `signInFake(fake)`, which runs the fake's device flow to flip its
`authenticated` flag the way the server's cookie would.
