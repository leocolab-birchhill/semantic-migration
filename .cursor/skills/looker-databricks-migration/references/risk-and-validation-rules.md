# Risk and validation rules

## Graph presentation

- Small environment: full Mermaid `flowchart LR` or `TD` in chat
- Large environment: domain summary Mermaid + per-component Mermaid + path to
  `tmp-debug/dependency-graph.json`
- Include node-type labels, labeled edges, component subgraphs, shared
  foundations, external/deferred deps, short legend

## Acceptance tests

Every proposed component manifest **must** include concrete
`acceptance_tests` (description + tolerance). Empty tests fail atomicity
validation.

## Ordinal risk scoring

Use `low` / `medium` / `high` only — no fake numerical precision.

Elevate risk when:

- Many-to-many / fan-out joins
- Liquid / dynamic SQL / user attributes
- Hard cycles (even if merged)
- Missing owners
- Low data readiness (no Databricks assets)
- Explore-retirement of a large unused field surface

## Approval checkpoint

Before any `cli:discover` / `cli:draft` / `cli:deploy`:

Ask which components to **approve**, **change**, **merge**, **split**, or
**defer**. Do not begin migration automatically.

## Parity remains the execution gate

Planning approval ≠ production readiness. After drafting:

1. Immutable Looker benchmarks
2. Deterministic comparator
3. `cli:parity` mandatory tiles green
4. Human `cli:publish --confirm`
