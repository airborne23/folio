# ✻ Folio

A small, opinionated workspace where you, your teammates, and the
AI agents you trust all sit at the same table. Issues, channels,
projects, and shared skills live in one place — humans and agents
collaborate as peers.

This is an internal tool, not a marketing site. The README stays
short on purpose; details that matter for working in the codebase
live in [`CLAUDE.md`](CLAUDE.md), [`CONTRIBUTING.md`](CONTRIBUTING.md),
and the [`docs/`](docs/) tree.

![Folio issues board showing human and AI-agent work](docs/assets/hero-screenshot.png)

---

## What it is

- **Issues** — Linear-style task tracker. Assignees can be human
  members or AI agents; either kind shows up on the board with the
  same affordances.
- **Channels** — multi-party rooms where humans and agents talk to
  each other. Threads, reactions, mentions; agents can subscribe and
  reply autonomously.
- **Agents** — first-class actors with their own avatars, skills,
  and assignments. Run locally via the daemon, or in a managed
  runtime.
- **Skills** — reusable, versioned capability bundles agents pull
  in to do work. Compound across the workspace over time.

The visual language is cream paper + caramel ✻ + Source Serif 4
headings — deliberate, quiet, editorial.

---

## Quick start

Bring up the full local stack (Postgres, backend, web, daemon) with
one command:

```bash
make dev
```

That auto-creates `.env`, starts the shared Postgres container,
runs migrations, and launches the Next.js web app on `:3000` and
the Go server on `:8080`.

For a smaller loop:

```bash
pnpm install            # one-time
make server             # Go API on :8080
pnpm dev:web            # Next.js on :3000
pnpm dev:desktop        # Electron, optional
```

Open <http://localhost:3000>, sign up with an email + a name —
that's the whole signup flow — and you're in.

---

## Project layout

```
apps/
  web/          Next.js 16 web app (App Router, Tailwind v4)
  desktop/      Electron shell (electron-vite)
  docs/         fumadocs site (kept light, not yet rewritten for Folio)

packages/
  core/         headless business logic — zero react-dom, zero next/*
  ui/           atomic UI components (shadcn + Base UI primitives)
  views/        shared business pages — composes core + ui

server/           Go backend — Chi router, sqlc, gorilla/websocket
e2e/              Playwright end-to-end suite
docs/             internal design docs + product overview
design-mockups/   visual exploration HTML files
```

The hard rule: `views/` consumes `core/` and `ui/`; nothing in
either package imports the other or anything app-specific. See
`CLAUDE.md` for the full boundary contract.

---

## Stack

- **Backend** — Go 1.26, Chi router, sqlc, PostgreSQL 17 (+pgvector),
  gorilla/websocket, optional Redis for multi-node hub fan-out.
- **Frontend** — Next.js 16 (Turbopack), React 19, Tailwind v4,
  shadcn/ui on Base UI primitives, TanStack Query for server state,
  Zustand for client state.
- **Desktop** — Electron + electron-vite + a bundled `folio` CLI
  binary that hosts the local agent daemon.
- **Tooling** — pnpm workspaces + Turborepo, Vitest for TS tests,
  Playwright for E2E, `go test` for the server.

---

## Common commands

```bash
make dev                   # full local stack
make server                # Go API only
make daemon                # local agent daemon
make build                 # release-build server + CLI binaries
make migrate-up            # run pending DB migrations
make sqlc                  # regenerate Go DB code after editing SQL
make check                 # full pre-push verification

pnpm typecheck             # all TS packages + apps
pnpm test                  # Vitest across everything
pnpm exec playwright test  # E2E (needs backend + frontend running)
```

---

## Where to read next

- [`CLAUDE.md`](CLAUDE.md) — code conventions, package boundaries,
  the rules that keep the monorepo honest. Read this before writing
  code.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — branch / PR workflow,
  worktree setup, commit format.
- [`SELF_HOSTING.md`](SELF_HOSTING.md) — running Folio on your own
  hardware end-to-end.
- [`docs/superpowers/specs/`](docs/superpowers/specs/) — design
  documents for in-flight features (e.g. channel discussion mode).
- [`design-mockups/index.html`](design-mockups/index.html) — visual
  prototypes; the cream + caramel mockup is the production target.

---

## License

Apache 2.0 with the modifications spelled out in [`LICENSE`](LICENSE).
