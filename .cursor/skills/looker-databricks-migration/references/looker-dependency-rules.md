# Looker dependency rules

## Node types

| Type | Meaning |
|------|---------|
| `source` | Physical table/view |
| `transformation` | LookML file / transform anchor |
| `derived_table` | PDT / NDT / derived SQL |
| `looker_view` | LookML view |
| `semantic_field` | Dimension, measure, filter, parameter |
| `explore` | Explore contract |
| `consumer` | Dashboard, Look, schedule, API/embedded when known |
| `security_policy` | Access grants / row restrictions |
| `databricks_asset` | Existing target asset |

## Edge types

| Type | Meaning |
|------|---------|
| `builds_from` | View/derived builds from source |
| `depends_on` | Hard/soft structural dependency |
| `joins` | Explore join |
| `extends` | View extends |
| `refines` | View refinement (`view: +name`) |
| `consumes` | Consumer uses explore/field |
| `governed_by` | Security policy |
| `maps_to` | Source maps to Databricks asset |
| `includes_available` | LookML `include:` availability only |

## Evidence kinds

| Kind | Use |
|------|-----|
| `confirmed` | API / explicit explore metadata |
| `statically_inferred` | LookML structure |
| `runtime_observed` | Dashboard/Look/query usage |
| `availability_only` | `include:` without proven use |
| `unresolved` | Missing target |
| `dynamic` | Liquid / dynamic SQL |

**Never** treat `include:` as proof of runtime usage. Record
`includes_available` / `availability_only` unless another dependency proves use.

**Never** assume matching bare names are the same object. Resolve with project,
model, file, connection, schema, and object identity.

## Inventory coverage (as APIs allow)

Projects, models, files, explores, views, fields, joins, derived tables,
extends/refinements, access grants / user attributes / RLS, physical sources,
dashboards, Looks, schedules/deliveries (when available), embedded/API/recurring
consumers (when discoverable), usage/ownership/popularity (when available),
existing Databricks assets.

Unavailable metadata must be listed in `inventory.summary.unavailable`.

## Issues to detect

Cycles, orphans, unresolved references, dynamic SQL / Liquid, user-attribute
deps, many-to-many joins, fan-out risks, aggregate awareness, hidden/deprecated
fields, unsupported target behavior.

## Secrets

Never expose credentials, tokens, or secret values in inventory artifacts, logs,
graphs, or chat. Use `redactInventorySecrets` before write.
