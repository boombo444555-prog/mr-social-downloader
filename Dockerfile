FROM node:22-bookworm-slim
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends python3 ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
RUN python3 -m pip install --no-cache-dir --break-system-packages yt-dlp
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY public ./public
COPY src ./src
ENV PORT=3000
EXPOSE 3000
USER node
CMD ["npm","start"]
