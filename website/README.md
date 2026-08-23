# Z documentation website

This is the static public documentation site for Z, built with Astro Starlight.
It is intentionally a self-contained package so Cloudflare Pages can use
`website/` as its monorepo root.

## Local development

```sh
cd website
bun install
bun run dev
```

Build the static site with:

```sh
bun run build
```

The output is written to `website/dist/`.

## Cloudflare Workers Static Assets

Cloudflare's current repository-import flow deploys static sites through Workers
Builds. Use these settings for the connected GitHub repository:

| Setting | Value |
| --- | --- |
| Project name | `z-lang-docs` |
| Root directory | `website` |
| Build command | `bun run build` |
| Deploy command | `npx wrangler deploy` |
| Environment variable | `BUN_VERSION=1.3.14` |

The asset directory and custom 404 behavior live in `wrangler.jsonc`, so there
is no separate dashboard output-directory field. No Worker script, databases,
secrets, or runtime bindings are required; the deployment contains only static
assets.
