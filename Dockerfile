# Use the official Puppeteer image which bundles Chromium + all deps
FROM ghcr.io/puppeteer/puppeteer:22.10.0

WORKDIR /usr/src/app

# Puppeteer image runs as non-root user "pptruser" by default — fine for npm install
COPY package*.json ./
RUN npm install --omit=dev

COPY index.js ./

ENV PORT=3000
EXPOSE 3000

CMD ["node", "index.js"]
