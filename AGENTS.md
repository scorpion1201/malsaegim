# AGENTS.md

## Project Overview

This is a Next.JS 16 (App Router) + TypeScript + emotion styled project.

## Tech Stack

- Next.JS 16 (App Router)
- React 19.2
- TypeScript
- emotion styled
- CSS Modules

## Project Structure

- `docs/`: Architecture notes and decisions.
- `public/`: Static assets like images, icons, and fonts.
- `src/app/`: App Router routes, layouts, loading/error boundaries, and route handlers.
- `src/app/_components/`: Reusable UI components.
- `src/app/_lib/`: Framework-agnostic utilities and shared helpers.

## Commands

### Development
- Install deps: `yarn install`
- Build all code: `yarn build`
- Start dev server: `yarn dev`

### Linting & Type Checking
- Run type-checking: `yarn lint`

## Code style

- Use strict TypeScript (`strict: true` in tsconfig.json)
- Use single quotes for strings (`.prettierrc` config)
- Use arrow functional patterns where possible

## CSS Modules Rules

- Use `src/app/globals.css` only for resets, CSS variables, and truly global base styles

## Commit Policy

- Use Conventional Commits for every commit.
- Keep the subject line to the recommended length of 50 characters or less, and never exceed 75 characters.
- Use a multi-line Conventional Commit with a blank line after the subject and bullet points in the body:

```text
feat(lorem-ipsum): lorem ipsum dolor sit amet consectetur
 
- Lorem ipsum dolor sit amet, consectetur adipiscing elit
- Sed do eiusmod tempor incididunt ut labore et dolore magna
- Ut enim ad minim veniam, quis nostrud exercitation ullamco
- Duis aute irure dolor in reprehenderit in voluptate velit
- Excepteur sint occaecat cupidatat non proident sunt in culpa
```

## Do's and Don'ts

### Do's

- When adding a dependency, always check for the latest version and review its source/release notes for security issues before installing
- Keep `.env.example` updated when adding environment variables
- Prefer Server Components by default
- Add `'use client'` only when browser APIs, event handlers, local state, refs, or client-only hooks are required
- Keep Client Components as small as possible
- Keep app/globals.css minimal
- Keep shared types in the feature folder unless used globally
- Prefer explicit domain types
- Prefer `unknown` over `any` when the type is not yet known
- Keep commit messages concise and descriptive
- MUST use the `NEXT_PUBLIC_` prefix intentionally.
- Use the conventional commits (e.g., `feat: add new feature`, `fix: resolve bug`, `docs: update documentation`)
- PR descriptions should focus on what changed and why

### Don'ts

- Do NOT import server-only code into Client Components.
- Do NOT expose secrets or privileged server values to the client.
- Do NOT introduce global CSS unless necessary.
- Do NOT use global CSS for component-specific styling.
- Do NOT avoid `any`.
- Do NOT mark PRs as "ready for review" (`gh pr ready`) - leave PRs in draft mode and let the user decide when to mark them ready
- Do NOT start major implementation work without checking the relevant project guides.
- Do NOT commit `.env`, `.env.local`, `yarn.lock`, or secrets.
- Server-only environment variables MUST NOT use the `NEXT_PUBLIC_` prefix.
- Do NOT add new dependencies without a clear reason.
- Do NOT create new abstractions for one-off code
- Do NOT append a `Co-Authored-By` trailer (or any co-author/attribution footer) to commit messages.
- Do NOT edit `AGENTS.md` or `CLAUDE.md` without approval from the project maintainers.
- Do NOT commit `docs/superpowers` directory or any of its sub-directories.
- Do NOT end a written file with a trailing newline, so no blank line appears at EOF. The last line of content must also be the last byte. Files formatted by Prettier or rewritten by external tools are exceptions.