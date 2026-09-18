# The LUMINA agent service. Build from the REPO ROOT as context (npm workspaces):
#   fly deploy --config backend/agent/fly.toml --dockerfile backend/agent/Dockerfile .
#
# This image holds the provider keys, so it is deployed without a public service: only the
# gateway reaches it, over Fly's private network.

# ---- build: needs dev dependencies (typescript) ----
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contract/package.json packages/contract/
COPY backend/agent/package.json backend/agent/
COPY backend/gateway/package.json backend/gateway/
COPY web/package.json web/
RUN npm ci --ignore-scripts
COPY packages/contract packages/contract
COPY backend/agent backend/agent
RUN npm run build -w @lumina/contract && npm run build -w @lumina/agent

# ---- runtime: production dependencies only ----
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/contract/package.json packages/contract/
COPY backend/agent/package.json backend/agent/
COPY backend/gateway/package.json backend/gateway/
COPY web/package.json web/
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/packages/contract/dist packages/contract/dist
COPY --from=build /app/backend/agent/dist backend/agent/dist
# The run-log adapter writes runs/<requestId>.json next to the workspace root; a deployed
# instance also mirrors them into Mongo (RUNS_TO_MONGO), which is what export:runs reads.
RUN mkdir -p /app/runs
WORKDIR /app/backend/agent
ENV PORT_AGENT=8000
EXPOSE 8000
CMD ["node", "dist/index.js"]
