/**
 * Golden fixture harness for the deterministic translation layer.
 *
 * Fixtures live in tests/golden/fixtures/*.json. Two kinds:
 *   - "scaffold": inventory dimensions → exact scaffoldPassthroughDimensions output
 *   - "filter":   Looker filter expression → exact lookerFilterToSql output
 *
 * Convention (see .cursor/skills/looker-databricks-migration/verification.md):
 * every app bug found in a live job gets a fixture here, in the same change
 * as the fix. Fixture shapes come from real job inventories (tmp-debug/).
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "fs";
import path from "path";
import { scaffoldPassthroughDimensions } from "../lib/migration/scaffold";
import { lookerFilterToSql } from "../lib/migration/query-builder";
import type {
  IntermediateRepresentation,
  IrDimension,
} from "../lib/migration/types";

interface ScaffoldFixture {
  kind: "scaffold";
  description: string;
  metricViewName: string;
  dimensions: IrDimension[];
  expected: {
    dimensions: Array<Record<string, unknown>>;
    fieldMappingPairs: Array<{
      lookerField: string;
      databricksField: string;
      kind: string;
    }>;
    scaffoldedBareNames: string[];
  };
}

interface FilterFixture {
  kind: "filter";
  description: string;
  cases: Array<{
    name: string;
    field: string;
    expression: string;
    expectedSql: string | null;
  }>;
}

type GoldenFixture = ScaffoldFixture | FilterFixture;

const fixturesDir = path.resolve(process.cwd(), "tests", "golden", "fixtures");
const fixtureFiles = fs
  .readdirSync(fixturesDir)
  .filter((f) => f.endsWith(".json"))
  .sort();

function loadFixture(file: string): GoldenFixture {
  return JSON.parse(
    fs.readFileSync(path.join(fixturesDir, file), "utf8")
  ) as GoldenFixture;
}

function inventoryFromDimensions(
  dimensions: IrDimension[]
): IntermediateRepresentation {
  return {
    version: "1",
    source: { type: "table_scope", model: "golden", explore: "golden" },
    grain: { dimensions: [] },
    joins: [],
    dimensions,
    measures: [],
    filters: [],
    parameters: [],
    derivedTables: [],
    liquidLogic: [],
    userAttributes: [],
    formatting: {},
    tileQueries: [],
    unsupportedFeatures: [],
    lookmlFiles: [],
  };
}

describe("golden fixtures", () => {
  assert.ok(fixtureFiles.length > 0, "no golden fixtures found");

  for (const file of fixtureFiles) {
    const fixture = loadFixture(file);

    if (fixture.kind === "scaffold") {
      describe(`${file} (scaffold)`, () => {
        it(fixture.description, () => {
          const scaffold = scaffoldPassthroughDimensions(
            inventoryFromDimensions(fixture.dimensions),
            fixture.metricViewName
          );

          assert.deepStrictEqual(
            scaffold.dimensions,
            fixture.expected.dimensions,
            "scaffolded dimension entries must match fixture exactly"
          );
          assert.deepStrictEqual(
            scaffold.scaffoldedBareNames,
            fixture.expected.scaffoldedBareNames,
            "scaffolded bare names must match fixture exactly"
          );
          assert.deepStrictEqual(
            scaffold.fieldMappings.map((m) => ({
              lookerField: m.lookerField,
              databricksField: m.databricksField,
              kind: m.kind,
            })),
            fixture.expected.fieldMappingPairs,
            "field mapping pairs must match fixture exactly"
          );
          for (const mapping of scaffold.fieldMappings) {
            assert.strictEqual(
              mapping.metricViewName,
              fixture.metricViewName,
              "mappings must target the fixture's metric view"
            );
          }
        });
      });
      continue;
    }

    describe(`${file} (filter)`, () => {
      for (const c of fixture.cases) {
        it(c.name, () => {
          assert.strictEqual(
            lookerFilterToSql(c.field, c.expression),
            c.expectedSql
          );
        });
      }
    });
  }
});
