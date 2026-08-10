"use client";

interface YamlPreviewProps {
  yaml: string;
  onChange: (v: string) => void;
  onCreate: () => void;
  creating: boolean;
  canCreate: boolean;
  createResult: { ok: boolean; message: string } | null;
}

export function YamlPreview({
  yaml,
  onChange,
  onCreate,
  creating,
  canCreate,
  createResult,
}: YamlPreviewProps) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-zinc-900">Metric view YAML</h2>
          <p className="mt-1 text-sm text-zinc-600">
            Preview and edit the proposed Unity Catalog metric view definition before
            creation.
          </p>
        </div>
        <button
          type="button"
          disabled={!canCreate || creating}
          onClick={onCreate}
          className="rounded-md bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-50"
        >
          {creating ? "Creating…" : "Create metric view"}
        </button>
      </div>
      <textarea
        value={yaml}
        onChange={(e) => onChange(e.target.value)}
        rows={16}
        className="mt-4 w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-xs"
      />
      {createResult && (
        <p
          className={`mt-2 text-sm ${createResult.ok ? "text-green-700" : "text-red-700"}`}
        >
          {createResult.message}
        </p>
      )}
    </section>
  );
}

function buildSampleYaml(
  catalog: string,
  sourceSchema: string,
  sourceTable: string
): string {
  return `version: 1.1
source: ${catalog}.${sourceSchema}.${sourceTable}
comment: Example metric view with agent metadata
dimensions:
  - name: example_dimension
    expr: id
    display_name: Example Dimension
    comment: Example dimension — replace after LookML mapping
    synonyms:
      - example id
measures:
  - name: example_measure
    expr: COUNT(*)
    display_name: Example Measure
    comment: Example measure — replace after LookML mapping
    format:
      type: number
    synonyms:
      - count
`;
}

export { buildSampleYaml };
