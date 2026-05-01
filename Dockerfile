# --- Build stage ---
FROM node:22-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# --- Runtime stage ---
FROM node:22-slim

WORKDIR /app

# Install system deps for USB serial access
RUN apt-get update && \
    apt-get install -y --no-install-recommends udev usbutils && \
    rm -rf /var/lib/apt/lists/*

# Copy built frontend + server source + deps
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server ./server
COPY --from=builder /app/package.json ./
COPY --from=builder /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules

# The Express server serves both the API and the built frontend
EXPOSE 3001

CMD ["node", "--import", "tsx", "server/api.ts"]
