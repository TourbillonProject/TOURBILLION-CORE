import { useEffect, useState } from 'react';
import type { IntegrationStatus } from '@tc/shared';
import { api, errMsg } from '../lib/api';
import { setState, toast, useStore } from '../lib/store';
import { ActionButton, Dot, INTEGRATION_LABEL, Panel, integrationDot } from '../components/ui';
import { dateTime, ago } from '../lib/format';

interface Paired { id: number; name: string; createdAt: string; lastSeenAt: string | null; connected: boolean; hello: { hostname: string; platform: string; bridgeVersion: string } | null }

const CREDENTIAL_LABEL: Record<string, string> = { youtube: 'YouTube Data API key', search: 'Brave Search API key', github: 'GitHub token (read-only)' };

export default function Apps() {
  const integrations = useStore((s) => s.integrations);
  const refresh = () => api.get<IntegrationStatus[]>('/api/integrations').then((i) => setState({ integrations: i }));
  useEffect(() => {
    void refresh();
  }, []);
  return (
    <div className="stack">
      <div>
        <h2 className="section-title">Connected apps</h2>
        <p className="section-sub">Every connector shows its real state. Nothing is reported as connected until a live test succeeds. Credentials are stored encrypted on the server and never sent back to this iPad.</p>
      </div>
      <div className="grid auto" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', alignItems: 'start' }}>
        {integrations.map((i) => <IntegrationCard key={i.id} i={i} onChange={refresh} />)}
      </div>
    </div>
  );
}

function IntegrationCard({ i, onChange }: { i: IntegrationStatus; onChange: () => void }) {
  const [value, setValue] = useState('');
  const test = async () => {
    try {
      const s = await api.post<IntegrationStatus>(`/api/integrations/${i.id}/test`, {}, { timeoutMs: 60_000 });
      toast(s.state === 'connected' ? 'success' : 'error', `${i.name}: ${INTEGRATION_LABEL[s.state]}`, s.lastError ?? '');
    } catch (err) {
      toast('error', `${i.name} test failed`, errMsg(err));
    }
    onChange();
  };
  return (
    <Panel title={i.name} actions={<span className="chip" data-testid={`state-${i.id}`}><Dot kind={integrationDot(i.state)} /> {INTEGRATION_LABEL[i.state]}</span>}>
      <div className="small muted" style={{ marginBottom: 8 }}>{i.description}</div>
      <div className="tiny" style={{ marginBottom: 6 }}><b>Permissions</b><ul style={{ margin: '2px 0', paddingLeft: 18 }}>{i.permissions.map((p) => <li key={p}>{p}</li>)}</ul></div>
      <div className="tiny muted">Requires: {i.requires.join('; ')}</div>
      <div className="tiny muted">Last successful connection: {i.lastSuccessAt ? `${dateTime(i.lastSuccessAt)} (${ago(i.lastSuccessAt)})` : 'never'}</div>
      {i.lastError && <div className="tiny" style={{ color: 'var(--red)', marginTop: 4 }}>Last error: {i.lastError}</div>}
      {Object.keys(i.details).length > 0 && (
        <details style={{ marginTop: 6 }}><summary className="tiny muted" style={{ cursor: 'pointer' }}>Details</summary><pre style={{ maxHeight: 160 }}>{JSON.stringify(i.details, null, 2)}</pre></details>
      )}
      <div className="stack" style={{ marginTop: 10 }}>
        {i.id === 'claude' && <ClaudeConnect i={i} onChange={onChange} />}
        {i.id === 'gmail' && (
          <div className="row">
            {i.state === 'not_configured' ? <div className="tiny muted">Set TC_GOOGLE_CLIENT_ID, TC_GOOGLE_CLIENT_SECRET and TC_PUBLIC_URL on the server (see docs/SETUP.md), then restart.</div> : (
              <ActionButton className="btn primary sm" onClick={async () => {
                try {
                  const r = await api.get<{ url: string }>('/api/integrations/gmail/start');
                  location.href = r.url;
                } catch (err) {
                  toast('error', 'Cannot start Google sign-in', errMsg(err));
                }
              }}>{(i.details as { authorised?: boolean }).authorised ? 'Reconnect Google' : 'Connect with Google'}</ActionButton>
            )}
          </div>
        )}
        {CREDENTIAL_LABEL[i.id] && (
          <form className="row nowrap" onSubmit={async (e) => {
            e.preventDefault();
            try {
              const s = await api.post<IntegrationStatus>(`/api/integrations/${i.id}/credential`, { value });
              setValue('');
              toast(s.state === 'connected' ? 'success' : 'warning', `${i.name}: ${INTEGRATION_LABEL[s.state]}`, s.lastError ?? '');
              onChange();
            } catch (err) {
              toast('error', 'Credential rejected', errMsg(err));
            }
          }}>
            <input className="input" type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder={CREDENTIAL_LABEL[i.id]} autoComplete="off" />
            <button className="btn sm" disabled={value.length < 10}>Save</button>
          </form>
        )}
        {i.id === 'bridge' && <BridgePanel />}
        <div className="row">
          {i.canConnect && i.state !== 'not_configured' && <ActionButton className="btn sm" onClick={test}>Test connection</ActionButton>}
          {i.canDisconnect && i.state !== 'not_configured' && <ActionButton className="btn sm danger" onClick={async () => { if (!confirm(`Disconnect ${i.name}? Stored credentials for it are deleted.`)) return; await api.post(`/api/integrations/${i.id}/disconnect`, {}); onChange(); }}>Disconnect</ActionButton>}
        </div>
      </div>
    </Panel>
  );
}

function ClaudeConnect({ i, onChange }: { i: IntegrationStatus; onChange: () => void }) {
  const [key, setKey] = useState('');
  const [info, setInfo] = useState<{ keySource: string; keyPreview: string | null; billingNote: string } | null>(null);
  useEffect(() => {
    api.get<typeof info>('/api/ai/status').then(setInfo);
  }, [i.state]);
  return (
    <div className="stack">
      {info && <div className="tiny">Key: {info.keyPreview ? <span className="mono">{info.keyPreview}</span> : 'none'} ({info.keySource})</div>}
      <form className="row nowrap" onSubmit={async (e) => {
        e.preventDefault();
        try {
          const r = await api.post<{ ok: boolean; integration: IntegrationStatus }>('/api/ai/key', { apiKey: key });
          setKey('');
          toast(r.ok ? 'success' : 'error', r.ok ? 'Claude connected' : 'Key saved, but the test failed', r.integration.lastError ?? '');
          onChange();
        } catch (err) {
          toast('error', 'Key rejected', errMsg(err));
        }
      }}>
        <input className="input" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-ant-… (Anthropic API key)" autoComplete="off" data-testid="anthropic-key" />
        <button className="btn primary sm" disabled={key.length < 20}>Connect</button>
      </form>
      <div className="tiny muted">{info?.billingNote ?? 'API usage is billed separately from a Claude.ai subscription.'} Your Claude.ai password and session are never requested or used.</div>
    </div>
  );
}

function BridgePanel() {
  const [paired, setPaired] = useState<Paired[]>([]);
  const [code, setCode] = useState<{ code: string; expiresAt: string; serverUrl: string | null } | null>(null);
  const [name, setName] = useState('My computer');
  const load = () => api.get<Paired[]>('/api/bridge').then(setPaired);
  useEffect(() => {
    void load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);
  const server = code?.serverUrl ?? location.origin;
  return (
    <div className="stack">
      {paired.map((b) => (
        <div key={b.id} className="row between">
          <span className="small"><Dot kind={b.connected ? 'ok' : 'off'} /> {b.name}{b.hello ? ` — ${b.hello.hostname} (${b.hello.platform})` : ''}</span>
          <span className="row"><span className="tiny muted">{b.connected ? 'online' : b.lastSeenAt ? `seen ${ago(b.lastSeenAt)}` : 'never connected'}</span><button className="btn sm danger" onClick={async () => { if (confirm(`Revoke ${b.name}? It will need to pair again.`)) { await api.del(`/api/bridge/${b.id}`); void load(); } }}>Revoke</button></span>
        </div>
      ))}
      <div className="row nowrap">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Computer name" />
        <ActionButton className="btn sm primary" onClick={async () => setCode(await api.post('/api/bridge/pairing', { name }))}>Pair a computer</ActionButton>
      </div>
      {code && (
        <div className="panel flat" style={{ padding: 10 }}>
          <div className="small">Pairing code (expires {new Date(code.expiresAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}):</div>
          <div className="display" style={{ fontSize: 26, letterSpacing: '.3em', margin: '4px 0 8px', color: 'var(--cyan)' }} data-testid="pairing-code">{code.code}</div>
          <div className="tiny muted">On the computer with Blender / Roblox Studio (Node.js 22+), in a copy of this repository:</div>
          <pre>{`npm install && npm run build -w bridge\nnode bridge/dist/bridge.js init        # then edit ~/.tourbillion-bridge/config.json\nnode bridge/dist/bridge.js pair --server ${server} --code ${code.code}\nnode bridge/dist/bridge.js start`}</pre>
          <div className="tiny muted">The bridge only operates inside folders you list in its config file and never accepts arbitrary commands.</div>
        </div>
      )}
    </div>
  );
}
