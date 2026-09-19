FROM python:3.11-slim

RUN apt-get update && apt-get install -y \
    curl \
    ffmpeg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && pip install --no-cache-dir -U --pre "yt-dlp[default]" \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.js ./

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
