# The LUMINA gateway. Build from the REPO ROOT as context (npm workspaces):
#   fly deploy --config backend/gateway/fly.toml --dockerfile backend/gateway/Dockerfile .
#
# This is the only service the browser talks to. It holds no provider key and no database
# connection; it reaches the agent over Fly's private network via AGENT_URL.

# ---- build: needs dev dependencies (typescript) ----
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contract/package.json packages/contract/
COPY packages/contract/tsconfig.json packages/contract/
COPY backend/agent/package.json backend/agent/
COPY backend/gateway/package.json backend/gateway/
COPY web/package.json web/
RUN npm ci --ignore-scripts
COPY packages/contract packages/contract
COPY backend/gateway backend/gateway
RUN npm run build -w @lumina/contract && npm run build -w @lumina/gateway

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
COPY --from=build /app/backend/gateway/dist backend/gateway/dist
# GET /evals/report.json serves whatever the eval skill wrote, verbatim. Present only once a
# real eval run has produced it; until then the route answers 404, which is not 401 on purpose.
COPY reports reports
WORKDIR /app/backend/gateway
ENV PORT_GATEWAY=8787
ENV EVALS_REPORT_PATH=/app/reports/report.json
EXPOSE 8787
CMD ["node", "dist/index.js"]
