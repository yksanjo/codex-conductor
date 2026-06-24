# Conductor — landing page

Self-contained static landing page (one `index.html`, inline CSS, zero build, zero
dependencies, no images — the cockpit is rendered in CSS).

Modeled on the bicameral-ai.com structure: hero → live cockpit mock → stats → the
problem → the irreversibility gate → three surfaces → adapter table → local-first
security → two-way get-started → FAQ.

## Preview locally

    open site/index.html          # or: python3 -m http.server -d site 8088

## Deploy

Cloudflare Pages (same flow as the other yksanjo sites):

    npx wrangler pages deploy site --project-name=conductor --branch=main

GitHub Pages: point Pages at `/site` on the default branch, or copy to `/docs`.
