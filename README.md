# USACC Website

Static Astro website for the US Anti-Corruption Court (`USACC`) nonprofit project, designed for GitHub Pages and a client-side Google Apps Script signup flow.

## What is included

- A civic-issue landing page with sections for mission, who we are, design, details, platform, and support
- A companion framework page that turns the provided whitepaper and draft plan into a readable public brief
- A static email signup form that posts directly from the browser to a Google Apps Script web app
- A GitHub Pages deployment workflow

## Local setup

```bash
pnpm install
cp .env.example .env
pnpm dev
```

Environment variables:

- `PUBLIC_SIGNUP_ENDPOINT`: the deployed Google Apps Script web app URL
- `PUBLIC_SIGNUP_SOURCE`: optional label written alongside each signup
- `SITE_URL`: canonical site URL used by Astro
- `BASE_PATH`: GitHub Pages base path, usually `/<repo-name>` for project pages and `/` for a custom domain

## Google Apps Script

The signup form uses a browser-side `fetch()` POST with `mode: "no-cors"` and `URLSearchParams` so it can submit cleanly to a standard Apps Script web app without introducing a server. Because the response is opaque in `no-cors` mode, the UI treats a dispatched request as success unless the browser reports a network failure.

An example Apps Script is included in [docs/google-apps-script.gs](/Users/maca5/codes/ores/us-anti-corruption-court-project/docs/google-apps-script.gs:1).

Typical setup:

1. Open Google Apps Script and create a new project.
2. Paste in the sample script.
3. Attach the script to the spreadsheet that should collect signups.
4. Deploy it as a web app with access set to `Anyone`.
5. Copy the deployment URL into `PUBLIC_SIGNUP_ENDPOINT`.

## GitHub Pages deployment

The workflow in [.github/workflows/deploy.yml](/Users/maca5/codes/ores/us-anti-corruption-court-project/.github/workflows/deploy.yml:1) builds and deploys the site using GitHub Actions.

Repository variables to set in GitHub:

- `PUBLIC_SIGNUP_ENDPOINT`
- `PUBLIC_SIGNUP_SOURCE` (optional)
- `SITE_URL` if you are using a custom domain
- `BASE_PATH` if you are not using the default `/<repo-name>` path

For a normal GitHub Pages project site:

- `SITE_URL`: `https://<github-user-or-org>.github.io`
- `BASE_PATH`: `/<repository-name>`

For a custom domain:

- `SITE_URL`: your public domain
- `BASE_PATH`: `/`

Then set Pages to deploy from GitHub Actions and push the repository.
