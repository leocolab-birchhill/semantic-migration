import { describe, it } from "node:test";
import assert from "node:assert";
import { parse as parseYaml } from "yaml";
import {
  dollarQuote,
  normalizeMetricViewYaml,
  normalizeSqlViewBody,
  rewriteMetricViewSource,
  sanitizeGeneratedAssets,
  serializeYamlSqlScalars,
  sortAssetsForDeploy,
  stripCodeFences,
  validateMetricViewYaml,
} from "../lib/migration/deploy-normalize";
import type { ProposedAsset } from "../lib/migration/types";

describe("stripCodeFences", () => {
  it("removes sql fences", () => {
    assert.strictEqual(
      stripCodeFences("```sql\nSELECT 1\n```"),
      "SELECT 1"
    );
  });

  it("removes yaml fences", () => {
    assert.strictEqual(
      stripCodeFences("```yaml\nversion: 1.1\n```"),
      "version: 1.1"
    );
  });
});

describe("normalizeSqlViewBody", () => {
  it("strips CREATE OR REPLACE VIEW wrapper", () => {
    const sql = `CREATE OR REPLACE VIEW \`c\`.\`s\`.\`v\` AS WITH x AS (SELECT 1) SELECT * FROM x`;
    assert.strictEqual(
      normalizeSqlViewBody(sql),
      "WITH x AS (SELECT 1) SELECT * FROM x"
    );
  });

  it("strips unquoted three-part CREATE", () => {
    const sql =
      "CREATE OR REPLACE VIEW databricks_prd.dbt_production.vw_x AS SELECT 1 AS a";
    assert.strictEqual(normalizeSqlViewBody(sql), "SELECT 1 AS a");
  });

  it("leaves clean body alone", () => {
    assert.strictEqual(
      normalizeSqlViewBody("SELECT 1 AS a"),
      "SELECT 1 AS a"
    );
  });

  it("rejects non-query bodies", () => {
    assert.throws(() => normalizeSqlViewBody("DROP TABLE t"));
  });
});

describe("normalizeMetricViewYaml", () => {
  const yaml = `version: 0.1
source: cat.sch.tbl
dimensions:
  - name: account
    expr: account
measures:
  - name: cnt
    expr: count(1)`;

  it("accepts plain yaml", () => {
    const normalized = normalizeMetricViewYaml(yaml);
    assert.ok(normalized.startsWith("version:"));
    assert.ok(normalized.includes("expr: |-"));
  });

  it("quotes metadata scalars with inner colons (display_name / comment / synonyms)", () => {
    // Exact shape that crashed job dc564cff at generate.
    const risky = `version: 0.1
source: cat.sch.tbl
dimensions:
  - name: account
    expr: account
measures:
  - name: acv_match_excluded
    expr: SUM(x)
    display_name: Fct Tam Buildings ACV Matched: Excluded < 100k Sq Ft
    comment: Annualized revenue where match status is Matched: Excluded.
    synonyms:
      - ACV Matched: Excluded
      - plain synonym
`;
    const normalized = normalizeMetricViewYaml(risky);
    assert.ok(
      normalized.includes(
        'display_name: "Fct Tam Buildings ACV Matched: Excluded < 100k Sq Ft"'
      )
    );
    assert.ok(normalized.includes('- "ACV Matched: Excluded"'));
    assert.ok(normalized.includes("- plain synonym"));
    // Round-trips as valid YAML with strings, not nested mappings.
    const doc = parseYaml(normalized) as {
      measures: Array<{
        display_name: string;
        comment: string;
        synonyms: string[];
      }>;
    };
    assert.strictEqual(
      doc.measures[0].display_name,
      "Fct Tam Buildings ACV Matched: Excluded < 100k Sq Ft"
    );
    assert.strictEqual(typeof doc.measures[0].comment, "string");
    assert.deepStrictEqual(doc.measures[0].synonyms, [
      "ACV Matched: Excluded",
      "plain synonym",
    ]);
  });

  it("strips CREATE ... LANGUAGE YAML AS $$...$$", () => {
    const ddl = `CREATE OR REPLACE VIEW cat.sch.mv WITH METRICS LANGUAGE YAML AS $$\n${yaml}\n$$`;
    assert.ok(normalizeMetricViewYaml(ddl).startsWith("version:"));
  });

  it("strips single-quoted legacy AS wrapper", () => {
    const ddl = `CREATE OR REPLACE VIEW cat.sch.mv WITH METRICS AS '${yaml}'`;
    assert.ok(normalizeMetricViewYaml(ddl).startsWith("version:"));
  });

  it("strips markdown fences", () => {
    assert.ok(
      normalizeMetricViewYaml("```yaml\n" + yaml + "\n```").startsWith(
        "version:"
      )
    );
  });
});

describe("dollarQuote", () => {
  it("uses plain $$ delimiters with newlines", () => {
    assert.strictEqual(dollarQuote("version: 1.1"), "$$\nversion: 1.1\n$$");
  });

  it("rejects content that contains $$", () => {
    assert.throws(() => dollarQuote("x $$ y"));
  });
});

describe("rewriteMetricViewSource", () => {
  it("rewrites source when it references a job sql_view", () => {
    const yaml = `version: 1.1
source: other.prod.vw_base
dimensions:
  - name: a
    expr: a`;
    const out = rewriteMetricViewSource(yaml, "cat", "dev", ["vw_base"]);
    assert.ok(out.includes("source: cat.dev.vw_base"));
  });

  it("leaves unrelated sources alone", () => {
    const yaml = `version: 1.1
source: cat.sch.fct_table`;
    const out = rewriteMetricViewSource(yaml, "cat", "dev", ["vw_base"]);
    assert.strictEqual(out, yaml);
  });
});

describe("sortAssetsForDeploy", () => {
  it("orders sql_view before metric_view", () => {
    const assets: ProposedAsset[] = [
      {
        type: "metric_view",
        name: "m",
        schema: "s",
        description: "",
        yaml: "version: 1.1",
      },
      {
        type: "sql_view",
        name: "v",
        schema: "s",
        description: "",
        sql: "SELECT 1",
      },
    ];
    const ordered = sortAssetsForDeploy(assets);
    assert.strictEqual(ordered[0].type, "sql_view");
    assert.strictEqual(ordered[1].type, "metric_view");
  });
});

describe("serializeYamlSqlScalars", () => {
  it("converts CASE exprs with colon-bearing SQL strings to block scalars", () => {
    const yaml = `version: 1.1
source: cat.sch.tbl
dimensions:
  - name: bucket
    expr: CASE WHEN customer_match_status = 'Matched: Excluded < 20k Sq Ft' THEN customer_match_status ELSE 'Other' END
measures:
  - name: cnt
    expr: count(1)`;
    const out = normalizeMetricViewYaml(yaml);
    assert.ok(out.includes("expr: |-"));
    assert.ok(
      out.includes(
        "CASE WHEN customer_match_status = 'Matched: Excluded < 20k Sq Ft' THEN customer_match_status ELSE 'Other' END"
      )
    );
    // Simple expressions are serialized the same safe way.
    assert.ok(out.includes("    count(1)"));
  });

  it("leaves already-block and already-quoted exprs alone", () => {
    const yaml = `version: 1.1
source: cat.sch.tbl
dimensions:
  - name: a
    expr: |-
      CASE WHEN x = 'Matched: In TAM' THEN 1 END
  - name: b
    expr: "a: b"
measures:
  - name: c
    expr: count(1)`;
    const out = normalizeMetricViewYaml(yaml);
    assert.ok(out.includes('expr: "a: b"'));
    assert.ok(out.includes("    count(1)"));
  });

  it("converts a leading-backtick expression to a block scalar", () => {
    const yaml = `version: 1.1
source: cat.sch.tbl
dimensions:
  - name: floor
    expr: \`floor\`
measures:
  - name: cnt
    expr: count(1)`;
    const out = serializeYamlSqlScalars(yaml);
    assert.ok(out.includes("expr: |-\n      `floor`"));
    assert.doesNotThrow(() => validateMetricViewYaml(out));
  });
});

describe("ensureMetricViewSourcesJobSqlView", () => {
  it("repoints production-table source to the job enriched sql_view", async () => {
    const { ensureMetricViewSourcesJobSqlView } = await import(
      "../lib/migration/deploy-normalize"
    );
    const yaml = `version: "1.1"
source: databricks_prd.dbt_production.dim_building
dimensions:
  - name: address
    expr: address
measures:
  - name: count
    expr: COUNT(*)
`;
    const out = ensureMetricViewSourcesJobSqlView(
      yaml,
      "databricks_prd",
      "semantic_migration_dev",
      ["dim_building_enriched"]
    );
    assert.strictEqual(out.changed, true);
    assert.strictEqual(
      out.source,
      "databricks_prd.semantic_migration_dev.dim_building_enriched"
    );
    assert.match(
      out.yaml,
      /source: databricks_prd\.semantic_migration_dev\.dim_building_enriched/
    );
  });

  it("leaves an already-correct job sql_view source unchanged", async () => {
    const { ensureMetricViewSourcesJobSqlView } = await import(
      "../lib/migration/deploy-normalize"
    );
    const yaml = `version: "1.1"
source: databricks_prd.semantic_migration_dev.dim_building_enriched
dimensions:
  - name: address
    expr: address
measures:
  - name: count
    expr: COUNT(*)
`;
    const out = ensureMetricViewSourcesJobSqlView(
      yaml,
      "databricks_prd",
      "semantic_migration_dev",
      ["dim_building_enriched"]
    );
    assert.strictEqual(out.changed, false);
  });
});

describe("validateMetricViewYaml", () => {
  it("rejects malformed YAML before deployment", () => {
    assert.throws(
      () =>
        validateMetricViewYaml(`version: 1.1
source: cat.sch.tbl
dimensions:
  - name: floor
    expr: \`floor\``),
      /Invalid metric-view YAML after normalization/
    );
  });

  it("rejects missing Databricks metric-view structure", () => {
    assert.throws(
      () => validateMetricViewYaml("version: 1.1\nsource: cat.sch.tbl"),
      /fields\/dimensions or measures/
    );
  });
});

describe("sanitizeGeneratedAssets", () => {
  it("strips DDL wrappers and clears cross-filled fields", () => {
    const assets: ProposedAsset[] = [
      {
        type: "sql_view",
        name: "vw_x",
        schema: "dev",
        description: "",
        sql: "CREATE OR REPLACE VIEW c.s.vw_x AS SELECT 1 AS a",
        yaml: "version: 1.1",
      },
      {
        type: "metric_view",
        name: "mv_x",
        schema: "dev",
        description: "",
        sql: "SELECT 1",
        yaml: `CREATE OR REPLACE VIEW c.s.mv WITH METRICS LANGUAGE YAML AS $$
version: 1.1
source: other.prod.vw_x
measures:
  - name: c
    expr: count(1)
$$`,
      },
    ];
    const out = sanitizeGeneratedAssets(assets, "cat", "dev");
    assert.strictEqual(out[0].sql, "SELECT 1 AS a");
    assert.strictEqual(out[0].yaml, undefined);
    assert.strictEqual(out[1].sql, undefined);
    assert.ok(out[1].yaml?.startsWith("version:"));
    assert.ok(out[1].yaml?.includes("source: cat.dev.vw_x"));
  });
});
