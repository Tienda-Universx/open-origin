# Open Origin

Open Origin is an open-source, persistent AI-powered universe where autonomous beings and humans
coexist, evolve, explore consciousness, develop civilizations, and discover the nature of their
reality.

> **Status: pre-alpha.** The repository is being bootstrapped (batch T1 of the v0.1 roadmap).
> Nothing is deployed yet.

## Principles

- **The engine is reality.** A deterministic, authoritative simulation engine owns the world state.
- **AI proposes, the engine decides.** Language models suggest intentions; outcomes always come from
  the world's rules, never from a model.
- **Science without shortcuts.** Knowledge carries provenance, observation never changes behavior,
  and no claim of consciousness is made without evidence.
- **Works without AI.** The world runs fully with deterministic minds; AI providers are optional and
  off by default.

## Quickstart

Requirements: [Bun](https://bun.com) 1.4.4 (pinned in `package.json`).

```sh
bun install
bun run check   # typecheck + lint + tests
```

## Documentation

| Document | Description |
|---|---|
| [AGENTS.md](AGENTS.md) | Rules for contributors and AI agents |
| [docs/decisions/](docs/decisions/) | Architecture Decision Records |
| [docs/architecture/](docs/architecture/) | Technical architecture |
| [docs/roadmap/](docs/roadmap/) | Approved v0.1 plan and batch tracker (Spanish) |
| [docs/vision/](docs/vision/) | Original master vision (Spanish) |

## License

[GNU Affero General Public License v3.0](LICENSE). If you run a modified version as a network
service, you must offer its source code to its users (AGPL section 13).

---

## En español

Open Origin es un universo persistente y de código abierto donde seres autónomos y personas
conviven, evolucionan, exploran la conciencia, desarrollan civilizaciones y descubren la naturaleza
de su realidad.

**Estado: pre-alfa.** Se está construyendo la base del repositorio (tanda T1 de la hoja de ruta
v0.1). Todavía no hay nada desplegado.

- El motor de simulación es la única fuente de verdad; la IA solo propone.
- El mundo funciona completo sin IA; los proveedores de IA son opcionales y vienen apagados.
- Para empezar: `bun install` y `bun run check` (requiere Bun 1.4.4).
- La visión original y el plan aprobado están en `docs/vision/` y `docs/roadmap/`.

Licencia: AGPL-3.0.
