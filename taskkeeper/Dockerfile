# Dayline — Task Keeper
# Simple single-container deployment.
#   docker build -t dayline .
#   docker run -p 4000:4000 -v dayline-data:/app/backend/data dayline
# Tasks + subscriber list live in /app/backend/data (persist it as a volume).

FROM node:20-alpine

WORKDIR /app

# Install dependencies first (better layer caching).
COPY backend/package.json backend/package-lock.json* ./backend/
RUN cd backend && npm install --omit=dev

# Copy the rest of the app (backend + frontend).
COPY . .

ENV NODE_ENV=production \
    PORT=4000

EXPOSE 4000

VOLUME ["/app/backend/data"]

CMD ["node", "backend/server.js"]