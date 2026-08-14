# The media server is latency-critical and region-pinned, so it runs as a plain
# long-lived Node process rather than anything serverless. Two stages: build the
# TypeScript, then ship only the runtime and the compiled output.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Audio frames arrive every 20 ms; a GC pause longer than that is audible.
ENV NODE_OPTIONS=--max-semi-space-size=64
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
EXPOSE 8080
CMD ["node", "dist/index.js"]
