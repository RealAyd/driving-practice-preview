FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY dist-sim ./dist-sim
COPY server/dist ./server/dist
COPY server/packs.json ./server/packs.json
USER node
CMD ["npm", "run", "start:server"]
