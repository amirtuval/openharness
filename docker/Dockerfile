# syntax=docker/dockerfile:1

# The openharness server and the web app in one image.
#
# The server is the whole deployment: it answers the API under `/v1` and serves the built web
# app at `/` (`OPENHARNESS_WEB_DIR`), so one process, one port and one origin — no CORS, and
# nothing for a browser to configure. `docker-compose.yml` starts this image beside Postgres.
#
# Three stages, and each one exists for a reason:
#
# - `manifests` holds the workspace manifests and the lockfile, so that installing dependencies
#   is a layer of its own: editing a source file rebuilds the app, not the world.
# - `build` installs the dev dependencies the builds need and produces `dist/` for the server
#   and the web app.
# - `runtime` installs *only* the production dependencies of the server — `yarn workspaces
#   focus`, which is the point of the exercise: no Vite, no Vitest, no TypeScript — copies the
#   built output in, and runs as a non-root user.
#
# Node 24 and Yarn 4 through corepack, the same as the repo (`.nvmrc`, `.yarnrc.yml`).

ARG NODE_IMAGE=node:24-alpine

# --- the manifests: everything a dependency install reads, and nothing it does not -----------
FROM ${NODE_IMAGE} AS manifests
# Corepack downloads Yarn 4 on first use; without this it asks, and there is nobody to answer.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
# Every workspace, because Yarn resolves the project from the root manifest's workspace list.
COPY package.json yarn.lock .yarnrc.yml ./
COPY apps/server/package.json apps/server/
COPY apps/tui/package.json apps/tui/
COPY apps/web/package.json apps/web/
COPY e2e/package.json e2e/
COPY packages/brain/package.json packages/brain/
COPY packages/client/package.json packages/client/
COPY packages/config/package.json packages/config/
COPY packages/hands/package.json packages/hands/
COPY packages/protocol/package.json packages/protocol/
COPY packages/session/package.json packages/session/
COPY packages/vault/package.json packages/vault/

# --- build: the workspace dependencies of the server and the web app, then their builds -------
FROM manifests AS build
# `openharness-monorepo` (the root) is in the list for turbo, which is the root's
# devDependency and what walks the build order — protocol, session, hands, client, brain,
# then server and web.
RUN yarn workspaces focus openharness-monorepo @openharness/server @openharness/web
COPY . .
RUN yarn turbo run build --filter='@openharness/server...' --filter='@openharness/web...'

# --- runtime: production dependencies, the built output, a non-root user ----------------------
FROM manifests AS runtime
RUN yarn workspaces focus --production @openharness/server
# The built output of everything the server loads at runtime, and the web app it serves at `/`.
# A workspace the server imports is resolved through `node_modules/@openharness/<name>`, whose
# `exports` point at `dist/` — so the `package.json` files above are part of the runtime too.
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/dist apps/web/dist
COPY --from=build /app/packages/brain/dist packages/brain/dist
COPY --from=build /app/packages/hands/dist packages/hands/dist
COPY --from=build /app/packages/protocol/dist packages/protocol/dist
COPY --from=build /app/packages/session/dist packages/session/dist
COPY --from=build /app/packages/vault/dist packages/vault/dist
# The store finds its `.sql` files by walking up from its own built module — `dist/` then the
# package folder — so they have to sit beside `dist`, not only inside it.
COPY --from=build /app/packages/session/migrations packages/session/migrations

ENV NODE_ENV=production \
    PORT=3000 \
    OPENHARNESS_WEB_DIR=/app/apps/web/dist

EXPOSE 3000

# The `node` user the base image ships (uid 1000). Nothing in the image is written at runtime:
# the store is Postgres, and the static assets are read-only.
USER node

CMD ["node", "apps/server/dist/index.js"]
