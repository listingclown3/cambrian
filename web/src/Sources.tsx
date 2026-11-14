/** "Data sources" footer (owner: P4): which results files a page read, each file's createdTs and simHash. */
import { useApi } from "./lib";

interface Meta {
  createdTs?: string;
  simHash?: string;
  isMock?: boolean;
}

function Row({ name }: { name: string }) {
  const { data, error } = useApi<Meta>(`/api/results/${name}`);
  return (
    <tr>
      <td className="mono">results/{name}.json</td>
      <td className="mono">{data?.createdTs ? data.createdTs.slice(0, 19).replace("T", " ") + " UTC" : error ? "missing (not run yet)" : "…"}</td>
      <td className="mono">{data?.simHash ?? "-"}</td>
      <td>{data ? (data.isMock ? <span className="pill mock">MOCK</span> : "real") : ""}</td>
    </tr>
  );
}

/** `files` are results file stems. `extra` lists non-results data files read (data/..., config) as plain text. */
export function Sources({ files, extra = [] }: { files: string[]; extra?: string[] }) {
  return (
    <footer className="src-foot">
      <div className="src-h">DATA SOURCES (this page read these files)</div>
      <table>
        <thead>
          <tr><th>File</th><th>Written</th><th>simHash</th><th>Data</th></tr>
        </thead>
        <tbody>
          {files.map((f) => <Row key={f} name={f} />)}
          {extra.map((e) => (
            <tr key={e}><td className="mono">{e}</td><td colSpan={3} className="hint">read through the server API</td></tr>
          ))}
        </tbody>
      </table>
    </footer>
  );
}
