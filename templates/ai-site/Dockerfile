# The site as a Node server. Build from the workspace root, which holds the packages it depends on:
#   docker build -f templates/ai-site/Dockerfile --build-arg SITE=templates/ai-site -t ai-site .
# compose.yaml does this for you. Secrets are never in the image: .dockerignore keeps .env files out of the build context, and the
# container gets its settings from the environment at run time.

FROM node:24-slim AS build
RUN corepack enable
WORKDIR /repo
COPY . .
ARG SITE=templates/ai-site
RUN pnpm install --frozen-lockfile
RUN pnpm --filter "./${SITE}" build
# The site with its production dependencies only, workspace packages included, in a directory of its own.
RUN pnpm --filter "./${SITE}" deploy --prod --legacy /app

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app ./
# The app runs as node: it owns /app (WORKDIR creates it as root) and .data, where STORAGE_DIR may point without an S3 bucket.
RUN mkdir -p /app/.data && chown node:node /app /app/.data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "start.mjs"]
