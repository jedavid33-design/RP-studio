# Story RP Studio

A tiny mobile-first interactive-fiction frontend for GitHub Pages, with a Cloudflare Worker proxy to OpenRouter.

## What this prototype is trying to solve

The player character is *yours*. The system prompt explicitly tells the model never to write your character's dialogue, actions, thoughts, feelings, reactions, choices, or physical responses. The AI controls NPCs and the environment and must stop at a handoff point.

No model can be guaranteed to obey perfectly, so the UI also includes **Retry AI**. Later we can add a one-tap "You controlled my character" correction/regeneration button.

## Files

- `index.html` — mobile UI
- `style.css` — iPhone/iPad-friendly styling
- `app.js` — story state, local storage, prompts, API calls
- `worker/worker.js` — Cloudflare Worker that calls OpenRouter
- `worker/wrangler.toml` — Worker config

## 1. Create an OpenRouter API key

Create a key in your OpenRouter account. Do **not** put the key in GitHub or in `app.js`.

OpenRouter uses the OpenAI-style chat completions endpoint.

## 2. Deploy the Cloudflare Worker

From the `worker` folder:

```bash
npm install -g wrangler
wrangler login
wrangler secret put OPENROUTER_API_KEY
wrangler secret put APP_PASSWORD
wrangler deploy
```

Choose any private app password you want when Wrangler asks for `APP_PASSWORD`.

Cloudflare recommends storing API keys as Worker **secrets**, not plaintext variables.

After deploy, copy the Worker URL, e.g.:

`https://story-rp-worker.YOUR-SUBDOMAIN.workers.dev`

## 3. Deploy the frontend to GitHub Pages

Upload `index.html`, `style.css`, and `app.js` to a repository and enable GitHub Pages.

Open the site, tap **⚙︎**, and enter:

- Worker URL
- App password
- Model ID

For the very first test, leave the model as `openrouter/free`. Once everything works, use OpenRouter's current role-play model collection to pick a specific model and paste its exact model ID into Settings.

## 4. Lock CORS after you know your Pages URL

In `worker/wrangler.toml`, uncomment/set:

```toml
[vars]
APP_URL = "https://YOURNAME.github.io/story-rp-studio/"
ALLOWED_ORIGIN = "https://YOURNAME.github.io"
```

Then redeploy the Worker.

## About mature/adult fictional role-play

The frontend does not impose a PG-13 filter. The actual model/provider you choose still has its own terms, safety behavior, and content rules. Pick a model/provider whose rules match what you want to write rather than trying to bypass a model's restrictions.

## Good next upgrades

1. Story library / multiple saved scenarios
2. Character portraits and cover art
3. Separate NPC speech and narration cards
4. "You hijacked my character" one-tap retry
5. Auto-summary / long-term memory
6. Branching / rewind points
7. Export story to Markdown/EPUB
8. Model cost tracker from API usage
