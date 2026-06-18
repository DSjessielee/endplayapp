# Deployment Guide — Bridge DDS Web App

Split architecture: 3 free services working together.

```
┌─────────────────────┐     ┌──────────────────────┐     ┌─────────────────────┐
│  Cloudflare Pages   │     │  Cloudflare Worker    │     │  Render (free)      │
│  (static frontend)  │────▶│  (Claude API proxy)   │     │  (DDS solver API)   │
│  FREE               │     │  FREE (100K req/day)  │     │  FREE (spins down)  │
└─────────────────────┘     └──────────────────────┘     └─────────────────────┘
     index.html              image → Claude Haiku          hands → DDS results
     config.js               ~$0.002/image                 Python + endplay
```

## Step 1: Deploy DDS API to Render

1. Push this repo to GitHub
2. Go to render.com → New → Web Service
3. Connect your GitHub repo
4. Settings:
   - **Name**: bridge-dds-api
   - **Root Directory**: (leave blank)
   - **Build Command**: `pip install -r webapp/api/requirements.txt && pip install .`
   - **Start Command**: `cd webapp/api && gunicorn app:app --bind 0.0.0.0:$PORT`
   - **Plan**: Free
5. Deploy → note the URL (e.g. `https://bridge-dds-api.onrender.com`)

## Step 2: Deploy Cloudflare Worker

1. Install wrangler: `npm install -g wrangler`
2. Login: `npx wrangler login`
3. Set your API key:
   ```
   cd webapp/worker
   npx wrangler secret put ANTHROPIC_API_KEY
   ```
   (paste your sk-ant-... key when prompted)
4. Deploy:
   ```
   npx wrangler deploy
   ```
5. Note the URL (e.g. `https://bridge-dds-worker.YOUR-SUBDOMAIN.workers.dev`)

## Step 3: Deploy Frontend to Cloudflare Pages

1. Edit `webapp/frontend/config.js` with your URLs from steps 1 and 2
2. Go to dash.cloudflare.com → Pages → Create a project
3. Connect to Git → select your repo
4. Settings:
   - **Build command**: (leave blank)
   - **Build output directory**: `webapp/frontend`
5. Deploy → your site is live at `your-project.pages.dev`

## Costs

| Service | Cost |
|---------|------|
| Cloudflare Pages | Free |
| Cloudflare Worker | Free (100K requests/day) |
| Render | Free (spins down after 15min idle) |
| Claude API (Haiku) | ~$0.002/image (~500 images per $1) |

Total: **$0/month** + Claude API usage for image uploads.

## Notes

- Render free tier spins down after 15 minutes of inactivity. First request after idle takes ~30 seconds.
- Image upload requires a funded Anthropic API key.
- Manual card entry + DDS analysis works without any API key.
