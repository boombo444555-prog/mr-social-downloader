# MR Downloader

A container-based web app that streams public social videos directly to the requesting device. Downloaded media is not intentionally written to application storage.

## Status

First web-service implementation based on the original MR Downloader project. The original desktop app is Windows Forms/.NET and invokes external tools; it cannot be deployed unchanged to Cloudflare Workers. This version uses a container-based Node.js API and yt-dlp.

## Platforms

TikTok, Instagram, Facebook, X/Twitter, Pinterest, Reddit and Threads are allowlisted by default. Domain allowlisting does not guarantee every link works. Private posts, login walls, regional restrictions and platform changes can prevent extraction.

## Run with Docker

```bash
docker build -t mr-social .
docker run --rm -p 3000:3000 mr-social
```

Open http://localhost:3000. For local Node.js execution, install Node 20+ and yt-dlp, then run `npm install && npm start`.

## API

`POST /api/download` with JSON `{ "url": "https://www.tiktok.com/..." }`. Successful responses stream the media as an attachment; errors return JSON. `GET /api/health` returns service health.

## Deployment and safety

- Requires a container host that can run yt-dlp and FFmpeg. Cloudflare Workers alone cannot run this process model.
- Free container hosts may sleep, cap bandwidth/CPU, or change their free tiers; unlimited free usage is not guaranteed.
- The included in-memory rate limiter is per process and resets on restart. Add shared rate limiting before public launch.
- URL host validation is included, but a public deployment also needs outbound network restrictions/SSRF protection, concurrency and egress limits, and abuse monitoring.
- Set `TRUST_PROXY=1` only behind a trusted reverse proxy you control.
- Browser downloads may buffer data on the user's device. The application itself does not keep a media archive.
- Download only content you are authorized to save and follow platform terms.

## Next steps

Deploy the container API with HTTPS, then configure an iOS Shortcut to POST the shared URL to `/api/download` and save the response to Photos. Add integration tests and shared rate limiting before opening the service publicly.

## GitHub Actions + GitHub Container Registry

The workflow at `.github/workflows/docker-publish.yml` builds the Docker image on every push to `main` and publishes it to:

`ghcr.io/boombo444555-prog/mr-social-downloader:latest`

It also creates a commit-SHA image tag. Pull requests build the image without publishing it. The workflow uses the repository-provided `GITHUB_TOKEN`; no personal access token is required. Ensure Actions are enabled for the repository and the workflow has permission to write packages. After the first successful publish, set the container package visibility to Public in GitHub Packages if you want anyone to pull it without authenticating.

## Run the published image with Docker Compose

```bash
cp .env.example .env
docker compose pull
docker compose up -d
```

Then open `http://localhost:3000`. To update after a new image is published, run `docker compose pull && docker compose up -d`.
