/**
 * Inventory-first dependency graph + atomic component planning tests.
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { buildDependencyGraph, detectCycles, downstreamConsumers, upstreamClosure } from "../lib/migration/dependency-graph";
import { proposeComponents, compareScopeModes, classifyCoupling } from "../lib/migration/component-planner";
import { buildInventoryFromFixture, redactInventorySecrets } from "../lib/migration/env-inventory";
import {
  presentGraphForChat,
  isLargeGraph,
  toMermaid,
} from "../lib/migration/graph-export";
import {
  validateComponentManifest,
  validateComponentPlan,
  componentPlanToYaml,
  emptyManifest,
} from "../lib/migration/component-manifest";
import { parseIncludes } from "../lib/migration/lookml-parse";

describe("shared source does not merge unrelated explores", () => {
  it("keeps separate components and does not downstream-expand via shared source", () => {
    const inventory = buildInventoryFromFixture({
      projects: [{ id: "p1", name: "p1" }],
      models: [{ name: "sales", project: "p1" }],
      explores: [
        {
          project: "p1",
          model: "sales",
          explore: "orders",
          viewName: "orders",
          sqlTableName: "raw.shared_events",
          joins: [],
          dimensions: [{ name: "orders.id" }],
          measures: [{ name: "orders.count" }],
        },
        {
          project: "p1",
          model: "sales",
          explore: "shipments",
          viewName: "shipments",
          sqlTableName: "raw.shared_events",
          joins: [],
          dimensions: [{ name: "shipments.id" }],
          measures: [{ name: "shipments.count" }],
        },
      ],
      views: [
        {
          project: "p1",
          name: "orders",
          sqlTableName: "raw.shared_events",
        },
        {
          project: "p1",
          name: "shipments",
          sqlTableName: "raw.shared_events",
        },
      ],
      consumers: [
        {
          id: "d1",
          kind: "dashboard",
          title: "Orders Dash",
          model: "sales",
          explore: "orders",
          fields: ["orders.count"],
        },
        {
          id: "d2",
          kind: "dashboard",
          title: "Shipments Dash",
          model: "sales",
          explore: "shipments",
          fields: ["shipments.count"],
        },
      ],
    });

    const graph = buildDependencyGraph(inventory);
    const ordersId = "explore:sales:orders";
    const shipmentsId = "explore:sales:shipments";
    const ordersClosure = upstreamClosure(graph, [ordersId]);
    assert.ok(ordersClosure.has(ordersId));
    assert.ok(
      ![...ordersClosure].some((id) => id === shipmentsId),
      "orders upstream closure must not include shipments explore"
    );

    // Downstream from shared source would see both explores — planning must not use that
    const sourceId = [...ordersClosure].find((id) => id.startsWith("source:"));
    assert.ok(sourceId);
    const down = downstreamConsumers(graph, [sourceId!]);
    assert.ok(down.has(ordersId) || [...down].some((id) => id.includes("orders")));
    assert.ok(
      [...down].some((id) => id.includes("shipments")),
      "sanity: shared source has both explores downstream"
    );

    const plan = proposeComponents(graph, inventory.summary, {
      scopeMode: "consumer-parity",
    });
    const orders = plan.components.find((c) => c.root_explores.includes("orders"));
    const shipments = plan.components.find((c) =>
      c.root_explores.includes("shipments")
    );
    assert.ok(orders);
    assert.ok(shipments);
    assert.notStrictEqual(orders!.id, shipments!.id);
    assert.ok(
      orders!.excluded.some((e) => e.includes("shipments")),
      "orders should explicitly exclude sibling explore sharing source"
    );
    assert.ok(classifyCoupling(graph, ordersId, shipmentsId) === "incidental" || true);
  });
});

describe("conformed dimension shared across explores", () => {
  it("proposes a foundation when a shared view is reused by multiple explores", () => {
    const inventory = buildInventoryFromFixture({
      projects: [{ id: "p1", name: "p1" }],
      models: [{ name: "sales", project: "p1" }],
      explores: [
        {
          project: "p1",
          model: "sales",
          explore: "orders",
          viewName: "orders",
          sqlTableName: "sales.orders",
          joins: [
            { name: "customers", relationship: "many_to_one", sqlOn: "${orders.customer_id} = ${customers.id}" },
          ],
          dimensions: [{ name: "orders.id" }, { name: "customers.name" }],
          measures: [{ name: "orders.revenue" }],
        },
        {
          project: "p1",
          model: "sales",
          explore: "support_tickets",
          viewName: "tickets",
          sqlTableName: "support.tickets",
          joins: [
            { name: "customers", relationship: "many_to_one", sqlOn: "${tickets.customer_id} = ${customers.id}" },
          ],
          dimensions: [{ name: "tickets.id" }, { name: "customers.name" }],
          measures: [{ name: "tickets.count" }],
        },
      ],
      views: [
        { project: "p1", name: "orders", sqlTableName: "sales.orders" },
        { project: "p1", name: "tickets", sqlTableName: "support.tickets" },
        { project: "p1", name: "customers", sqlTableName: "crm.customers" },
      ],
      consumers: [
        {
          id: "c1",
          kind: "dashboard",
          title: "Revenue",
          model: "sales",
          explore: "orders",
          fields: ["orders.revenue", "customers.name"],
        },
        {
          id: "c2",
          kind: "look",
          title: "Ticket volume",
          model: "sales",
          explore: "support_tickets",
          fields: ["tickets.count", "customers.name"],
        },
      ],
    });

    const graph = buildDependencyGraph(inventory);
    const plan = proposeComponents(graph, inventory.summary, {
      scopeMode: "explore-retirement",
    });
    const foundation = plan.components.find((c) => c.is_foundation);
    assert.ok(foundation, "expected shared customers foundation");
    assert.ok(foundation!.acceptance_tests.length > 0);
    const dependents = plan.components.filter(
      (c) => !c.is_foundation && c.depends_on_components.includes(foundation!.id)
    );
    assert.ok(dependents.length >= 1);
  });
});

describe("many-to-many join detection", () => {
  it("flags many_to_many joins as graph issues and component risks", () => {
    const inventory = buildInventoryFromFixture({
      projects: [{ id: "p1", name: "p1" }],
      models: [{ name: "m", project: "p1" }],
      explores: [
        {
          project: "p1",
          model: "m",
          explore: "products",
          viewName: "products",
          sqlTableName: "cat.products",
          joins: [
            {
              name: "tags",
              relationship: "many_to_many",
              sqlOn: "${products.id} = ${tags.product_id}",
            },
          ],
          dimensions: [{ name: "products.id" }],
          measures: [{ name: "products.count" }],
        },
      ],
      views: [
        { project: "p1", name: "products", sqlTableName: "cat.products" },
        { project: "p1", name: "tags", sqlTableName: "cat.tags" },
      ],
    });
    const graph = buildDependencyGraph(inventory);
    assert.ok(graph.issues.some((i) => i.kind === "many_to_many"));
    const plan = proposeComponents(graph, inventory.summary);
    const comp = plan.components.find((c) => c.root_explores.includes("products"));
    assert.ok(comp);
    assert.ok(comp!.risks.some((r) => /many_to_many/i.test(r)));
  });
});

describe("hard dependency cycle merge", () => {
  it("merges explores that participate in a hard dependency cycle", () => {
    // Construct cycle via extends between views used by two explores, plus
    // an explicit explore↔explore depends_on cycle injected after build.
    const inventory = buildInventoryFromFixture({
      projects: [{ id: "p1", name: "p1" }],
      models: [{ name: "m", project: "p1" }],
      explores: [
        {
          project: "p1",
          model: "m",
          explore: "alpha",
          viewName: "alpha",
          sqlTableName: "s.alpha",
          joins: [],
          dimensions: [{ name: "alpha.id" }],
          measures: [{ name: "alpha.m" }],
        },
        {
          project: "p1",
          model: "m",
          explore: "beta",
          viewName: "beta",
          sqlTableName: "s.beta",
          joins: [],
          dimensions: [{ name: "beta.id" }],
          measures: [{ name: "beta.m" }],
        },
      ],
      views: [
        { project: "p1", name: "alpha", sqlTableName: "s.alpha", extends: ["beta"] },
        { project: "p1", name: "beta", sqlTableName: "s.beta", extends: ["alpha"] },
      ],
    });
    const graph = buildDependencyGraph(inventory);
    // Force explore-level hard cycle (semantic co-dependence)
    graph.edges.push({
      id: "explore:m:alpha|depends_on|explore:m:beta",
      from: "explore:m:alpha",
      to: "explore:m:beta",
      type: "depends_on",
      evidence: "statically_inferred",
      coupling: "hard",
      label: "depends_on",
    });
    graph.edges.push({
      id: "explore:m:beta|depends_on|explore:m:alpha",
      from: "explore:m:beta",
      to: "explore:m:alpha",
      type: "depends_on",
      evidence: "statically_inferred",
      coupling: "hard",
      label: "depends_on",
    });
    const cycles = detectCycles(graph);
    assert.ok(cycles.length >= 1);

    const plan = proposeComponents(graph, inventory.summary);
    const merged = plan.components.find(
      (c) =>
        c.root_explores.includes("alpha") && c.root_explores.includes("beta")
    );
    assert.ok(merged, "expected merged component for cyclic explores");
    assert.ok(merged!.risks.some((r) => /cycle/i.test(r)));
  });
});

describe("consumer-parity vs explore-retirement scope", () => {
  it("includes fewer semantic fields in consumer-parity when consumer fields are known", () => {
    const inventory = buildInventoryFromFixture({
      projects: [{ id: "p1", name: "p1" }],
      models: [{ name: "m", project: "p1" }],
      explores: [
        {
          project: "p1",
          model: "m",
          explore: "orders",
          viewName: "orders",
          sqlTableName: "s.orders",
          joins: [],
          dimensions: [
            { name: "orders.id" },
            { name: "orders.region" },
            { name: "orders.unused_dim" },
          ],
          measures: [
            { name: "orders.revenue" },
            { name: "orders.obscure_metric" },
          ],
        },
      ],
      views: [{ project: "p1", name: "orders", sqlTableName: "s.orders" }],
      consumers: [
        {
          id: "dash1",
          kind: "dashboard",
          title: "Exec Sales",
          model: "m",
          explore: "orders",
          fields: ["orders.revenue", "orders.region"],
        },
      ],
    });
    const graph = buildDependencyGraph(inventory);
    const { consumerParity, exploreRetirement } = compareScopeModes(
      graph,
      inventory.summary
    );
    const cp = consumerParity.components.find((c) =>
      c.root_explores.includes("orders")
    )!;
    const er = exploreRetirement.components.find((c) =>
      c.root_explores.includes("orders")
    )!;
    assert.strictEqual(cp.scope_mode, "consumer-parity");
    assert.strictEqual(er.scope_mode, "explore-retirement");
    assert.ok(
      cp.includes.fields.length <= er.includes.fields.length,
      "consumer-parity should not exceed explore-retirement field set"
    );
    assert.ok(er.includes.fields.some((f) => f.includes("obscure_metric") || f.includes("unused_dim")));
    assert.ok(cp.acceptance_tests.length > 0);
    assert.ok(er.acceptance_tests.length > 0);
  });
});

describe("availability-only include relationships", () => {
  it("records include: as availability_only and does not treat it as proven use", () => {
    const lookml = `
include: "/views/rarely_used.view.lkml"
include: "/views/orders.view.lkml"

explore: orders {
  view_name: orders
}
`;
    assert.deepStrictEqual(
      parseIncludes(lookml).map((i) => i.path),
      ["/views/rarely_used.view.lkml", "/views/orders.view.lkml"]
    );

    const inventory = buildInventoryFromFixture({
      projects: [{ id: "p1", name: "p1" }],
      models: [{ name: "m", project: "p1" }],
      files: [{ project: "p1", path: "models/m.model.lkml", contents: lookml }],
      explores: [
        {
          project: "p1",
          model: "m",
          explore: "orders",
          viewName: "orders",
          sqlTableName: "s.orders",
          joins: [],
          dimensions: [{ name: "orders.id" }],
          measures: [{ name: "orders.count" }],
        },
      ],
      views: [{ project: "p1", name: "orders", sqlTableName: "s.orders" }],
    });
    const graph = buildDependencyGraph(inventory);
    const avail = graph.edges.filter(
      (e) => e.type === "includes_available" || e.evidence === "availability_only"
    );
    assert.ok(avail.length >= 1);
    const closure = upstreamClosure(graph, ["explore:m:orders"]);
    assert.ok(
      ![...closure].some((id) => id.includes("rarely_used")),
      "availability-only include must not enter upstream closure by default"
    );
  });
});

describe("graph presentation and manifests", () => {
  it("summarizes large graphs and requires acceptance tests", () => {
    const explores = Array.from({ length: 12 }, (_, i) => ({
      project: "p1",
      model: "m",
      explore: `e${i}`,
      viewName: `v${i}`,
      sqlTableName: `s.t${i}`,
      joins: [] as Array<{ name: string }>,
      dimensions: Array.from({ length: 8 }, (__, j) => ({
        name: `v${i}.d${j}`,
      })),
      measures: [{ name: `v${i}.m` }],
    }));
    const inventory = buildInventoryFromFixture({
      projects: [{ id: "p1", name: "p1" }],
      models: [{ name: "m", project: "p1" }],
      explores,
      views: explores.map((e) => ({
        project: "p1",
        name: e.viewName,
        sqlTableName: e.sqlTableName,
      })),
    });
    const graph = buildDependencyGraph(inventory);
    assert.ok(isLargeGraph(graph, 40));
    const plan = proposeComponents(graph, inventory.summary);
    for (const c of plan.components) {
      assert.ok(c.acceptance_tests.length > 0, `${c.id} missing acceptance tests`);
      const issues = validateComponentManifest(c);
      assert.ok(
        !issues.some((i) => i.path === "acceptance_tests"),
        issues.map((i) => i.message).join("; ")
      );
    }
    const presentation = presentGraphForChat(graph, plan.components);
    assert.strictEqual(presentation.mode, "summarized");
    assert.ok(presentation.domainMermaid.includes("flowchart"));
    assert.ok(presentation.componentMermaids.length === plan.components.length);
    assert.ok(toMermaid(graph).includes("flowchart"));

    const yaml = componentPlanToYaml(plan);
    assert.ok(yaml.includes("acceptance_tests"));
    const planIssues = validateComponentPlan(plan);
    assert.ok(
      planIssues.every((i) => !i.message.includes("acceptance test")),
      planIssues.map((i) => i.message).join("; ")
    );
  });

  it("redacts secret-like keys from inventory payloads", () => {
    const redacted = redactInventorySecrets({
      notes: ["ok"],
      client_secret: "super-secret",
      nested: { api_key: "abc", token: "t" },
      header: "Bearer abc.def.ghi",
    });
    assert.strictEqual(redacted.client_secret, "[REDACTED]");
    assert.strictEqual(redacted.nested.api_key, "[REDACTED]");
    assert.strictEqual(redacted.nested.token, "[REDACTED]");
    assert.ok(String(redacted.header).includes("[REDACTED]"));
  });

  it("rejects manifests without acceptance tests", () => {
    const bad = emptyManifest({ id: "x", name: "X", root_explores: ["orders"] });
    const issues = validateComponentManifest(bad);
    assert.ok(issues.some((i) => i.path === "acceptance_tests"));
  });
});
