FROM node:22-alpine AS build
WORKDIR /app
COPY package.json yarn.lock* ./
RUN yarn install --frozen-lockfile
COPY . .
RUN yarn db:generate && yarn build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# The port the service listens on, and the one a reverse proxy must forward to.
# Without EXPOSE, Coolify has nothing to read and proxies to its own default
# (3000) while the service answers on 8100 - which is a 502 on every request,
# with a perfectly healthy container behind it.
ENV PORT=8100
EXPOSE 8100
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/prisma ./prisma
CMD ["node", "build/index.js"]
