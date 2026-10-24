# 0010. UI stack: React, Vite, native CSS, and an in-house design system

- Status: Accepted
- Date: 2026-10-24

## Context

Both interfaces ([0009](0009-public-and-private-admin-interfaces.md)) need a consistent,
reusable, accessible, and responsive visual system. The maintainer decided (plan DF-2): React +
Vite + native CSS + CSS Modules + CSS Variables; no Tailwind, no shadcn/ui, no CSS frameworks; an
in-house visual system. And (DF-3): PixiJS only represents the interactive universe; React manages
every interface. Vite treats `*.module.css` files as CSS Modules without plugins (plan §D).

## Decision

We will build both apps with React and Vite, styled with native CSS, CSS Modules, and CSS custom
properties, through an in-house design system in `packages/ui` (plan §E.6).

| Component | Version (plan §D) | Notes |
|---|---|---|
| React | 19 | Both interfaces |
| Vite | 8.3.5 | Preferred; run with `bunx --bun vite`. Bun's full-stack dev server is still "work in progress" |
| PixiJS | 8.22.0 | Universe only; `pixi-viewport` 6.0.3 supports v8; `@pixi/react` is not needed |
| Tailwind, shadcn/ui, CSS frameworks | — | Not used |

Design system `packages/ui`:
- **Tokens** (`tokens.css`): semantic color (surfaces, text, accent, states), typography, spacing,
  radii, shadows, and motion. Light and dark themes with `prefers-color-scheme` and `data-theme`.
- **Atomic design**: tokens → primitives (Button, Input, Badge) → composites (Field, Card, Table)
  → patterns (Sidebar, Inspector, DataTable).
- **Container-presentational**: `ui` components are presentational (props, no fetch); data
  containers live in each app.
- **Native HTML first**: `<dialog>`, `popover`, `<details>`, native forms.
- **Accessibility**: WCAG 2.2 AA target, visible focus, full keyboard operation,
  `prefers-reduced-motion`, verified contrast.
- **Responsive**: mobile-first, with container queries where they help.
- Shared by both apps, so the visual identity is consistent.

PixiJS and React (DF-3):
- Pixi draws only the universe: terrain, entities, day/night, camera.
- It mounts inside a React boundary component and never draws UI (buttons, panels, interface text).
- React and Pixi communicate through a view store and typed events (inhabitant selection, camera).
- The admin panel has no Pixi in v0.1; if it needs a map, it will reuse the renderer extracted to a
  package.

## Consequences

- No utility-class or component framework to lean on: tokens and components are ours to maintain.
- Plan §N criterion 20 (only `packages/ui`, no CSS framework dependencies, full keyboard operation,
  `prefers-reduced-motion`, light/dark theme) and criterion 21 (PixiJS imported only in the
  universe module of `apps/web`, import test) verify it.
- T8 delivers three chained PRs: `packages/ui` → `apps/web` → `apps/admin`.
- Pending: the accessibility audit tool is decided in T8 ([D] in plan §M).

## References

- Plan: DF-2, DF-3, §D, §E.6, §M, O-4, O-5, §N.
- [Interfaces architecture](../architecture/interfaces.md).
