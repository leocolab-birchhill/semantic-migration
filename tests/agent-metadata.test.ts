import { describe, it } from "node:test";
import assert from "node:assert";
import { parse as parseYaml } from "yaml";
import {
  agentMetadataForLookerField,
  buildSynonyms,
  enrichMetricViewYamlWithAgentMetadata,
  humanizeFieldName,
  lookerValueFormatToDatabricksFormat,
  repairFormatIncompatibleYaml,
  stripIncompatibleMetricViewFormats,
} from "../lib/migration/agent-metadata";
import {
  normalizeMetricViewYaml,
  prepareMetricViewForDeploy,
  sanitizeGeneratedAssets,
  validateMetricViewYaml,
} from "../lib/migration/deploy-normalize";
import type {
  IntermediateRepresentation,
  ProposedAsset,
} from "../lib/migration/types";

function baseInventory(
  overrides?: Partial<IntermediateRepresentation>
): IntermediateRepresentation {
  return {
    version: "1.0",
    source: {
      type: "explore",
      model: "tam",
      explore: "tam_buildings",
    },
    grain: { dimensions: [] },
    joins: [],
    dimensions: [
      {
        name: "fct_tam_buildings.building_id",
        label: "Building ID",
        type: "string",
        description: "Unique building identifier",
        tags: ["building", "id"],
      },
      {
        name: "fct_tam_buildings.as_of_date",
        label: "As Of Date",
        type: "date",
        description: "Snapshot date",
      },
    ],
    measures: [
      {
        name: "fct_tam_buildings.revenue_estimate_sum_customer_adjusted",
        label: "Revenue Estimate (CAD)",
        type: "sum",
        description: 'Total "customer adjusted" revenue in CAD',
        valueFormat: '"$"#,##0.00',
        tags: ["revenue", "tam"],
      },
      {
        name: "fct_tam_buildings.share_of_tam",
        label: "Share of TAM",
        type: "number",
        description: "Penetration share",
        valueFormat: "0.0%",
        tags: ["share"],
      },
    ],
    filters: [],
    parameters: [],
    derivedTables: [],
    liquidLogic: [],
    userAttributes: [],
    formatting: {},
    tileQueries: [],
    unsupportedFeatures: [],
    lookmlFiles: [],
    ...overrides,
  };
}

describe("humanizeFieldName", () => {
  it("title-cases snake_case", () => {
    assert.strictEqual(
      humanizeFieldName("revenue_estimate_sum"),
      "Revenue Estimate Sum"
    );
  });
});

describe("lookerValueFormatToDatabricksFormat", () => {
  it("maps currency formats", () => {
    const fmt = lookerValueFormatToDatabricksFormat({
      valueFormat: '"$"#,##0.00',
      currency: "CAD",
      fieldName: "revenue_cad",
    });
    assert.deepStrictEqual(fmt, {
      type: "currency",
      currency_code: "CAD",
      decimal_places: { type: "exact", places: 2 },
      hide_group_separator: false,
    });
  });

  it("maps percentage formats", () => {
    const fmt = lookerValueFormatToDatabricksFormat({
      valueFormat: "0.0%",
      unit: "percent",
    });
    assert.strictEqual(fmt?.type, "percentage");
    assert.deepStrictEqual(fmt?.decimal_places, {
      type: "exact",
      places: 1,
    });
  });

  it("maps date types", () => {
    const fmt = lookerValueFormatToDatabricksFormat({
      lookerType: "date",
    });
    assert.deepStrictEqual(fmt, {
      type: "date",
      date_format: "year_month_day",
      leading_zeros: true,
    });
  });

  it("does not assign numeric formats to string Looker types", () => {
    const fmt = lookerValueFormatToDatabricksFormat({
      valueFormat: "0.0%",
      lookerType: "string",
      fieldName: "cust_type",
      label: "Customer Type",
    });
    assert.strictEqual(fmt, undefined);
  });
});

describe("strip incompatible formats", () => {
  it("removes percentage format from string CASE dimensions", () => {
    const yaml = `version: "1.1"
source: cat.dev.t
dimensions:
  - name: cust_type
    expr: |-
      CASE WHEN x = 1 THEN 'A' ELSE 'B' END
    format:
      type: percentage
  - name: region
    expr: region
    format:
      type: percentage
measures:
  - name: revenue
    expr: SUM(revenue)
    format:
      type: currency
      currency_code: CAD
`;
    const inventory = baseInventory({
      dimensions: [
        {
          name: "customer.cust_type",
          type: "string",
          label: "Customer Type",
        },
        {
          name: "customer.region",
          type: "string",
          label: "Region",
        },
      ],
    });
    const { yaml: out, stripped } = stripIncompatibleMetricViewFormats(
      yaml,
      inventory
    );
    assert.ok(stripped.includes("cust_type"));
    assert.ok(stripped.includes("region"));
    const doc = parseYaml(out) as Record<string, unknown>;
    const dims = doc.dimensions as Array<Record<string, unknown>>;
    assert.strictEqual(
      dims.find((d) => d.name === "cust_type")!.format,
      undefined
    );
    assert.ok(
      (doc.measures as Array<Record<string, unknown>>).find(
        (m) => m.name === "revenue"
      )!.format
    );

    const repaired = repairFormatIncompatibleYaml(
      yaml,
      "Column `cust_type` has numeric format which is incompatible with column type STRING.",
      inventory
    );
    assert.ok(repaired.stripped.includes("cust_type"));
  });

  it("enrich strips GPT-assigned percentage on string dims and does not re-add", () => {
    const yaml = `version: 1.1
source: cat.dev.t
dimensions:
  - name: cust_type
    expr: |-
      CASE WHEN 1=1 THEN 'Enterprise' ELSE 'SMB' END
    format:
      type: percentage
measures:
  - name: cnt
    expr: COUNT(*)
`;
    const inventory = baseInventory({
      dimensions: [
        {
          name: "customer.cust_type",
          type: "string",
          label: "Cust Type",
          valueFormat: "0%",
        },
      ],
    });
    const enriched = enrichMetricViewYamlWithAgentMetadata(yaml, inventory);
    const doc = parseYaml(enriched) as Record<string, unknown>;
    const dims = doc.dimensions as Array<Record<string, unknown>>;
    const cust = dims.find((d) => d.name === "cust_type")!;
    assert.strictEqual(cust.format, undefined);
  });
});

describe("buildSynonyms", () => {
  it("includes label and tags without duplicating display name", () => {
    const syn = buildSynonyms({
      technicalName: "revenue_estimate_sum_customer_adjusted",
      displayName: "Revenue Estimate (CAD)",
      label: "Revenue Estimate (CAD)",
      tags: ["revenue", "tam"],
    });
    assert.ok(syn.includes("revenue"));
    assert.ok(syn.includes("tam"));
    assert.ok(!syn.some((s) => s.toLowerCase() === "revenue estimate (cad)"));
    assert.ok(syn.length <= 10);
  });
});

describe("enrichMetricViewYamlWithAgentMetadata", () => {
  const bareYaml = `version: 0.1
source: cat.dev.tam_buildings_base
dimensions:
  - name: building_id
    expr: building_id
  - name: as_of_date
    expr: as_of_date
measures:
  - name: revenue_estimate_sum_customer_adjusted
    expr: SUM(revenue_estimate_customer_adjusted)
  - name: share_of_tam
    expr: AVG(share_of_tam)
`;

  it("fills display_name, comment, synonyms, format and bumps to 1.1", () => {
    const inventory = baseInventory({
      fieldMapping: {
        version: "1",
        updatedAt: new Date().toISOString(),
        entries: [
          {
            lookerField:
              "fct_tam_buildings.revenue_estimate_sum_customer_adjusted",
            metricViewName: "tam_buildings",
            databricksField: "revenue_estimate_sum_customer_adjusted",
            kind: "measure",
            currency: "CAD",
            unit: "currency",
          },
          {
            lookerField: "fct_tam_buildings.share_of_tam",
            metricViewName: "tam_buildings",
            databricksField: "share_of_tam",
            kind: "measure",
            unit: "percent",
          },
          {
            lookerField: "fct_tam_buildings.building_id",
            metricViewName: "tam_buildings",
            databricksField: "building_id",
            kind: "dimension",
          },
          {
            lookerField: "fct_tam_buildings.as_of_date",
            metricViewName: "tam_buildings",
            databricksField: "as_of_date",
            kind: "dimension",
          },
        ],
      },
    });

    const enriched = enrichMetricViewYamlWithAgentMetadata(
      bareYaml,
      inventory,
      inventory.fieldMapping!.entries
    );
    validateMetricViewYaml(normalizeMetricViewYaml(enriched));

    const doc = parseYaml(enriched) as Record<string, unknown>;
    assert.strictEqual(doc.version, "1.1");
    assert.ok(typeof doc.comment === "string");

    const dims = doc.dimensions as Array<Record<string, unknown>>;
    const building = dims.find((d) => d.name === "building_id")!;
    assert.strictEqual(building.display_name, "Building ID");
    assert.strictEqual(building.comment, "Unique building identifier");
    assert.ok(Array.isArray(building.synonyms));
    assert.ok((building.synonyms as string[]).includes("building"));

    const asOf = dims.find((d) => d.name === "as_of_date")!;
    assert.strictEqual(asOf.display_name, "As Of Date");
    assert.deepStrictEqual(asOf.format, {
      type: "date",
      date_format: "year_month_day",
      leading_zeros: true,
    });

    const measures = doc.measures as Array<Record<string, unknown>>;
    const revenue = measures.find(
      (m) => m.name === "revenue_estimate_sum_customer_adjusted"
    )!;
    assert.strictEqual(revenue.display_name, "Revenue Estimate (CAD)");
    assert.strictEqual(
      (revenue.format as { type: string; currency_code: string }).type,
      "currency"
    );
    assert.strictEqual(
      (revenue.format as { currency_code: string }).currency_code,
      "CAD"
    );
    assert.ok(Array.isArray(revenue.synonyms));

    const share = measures.find((m) => m.name === "share_of_tam")!;
    assert.strictEqual(
      (share.format as { type: string }).type,
      "percentage"
    );
  });

  it("preserves existing agent metadata (fill-missing only)", () => {
    const yaml = `version: 1.1
source: cat.dev.t
dimensions:
  - name: building_id
    expr: building_id
    display_name: Custom Building
    synonyms:
      - already here
measures:
  - name: revenue_estimate_sum_customer_adjusted
    expr: SUM(x)
`;
    const inventory = baseInventory();
    const enriched = enrichMetricViewYamlWithAgentMetadata(yaml, inventory);
    const doc = parseYaml(enriched) as Record<string, unknown>;
    const dims = doc.dimensions as Array<Record<string, unknown>>;
    const building = dims.find((d) => d.name === "building_id")!;
    assert.strictEqual(building.display_name, "Custom Building");
    assert.ok((building.synonyms as string[]).includes("already here"));
  });

  it("converts description → comment", () => {
    const yaml = `version: 0.1
source: cat.dev.t
dimensions:
  - name: building_id
    expr: building_id
    description: From GPT
measures:
  - name: cnt
    expr: COUNT(*)
`;
    const enriched = enrichMetricViewYamlWithAgentMetadata(yaml, baseInventory());
    const doc = parseYaml(enriched) as Record<string, unknown>;
    const dims = doc.dimensions as Array<Record<string, unknown>>;
    const building = dims.find((d) => d.name === "building_id")!;
    assert.strictEqual(building.comment, "From GPT");
    assert.strictEqual(building.description, undefined);
  });
});

describe("sanitize + deploy prep keep agent metadata valid", () => {
  it("sanitizeGeneratedAssets emits deployable YAML with agent metadata", () => {
    const inventory = baseInventory({
      fieldMapping: {
        version: "1",
        updatedAt: new Date().toISOString(),
        entries: [
          {
            lookerField:
              "fct_tam_buildings.revenue_estimate_sum_customer_adjusted",
            metricViewName: "tam_buildings",
            databricksField: "revenue_estimate_sum_customer_adjusted",
            kind: "measure",
            currency: "CAD",
            unit: "currency",
          },
          {
            lookerField: "fct_tam_buildings.building_id",
            metricViewName: "tam_buildings",
            databricksField: "building_id",
            kind: "dimension",
          },
        ],
      },
    });

    const assets: ProposedAsset[] = [
      {
        type: "metric_view",
        name: "tam_buildings",
        schema: "dev",
        description: "mv",
        yaml: `version: 0.1
source: cat.dev.base
dimensions:
  - name: building_id
    expr: building_id
measures:
  - name: revenue_estimate_sum_customer_adjusted
    expr: SUM(revenue)
`,
        fieldMappings: inventory.fieldMapping!.entries,
      },
    ];

    const out = sanitizeGeneratedAssets(assets, "cat", "dev", inventory);
    const yaml = out[0].yaml!;
    assert.ok(yaml.includes("display_name:"));
    assert.ok(yaml.includes("synonyms:"));
    assert.ok(yaml.includes('version: "1.1"') || yaml.includes("version: 1.1"));

    const prepared = prepareMetricViewForDeploy(
      out[0],
      "cat",
      "dev",
      [],
      inventory
    );
    validateMetricViewYaml(prepared);
    assert.ok(prepared.includes("Revenue Estimate"));
  });
});

describe("agentMetadataForLookerField", () => {
  it("builds a complete metadata object", () => {
    const meta = agentMetadataForLookerField(
      {
        name: "fct.revenue",
        label: "Revenue",
        type: "sum",
        valueFormat: "$#,##0",
        description: "All revenue",
        tags: ["money"],
      },
      "measure",
      { currency: "USD", unit: "currency" }
    );
    assert.strictEqual(meta.display_name, "Revenue");
    assert.strictEqual(meta.comment, "All revenue");
    assert.ok(meta.synonyms.includes("money"));
    assert.strictEqual(meta.format?.type, "currency");
  });
});
