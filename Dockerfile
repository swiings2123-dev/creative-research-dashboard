# Multi-stage Dockerfile for Product Video Discovery Dashboard

FROM node:22-slim AS backend-build
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm install --omit=dev
COPY backend/ ./

FROM node:22-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

FROM node:22-slim AS production
WORKDIR /app

# Install backend dependencies
COPY --from=backend-build /app/backend /app/backend
# Copy built frontend assets
COPY --from=frontend-build /app/frontend/dist /app/frontend/dist

# Expose backend port
EXPOSE 3001

ENV NODE_ENV=production
ENV PORT=3001

WORKDIR /app/backend
CMD ["node", "src/server.js"]
