# Back to Alpine — the last base that deployed cleanly on Render (Debian
# slim deploys all failed Render's health check with the app verifiably
# listening; root cause unresolved, Alpine is the known-good baseline).
# AppMaker's JDK/SDK are NOT baked in; they're provisioned at runtime to
# the persistent volume on first use — see lib/appmaker.js ensureSdk().
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
# data/ (SQLite + AppMaker debug keystore) and uploads/ (APKs) must persist —
# mount a volume in production
VOLUME ["/app/data", "/app/uploads"]
EXPOSE 3000
CMD ["node", "server.js"]
