# ---- Build ----
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json tsconfig.json ./
RUN npm ci

COPY src/ ./src/
RUN npm run build

# ---- Runtime ----
FROM node:22-alpine AS runner
WORKDIR /app

RUN addgroup --system --gid 1001 fusion && \
    adduser --system --uid 1001 fusion

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

USER fusion
ENV NODE_ENV=production

EXPOSE 4040

CMD ["node", "dist/index.js"]
