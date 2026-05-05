FROM node:20-alpine AS builder

WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:20-alpine

WORKDIR /app
RUN apk add --no-cache python3 make g++
RUN addgroup -S bot && adduser -S bot -G bot

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY public/ ./public

RUN mkdir -p /app/data && chown -R bot:bot /app
USER bot

ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=256"

EXPOSE 3000

VOLUME ["/app/data"]

HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=5 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/api/health',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>process.exit(r.statusCode===200?0:1))}).on('error',()=>process.exit(1))"

CMD ["node", "dist/main.js"]
