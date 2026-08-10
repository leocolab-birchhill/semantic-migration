"use client";

interface LookmlUploadProps {
  modelContent: string;
  viewContent: string;
  onModelChange: (v: string) => void;
  onViewChange: (v: string) => void;
}

export function LookmlUpload({
  modelContent,
  viewContent,
  onModelChange,
  onViewChange,
}: LookmlUploadProps) {
  function handleFile(
    e: React.ChangeEvent<HTMLInputElement>,
    setter: (v: string) => void
  ) {
    const file = e.target.files?.[0];
    if (!file) return;
    file.text().then(setter);
  }

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-zinc-900">LookML files</h2>
      <p className="mt-1 text-sm text-zinc-600">
        Paste or upload your model and view LookML. Automatic conversion is not yet
        implemented — use the YAML editor below for manual mapping.
      </p>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div>
          <div className="mb-2 flex items-center justify-between">
            <label className="text-sm font-medium text-zinc-700">Model (.model.lkml)</label>
            <input
              type="file"
              accept=".lkml,.lookml"
              onChange={(e) => handleFile(e, onModelChange)}
              className="text-xs"
            />
          </div>
          <textarea
            value={modelContent}
            onChange={(e) => onModelChange(e.target.value)}
            rows={8}
            placeholder="Paste model LookML…"
            className="w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-xs"
          />
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between">
            <label className="text-sm font-medium text-zinc-700">View (.view.lkml)</label>
            <input
              type="file"
              accept=".lkml,.lookml"
              onChange={(e) => handleFile(e, onViewChange)}
              className="text-xs"
            />
          </div>
          <textarea
            value={viewContent}
            onChange={(e) => onViewChange(e.target.value)}
            rows={8}
            placeholder="Paste view LookML…"
            className="w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-xs"
          />
        </div>
      </div>
    </section>
  );
}
