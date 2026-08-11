# Atomic migration component methodology

> Inventory exhaustively; migrate selectively.

## Definition

An **atomic migration component** is the smallest independently deployable,
testable, and reversible semantic contract serving a coherent business use
case. It may depend on approved shared foundation components or existing
Databricks assets.

**Not** the default unit:

- A LookML file
- An individual source table
- An arbitrary connected subgraph

## Normal component root

Prefer an Explore, coherent Explore family, business workflow, or business
fact grain.

## Scope modes

### Consumer-parity

Include only fields, joins, transformations, policies, and sources required by
selected dashboards, Looks, schedules, and recurring workflows.

### Explore-retirement

Include the complete supported semantic contract exposed by an Explore,
including fields needed for expected ad hoc analysis.

Ask the human when the choice materially changes the plan. If unset, propose
both or make a clearly labeled recommendation.

## Boundary rules

### Place objects in the same component when hard-coupled

- Same primary business grain
- Measures/fields directly depend on each other
- Join or fan-out behavior must be validated together
- Inseparable security boundary
- Inseparable refresh / materialization lifecycle
- Cannot deploy or parity-test independently
- Form a cycle of hard semantic dependencies

### Split when

- Different fact grains
- Different business domains or owners
- Different security boundaries
- Different refresh / SLA expectations
- Independently deployable and testable
- Only connection is incidental reuse of a physical table
- Reuse occurs through a stable, well-defined interface

### Coupling classes

| Class | Meaning |
|-------|---------|
| `hard` | Migrate together or as an explicit prerequisite |
| `soft` | Reusable through a defined component interface |
| `incidental` | Shared source or naming only — do **not** group on this |

If hard dependencies cycle: merge into one component or require a prerequisite
that breaks the cycle.

## Traversal

1. Select root Explore / workflow
2. Select important consumers
3. Traverse **upstream** through required dependencies
4. Stop at existing Databricks assets or approved component interfaces
5. **Do not** traverse downstream into unrelated consumers merely because they
   share a source, view, or dimension
6. Record excluded and deferred objects explicitly

## Shared foundations

Propose a foundation only when repeated upstream logic has:

- Coherent business definition
- Stable interface
- Clear ownership
- Multiple genuine consumers
- Independent validation
- Reasonable reuse expectation

Examples: conformed customer dimensions, fiscal calendars, currency conversion,
shared security mappings, reusable transforms.

Do **not** create a foundation merely because of high graph centrality.

## Atomicity checks

A component is atomic only if it can be:

- Deployed independently
- Validated independently
- Rolled back independently
- Assigned an owner
- Given explicit inputs and outputs
- Protected by defined security behavior
- Measured against concrete parity / acceptance tests

Failing candidates: merge with a hard dependency or split at a stable interface.

## Prioritization (ordinal, not fake precision)

Score with `low` / `medium` / `high`:

- Business value, usage, data readiness, owner availability, testability
- Semantic complexity, unsupported features, security complexity
- Dependency burden, migration / rollback risk

### Waves (topological)

1. Source and transformation prerequisites
2. Shared foundation components
3. Business semantic components
4. Dashboards and other consumers

Recommend a first component that is valuable enough to prove the approach but
bounded enough to validate safely.

## Required manifest shape

```yaml
id: customer-order-analysis
name: Customer Order Analysis
business_domain: sales
scope_mode: consumer-parity
grain: one row per order

root_explores:
  - orders

selected_consumers:
  - executive_sales_dashboard
  - weekly_revenue_look

includes:
  views: []
  fields: []
  joins: []
  transformations: []
  security_policies: []

source_assets: []
target_assets: []
depends_on_components: []

excluded: []
deferred: []
unresolved_dependencies: []

acceptance_tests:
  - description: Revenue matches by month and region
    tolerance: 0.1_percent

risks: []
owner: null
confidence: medium
rationale: ""
```

## Scripts

| Command | Output |
|---------|--------|
| `npm run cli:inventory` | `tmp-debug/inventory.json`, `dependency-graph.json`, `.mmd` |
| `npm run cli:plan` | `tmp-debug/component-plan.yaml`, component `.mmd` files |

Libs: `lib/migration/env-inventory.ts`, `dependency-graph.ts`,
`component-planner.ts`, `graph-export.ts`, `component-manifest.ts`.
