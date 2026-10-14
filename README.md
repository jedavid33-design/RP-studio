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

## Spice Balance (v1.2.1)

Adjust the 🌶️ slider beneath the chat or in Edit story. The default is 30% spice / 70% story. The 0–100% control guides longer-term pacing, not explicitness or a per-turn quota; it must not interrupt an unfolding scene or override consent, current user instructions, or the player-character agency firewall. The preference is saved independently with each story, so local backups and encrypted cloud sync preserve it. Existing stories without this setting default to 30%.

## Rewind to Here (v1.2.2)
Every earlier player or AI message has **⏪ Rewind to here**. After confirmation, it preserves the selected message and shortens the active timeline. Before doing so, the app atomically saves the original messages, scenario, continuity memory, learned corrections, and current draft as a snapshot in **Story library → Rewind snapshots**. If local storage cannot retain the snapshot, nothing is rewound. No OpenRouter request is made.

Continuity memory that covers future events is reset, and story-specific learned corrections are cleared on the rewound branch to avoid referring to erased future events. Built-in player-character agency protection is preserved.

**Restore as new story** recreates the original timeline in a separate story without overwriting the edited branch or deleting the snapshot. Snapshots are included in JSON backups and encrypted cloud sync, including across devices. Pre-v1.2.2 backups still import.

## v1.2.3: Agency repair refinement

The system now repeats a short NPC-only handoff rule, and both the Hands Off and Repair paths include an excerpt from the rejected reply to tell the model what not to imitate. Repair temperature is limited to 0.4. Additional named-player expressions are detected before saving. No new automatic calls or Worker change.

## v1.2.4: Import structured ChatGPT story blueprints

The Story Library has **Import story blueprint**, which creates a new empty story (without replacing previous sessions) from a version-1 RP Studio JSON file. In **Edit story**, **Import writing block (.json)** fills only the supplied fields of the unsaved Story Setup form, with confirmation before applying and another Save story action before writing changes. Blocks can choose "apply":"append" to add to existing text fields. No code from the file is evaluated.

JSON schema:
`{"app":"RP Studio","kind":"story-blueprint","formatVersion":1,"name":"Name","fields":{"title":"...","playerName":"...","playerNotes":"...","npcNotes":"...","premise":"...","styleNotes":"...","boundaryNotes":"...","spiceBalance":30}}`.
For reusable parts use `"kind":"story-block"` with a subset of fields, optionally `"apply":"append"` or `"apply":"replace"`.
The parser rejects unknown keys, files over 128 KB, and text fields over 30,000 characters. The library's ordinary backup import remains separate. No Worker update required.

## v1.2.5: Connection secret recovery

The Connection dialog now has a **Show/Hide** toggle and **Copy** button for the saved Worker app password, and a Show/Hide toggle for the existing private cloud sync code. Secrets are revealed only locally, hidden when the dialog closes or the app backgrounds, and never included in story backups. Clipboard copying is a direct user action; clipboard contents may remain readable by apps until replaced or cleared. Save secrets in a trusted password manager; do not share screenshots with revealed values.


## v1.2.6: iOS cloud-sync backup-navigation fix

**Connect & download no longer starts an automatic JSON file download.** On iOS, programmatically downloading a pre-connect backup opened the system file preview and could interrupt the same sync flow with a generic “Load failed” network error.

After successfully fetching and decrypting the cloud copy, RP Studio automatically stores a copy of the iPad's original local story library under the separate browser key `rp.preConnectRecovery.v1`, before replacing the library. This key is not included in encrypted cloud payloads, not overwritten by retries, and preserved across a story-library replacement. **Story Library → Export pre-connect recovery** lets users explicitly download that locally stored copy later.

If saving the recovery copy fails (for example, browser storage quota), connection aborts without applying the remote library. Network fetch failures now offer a specific non-secret explanation. No Worker changes and no extra API calls.

## v1.2.7: Blueprint opening scenes

Full story blueprints may include an optional top-level `"openingScene":"..."` string in addition to `"fields"`. When present, **Import story blueprint** creates a separate new story with the opening scene already displayed as its first AI/NPC message, ready for the player character's first response. The opening is not generated by a model, so no API request is made and no player actions are authored automatically. Existing stories and transcripts are left alone. Blueprints without an opening continue to import as empty stories; writing-block imports cannot add opening scenes.

The `openingScene` value must be nonempty text of at most 10,000 characters, and the file must remain 128 KB or smaller. Existing formatVersion 1 blueprints remain compatible. No Worker update required.
