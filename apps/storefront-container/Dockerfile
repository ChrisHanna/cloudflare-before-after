FROM node:22.23.1-alpine3.23@sha256:8516dce0483394d5708d4b2ee6cacb79fb1d617ea4e2787c2120bcca92ce372e AS build
WORKDIR /app
COPY . .
RUN npm exec --yes --package=pnpm@10.34.9 -- pnpm install --frozen-lockfile \
 && npm exec --yes --package=pnpm@10.34.9 -- pnpm exec tsc -p tsconfig.build.json
FROM node:22.23.1-alpine3.23@sha256:8516dce0483394d5708d4b2ee6cacb79fb1d617ea4e2787c2120bcca92ce372e
WORKDIR /app
ENV NODE_ENV=production \
    NODE_EXTRA_CA_CERTS=/etc/cloudflare/certs/cloudflare-containers-ca.crt
COPY --from=build /app/node_modules/.pnpm/hono@4.13.16/node_modules/hono ./node_modules/hono
COPY --from=build /app/node_modules/.pnpm/zod@4.6.7/node_modules/zod ./node_modules/zod
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY apps/storefront-container/test/container-check.mjs ./container-check.mjs
USER node
CMD ["node", "dist/apps/storefront-container/src/server.js"]
