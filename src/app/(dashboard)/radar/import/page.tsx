import Link from "next/link";
import { importCsvAction } from "../actions";

const ERROR_MESSAGES: Record<string, string> = {
  no_file: "Selecciona un archivo CSV antes de subir.",
  parse: "El CSV no se pudo parsear.",
  insert: "El insert en la base de datos falló.",
};

const EXPECTED_COLUMNS = [
  ["email", "obligatorio"],
  ["first_name", "opcional"],
  ["last_name", "opcional"],
  ["company", "opcional"],
  ["title", "opcional"],
  ["phone", "opcional"],
  ["linkedin_url", "opcional"],
  ["website", "opcional"],
  ["sector", "opcional"],
  ["country", "opcional"],
  ["city", "opcional"],
] as const;

export default async function RadarImportPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; detail?: string }>;
}) {
  const { error, detail } = await searchParams;
  const errorMessage = error ? ERROR_MESSAGES[error] ?? "Error desconocido." : null;

  return (
    <section className="max-w-3xl space-y-8">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-4xl font-semibold">Importar CSV</h1>
          <p className="mt-2 text-sm text-foreground/60">
            Radar / import — inserta leads con <code className="text-accent">source=csv_import</code>.
            La limpieza (dedupe empresa/cargo, normalización de tildes, flag REVIEW para emails
            genéricos) llega en T013; ahora se insertan tal cual.
          </p>
        </div>
        <Link
          href="/radar"
          className="rounded-md border border-hairline px-3 py-1.5 text-xs text-foreground/70 hover:border-accent/40 hover:text-foreground"
        >
          ← Volver a Radar
        </Link>
      </div>

      {errorMessage && (
        <div
          role="alert"
          className="rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300"
        >
          <p>{errorMessage}</p>
          {detail && <p className="mt-1 text-xs text-red-400/80">{detail}</p>}
        </div>
      )}

      <form
        action={importCsvAction}
        className="space-y-6 rounded-lg border border-hairline p-6"
      >
        <div>
          <label
            htmlFor="csv-file"
            className="block text-sm font-medium text-foreground/80"
          >
            Archivo CSV
          </label>
          <input
            id="csv-file"
            type="file"
            name="file"
            accept=".csv,text/csv"
            required
            className="mt-2 block w-full cursor-pointer rounded-md border border-hairline bg-foreground/5 px-3 py-2 text-sm file:mr-4 file:rounded-md file:border-0 file:bg-accent/10 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-accent hover:file:bg-accent/20"
          />
          <p className="mt-2 text-xs text-foreground/50">
            La cabecera del CSV es case-insensitive y admite variantes en español
            (nombre, empresa, cargo, país, …). Cualquier columna no reconocida
            entra en <code className="text-accent/80">custom_fields</code>.
          </p>
        </div>

        <div>
          <p className="mb-2 text-xs uppercase tracking-wider text-muted">
            Columnas reconocidas
          </p>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-foreground/70 sm:grid-cols-3">
            {EXPECTED_COLUMNS.map(([col, req]) => (
              <div key={col} className="flex items-center gap-2">
                <code className="text-accent/80">{col}</code>
                <span className="text-foreground/40">{req}</span>
              </div>
            ))}
          </div>
        </div>

        <button
          type="submit"
          className="rounded-md border border-accent/40 bg-accent/10 px-5 py-2.5 text-sm font-medium text-accent transition-colors hover:bg-accent/20"
        >
          Subir e importar
        </button>
      </form>
    </section>
  );
}
