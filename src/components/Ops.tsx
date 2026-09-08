import { useCallback, useEffect, useState } from 'react';

/**
 * Operations view. The reason this exists rather than "check the Supabase
 * table": recovery has to be something a non-engineer can do at 2am. A delivery
 * that only an engineer with database access can replay is not recoverable, it
 * is just logged.
 *
 * The access key is held in sessionStorage and sent as a header on every
 * request. Putting it in the query string — as this page used to — writes it
 * into browser history, the referrer of any outbound link, and Vercel's access
 * logs, which is most of the ways a secret escapes.
 */

interface OutboxRow {
  id: number;
  lead_id: string;
  destination: string;
  status: string;
  attempts: number;
  max_attempts?: number;
  last_error?: string | null;
  next_attempt_at?: string;
  updated_at: string;
}

interface OpsData {
  health: { destination: string; status: string; rows: number }[];
  problems: OutboxRow[];
  recent: OutboxRow[];
  funnel: Record<string, number>;
}

export default function Ops() {
  const [key, setKey] = useState(() => sessionStorage.getItem('lh_ops_key') ?? '');
  const [data, setData] = useState<OpsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async (k: string) => {
    if (!k) return;
    try {
      const res = await fetch('/api/ops', { headers: { 'x-ops-key': k } });
      if (res.status === 401) {
        setError('That key was rejected.');
        setData(null);
        sessionStorage.removeItem('lh_ops_key');
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      setData(await res.json());
      setError(null);
      sessionStorage.setItem('lh_ops_key', k);
    } catch {
      setError('Could not load delivery status.');
    }
  }, []);

  useEffect(() => {
    if (!key) return;
    void load(key);
    // Poll while the tab is open so retries visibly progress without anyone
    // having to hit refresh.
    const t = setInterval(() => void load(key), 10_000);
    return () => clearInterval(t);
  }, [key, load]);

  async function replay(id: number) {
    setBusy(id);
    try {
      await fetch('/api/ops', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ops-key': key },
        body: JSON.stringify({ outboxId: id }),
      });
      await load(key);
    } finally {
      setBusy(null);
    }
  }

  if (!data) {
    return (
      <main className="ops">
        <h1>Delivery operations</h1>
        <p className="ops-muted">Enter the ops key to view delivery status.</p>
        <form
          className="ops-keyrow"
          onSubmit={(e) => {
            e.preventDefault();
            void load(key);
          }}
        >
          <label className="sr-only" htmlFor="ops-key">
            Ops key
          </label>
          <input
            id="ops-key"
            className="input"
            type="password"
            autoComplete="off"
            value={key}
            placeholder="Ops key"
            onChange={(e) => setKey(e.target.value)}
          />
          <button className="ops-btn" type="submit">
            View
          </button>
        </form>
        {error && <p className="ops-error">{error}</p>}
      </main>
    );
  }

  const dead = data.problems.filter((p) => p.status === 'dead');
  const failing = data.problems.filter((p) => p.status === 'failed');

  return (
    <main className="ops">
      <h1>Delivery operations</h1>

      <section className="ops-cards">
        <Stat label="Completed leads" value={data.funnel.complete} />
        <Stat label="Partial (in funnel)" value={data.funnel.partial} />
        <Stat label="Qualified" value={data.funnel.qualified} />
        <Stat label="Restricted" value={data.funnel.restricted} />
        <Stat label="Retrying" value={failing.length} tone={failing.length ? 'warn' : undefined} />
        <Stat label="Dead-lettered" value={dead.length} tone={dead.length ? 'bad' : undefined} />
      </section>

      <h2>Delivery status by destination</h2>
      <table className="ops-table">
        <thead>
          <tr>
            <th>Destination</th>
            <th>Status</th>
            <th>Rows</th>
          </tr>
        </thead>
        <tbody>
          {data.health?.map((h, i) => (
            <tr key={i}>
              <td>{h.destination}</td>
              <td>
                <span className={`pill pill-${h.status}`}>{h.status}</span>
              </td>
              <td>{h.rows}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Failures</h2>
      {data.problems.length === 0 ? (
        <p className="ops-muted">Nothing failing. Every delivery has landed.</p>
      ) : (
        <table className="ops-table">
          <thead>
            <tr>
              <th>Lead</th>
              <th>Destination</th>
              <th>Status</th>
              <th>Attempts</th>
              <th>Last error</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.problems.map((p) => (
              <tr key={p.id}>
                <td className="mono">{p.lead_id.slice(0, 8)}</td>
                <td>{p.destination}</td>
                <td>
                  <span className={`pill pill-${p.status}`}>{p.status}</span>
                </td>
                <td>
                  {p.attempts}/{p.max_attempts ?? 6}
                </td>
                <td className="ops-err">{p.last_error?.slice(0, 120)}</td>
                <td>
                  <button
                    className="ops-btn ops-btn-sm"
                    disabled={busy === p.id}
                    onClick={() => void replay(p.id)}
                  >
                    {busy === p.id ? 'Replaying…' : 'Replay'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Recent activity</h2>
      <table className="ops-table">
        <thead>
          <tr>
            <th>Lead</th>
            <th>Destination</th>
            <th>Status</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {data.recent?.map((r) => (
            <tr key={r.id}>
              <td className="mono">{r.lead_id.slice(0, 8)}</td>
              <td>{r.destination}</td>
              <td>
                <span className={`pill pill-${r.status}`}>{r.status}</span>
              </td>
              <td>{new Date(r.updated_at).toLocaleTimeString()}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="ops-foot">
        Refreshes every 10 seconds. No personal data is shown here by design — leads are
        identified by ID only.
      </p>
    </main>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'warn' | 'bad' }) {
  return (
    <div className={`ops-card${tone ? ` ops-card-${tone}` : ''}`}>
      <div className="ops-card-value">{value ?? 0}</div>
      <div className="ops-card-label">{label}</div>
    </div>
  );
}
