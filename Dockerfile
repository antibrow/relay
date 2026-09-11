FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY .npmrc package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production DB_PATH=/data/relay.db
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
VOLUME /data
EXPOSE 8899
CMD ["node", "dist/cli.js", "serve"]
