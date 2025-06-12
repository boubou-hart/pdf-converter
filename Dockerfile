# ---------- build stage ----------
FROM node:18-bookworm AS build
WORKDIR /app

# Install deps first to leverage cache
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# ---------- runtime stage ----------
FROM node:18-bookworm-slim

# Install LibreOffice, GraphicsMagick/ImageMagick, and necessary fonts
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      libreoffice-core libreoffice-writer libreoffice-calc libreoffice-impress \
      fonts-dejavu fonts-liberation \
      graphicsmagick imagemagick \
      ghostscript && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN useradd -ms /bin/bash appuser
WORKDIR /app

# Copy node_modules and source from build image
COPY --from=build /app /app

# Create uploads directory and change ownership to appuser
RUN mkdir -p /app/uploads && \
    chown -R appuser:appuser /app

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

USER appuser
CMD ["node", "index.js"] 