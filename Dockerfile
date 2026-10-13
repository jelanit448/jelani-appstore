# node:24-slim (Debian/glibc) — NOT alpine. (Alpine's musl is fine for the
# store itself, but AppMaker's Android build-tools are glibc binaries.)
# NOTE: SDK/JDK are NOT baked into the image (that broke Render's health
# check). AppMaker downloads them at runtime to the persistent volume on
# first use — see lib/appmaker.js ensureSdk().
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
# data/ (SQLite + AppMaker debug keystore) and uploads/ (APKs) must persist —
# mount a volume in production
VOLUME ["/app/data", "/app/uploads"]
EXPOSE 3000
CMD ["node", "server.js"]
