# AI Business OS server image.
#
# Build context is the REPO ROOT, not apps/server, because the server imports
# the workspace packages in packages/. From the repo root:
#
#   docker build -f apps/server/deploy/Dockerfile -t abos-server .
#
# The server runs TypeScript through tsx. There is no build step.
# No .env file is ever copied in: values come from the host's variable settings.
# The root .dockerignore keeps .env*, node_modules, .git and apps/web out of the context.

FROM node:24-slim

WORKDIR /app

# 1. Workspace manifests and the lockfile first, so the dependency layer is
#    cached until one of them changes. Every workspace manifest is copied so
#    npm ci sees the same workspace list as package-lock.json, but only the
#    server workspace and the root (which holds tsx) are installed.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json

# Dev dependencies are needed: tsx (root devDependency) runs the server.
# NODE_ENV is set only after this step, so npm ci does not drop them.
RUN npm ci --workspace @abos/server --include-workspace-root --no-audit --no-fund \
 && npm cache clean --force

# 2. Source for the server and the shared packages it imports.
COPY tsconfig.base.json ./
COPY apps/server apps/server
COPY packages/contracts packages/contracts
COPY packages/db packages/db

ENV NODE_ENV=production \
    PORT=4000

# The official image ships a non-root user named "node".
RUN chown -R node:node /app
USER node

# Documentation only. The process listens on 0.0.0.0:$PORT.
EXPOSE 4000

# The slim image has no curl, so the check uses Node's built-in fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "start", "-w", "@abos/server"]
