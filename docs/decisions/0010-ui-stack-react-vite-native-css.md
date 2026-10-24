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
| Vite | 8.3.5 | Preferred; run with `bunx --no-install --bun vite` |
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
- **Open question (T8):** the accessibility audit tool (plan §M row T8).

## Alternatives considered

- Tailwind, shadcn/ui, or any CSS framework: rejected by the maintainer (DF-2; tracker L3 point 2).
- `@pixi/react`: not needed; PixiJS stays imperative and only draws the universe (plan §D, DF-3,
  O-5).
- Pixi drawing interface elements: rejected; React manages every interface (DF-3; tracker L3
  point 3).
- Bun's full-stack dev server instead of Vite: still marked "work in progress" (plan §D).

## References

- Plan: DF-2, DF-3, §D, §E.6, §M, O-4, O-5, §N.
- Tracker `docs/roadmap/v0.1-tracker.md`: L3 points 2 and 3.
- [Interfaces architecture](../architecture/interfaces.md).
