import { useEffect, useState } from 'react';
import { api, errMsg } from '../lib/api';
import { setState, toast, useStore, type Settings } from '../lib/store';
import { ActionButton, Field, Panel, Seg } from '../components/ui';
import { britishVoices, speakable, voice, voiceSupport } from '../voice/voice';
import { SOUND_CATEGORY, SOUND_LABEL, sound, type SoundCategory, type SoundName } from '../audio/sound';
import { dateTime } from '../lib/format';
import { disconnect } from '../lib/events';

const CATEGORY_LABEL: Record<SoundCategory, string> = {
  interface: 'Interface (start-up, buttons, activation)',
  notifications: 'Notifications',
  missions: 'Missions (start, complete)',
  alerts: 'Alerts (warnings, errors)',
  ai: 'AI (listening, thinking, activation)',
};

const QUALITY_HELP: Record<Settings['graphicsQuality'], string> = {
  cinematic: 'Cinematic: full resolution, 2,600 particles, bloom and glass panels. Best on a desktop or recent iPad; steps down automatically if the frame rate drops.',
  balanced: 'Balanced: 1,600 particles, no bloom, 1.5× resolution. The default, tuned for an iPad (8th generation).',
  performance: 'Performance: 30 fps cap, 650 particles, 1× resolution, minimal background animation and no section morphing.',
};

interface AuditRow { id: number; at: string; actor: string; action: string; target: string | null; outcome: string; detail: unknown }

export default function SettingsSection() {
  const settings = useStore((s) => s.settings);
  const param = useStore((s) => s.sectionParam);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    const load = () => setVoices(britishVoices());
    load();
    if (voiceSupport.synthesis) speechSynthesis.addEventListener?.('voiceschanged', load);
    return () => {
      if (voiceSupport.synthesis) speechSynthesis.removeEventListener?.('voiceschanged', load);
    };
  }, []);
  if (!settings) return <div className="empty">Loading…</div>;

  const patch = async (p: Partial<Settings>) => {
    try {
      const s = await api.patch<Settings>('/api/settings', p);
      setState({ settings: s });
    } catch (err) {
      toast('error', 'Setting not saved', errMsg(err));
    }
  };

  return (
    <div className="stack">
      <h2 className="section-title">Settings</h2>
      <div className="grid two" style={{ alignItems: 'start' }}>
        <Panel title="Identity" idx="01">
          <Field label="Your name"><input className="input" defaultValue={settings.ownerName} onBlur={(e) => e.target.value && e.target.value !== settings.ownerName && void patch({ ownerName: e.target.value })} /></Field>
        </Panel>

        <Panel title="Intelligence" idx="02">
          <div className="stack">
            <Field label="Claude model"><input className="input mono" list="models" defaultValue={settings.aiModel} onBlur={(e) => e.target.value !== settings.aiModel && void patch({ aiModel: e.target.value.trim() })} /></Field>
            <datalist id="models"><option value="claude-opus-5-5" /><option value="claude-sonnet-5-5" /><option value="claude-haiku-5-5" /><option value="claude-fable-5-1" /></datalist>
            <Field label="Reasoning effort" group>
              <Seg value={settings.aiEffort} onChange={(v) => void patch({ aiEffort: v })} options={['low', 'medium', 'high', 'xhigh', 'max'].map((v) => ({ value: v as Settings['aiEffort'], label: v }))} />
            </Field>
            <label className="check"><input type="checkbox" checked={settings.aiWebSearch} onChange={(e) => void patch({ aiWebSearch: e.target.checked })} /><span className="small">Allow Anthropic server-side web search <span className="muted">(billed per search by Anthropic — this setting is your standing consent to that cost)</span></span></label>
            <label className="check"><input type="checkbox" checked={settings.autoApproveWrites} onChange={(e) => void patch({ autoApproveWrites: e.target.checked })} /><span className="small">Auto-approve low-risk writes <span className="muted">(saving memories, creating drafts, proposing patches). Sensitive actions always ask.</span></span></label>
          </div>
        </Panel>

        <Panel title="Voice" idx="03">
          <div className="stack">
            <div className="tiny muted">Recognition: {voiceSupport.recognition ? 'available' : 'not available in this browser'} · Speech: {voiceSupport.synthesis ? 'available' : 'not available'}</div>
            <Field label="British-English voice">
              <select className="select" value={settings.voiceName ?? ''} onChange={(e) => void patch({ voiceName: e.target.value || null })}>
                <option value="">Automatic (best en-GB voice)</option>
                {voices.map((v) => <option key={v.name} value={v.name}>{v.name}{v.localService ? '' : ' (network)'}</option>)}
              </select>
            </Field>
            {voices.length === 0 && voiceSupport.synthesis && <div className="tiny muted">No en-GB voices reported yet. On iPad: Settings → Accessibility → Spoken Content → Voices → English (UK) to download “Daniel” or an Enhanced voice.</div>}
            <Field label={`Rate ${settings.voiceRate.toFixed(2)}`}><input type="range" min={0.6} max={1.3} step={0.02} defaultValue={settings.voiceRate} onChange={(e) => void patch({ voiceRate: Number(e.target.value) })} /></Field>
            <Field label={`Pitch ${settings.voicePitch.toFixed(2)}`}><input type="range" min={0.6} max={1.3} step={0.02} defaultValue={settings.voicePitch} onChange={(e) => void patch({ voicePitch: Number(e.target.value) })} /></Field>
            <Field label="Wake phrase (strip from commands)"><input className="input" defaultValue={settings.wakePhrase} onBlur={(e) => e.target.value && void patch({ wakePhrase: e.target.value })} /></Field>
            <label className="check"><input type="checkbox" checked={settings.speakResponses} onChange={(e) => void patch({ speakResponses: e.target.checked })} /><span className="small">Speak replies to voice commands</span></label>
            <button className="btn sm" onClick={() => voice.speak(speakable('Good evening. All TOURBILLION CORE systems are nominal. Shall I continue?'), { voiceName: settings.voiceName, rate: settings.voiceRate, pitch: settings.voicePitch })}>Test voice</button>
          </div>
        </Panel>

        <Panel title="Sound" idx="04">
          <div className="stack">
            <label className="check"><input type="checkbox" checked={settings.soundEnabled} onChange={(e) => void patch({ soundEnabled: e.target.checked })} /><span className="small">Sound effects</span></label>
            <Field label={`Master volume ${Math.round(settings.soundVolume * 100)}%`}><input type="range" min={0} max={1} step={0.05} defaultValue={settings.soundVolume} onChange={(e) => void patch({ soundVolume: Number(e.target.value) })} /></Field>
            <div className="sound-cats">
              {(Object.keys(CATEGORY_LABEL) as SoundCategory[]).map((c) => (
                <div key={c} className="sound-cat">
                  <label className="check"><input type="checkbox" checked={settings.soundCategories[c]} onChange={(e) => void patch({ soundCategories: { ...settings.soundCategories, [c]: e.target.checked } })} /><span className="small">{CATEGORY_LABEL[c]}</span></label>
                  <div className="row" style={{ gap: 6 }}>
                    {(Object.keys(SOUND_CATEGORY) as SoundName[]).filter((n) => SOUND_CATEGORY[n] === c).map((n) => (
                      <button key={n} className="btn sm" title={`Preview: ${SOUND_LABEL[n]}`} onClick={async () => { await sound.unlock(); sound.play(n, { preview: true }); }}>{n}</button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <label className="check"><input type="checkbox" checked={settings.ambientSound} onChange={(e) => { void sound.unlock(); void patch({ ambientSound: e.target.checked }); }} /><span className="small">Ambient soundscape <span className="muted">(a quiet generative drone; fades in slowly, off by default)</span></span></label>
            {settings.ambientSound && <Field label={`Ambient volume ${Math.round(settings.ambientVolume * 100)}%`}><input type="range" min={0} max={1} step={0.05} defaultValue={settings.ambientVolume} onChange={(e) => void patch({ ambientVolume: Number(e.target.value) })} /></Field>}
            <div className="tiny muted">All sounds are synthesised live (Web Audio) — no recorded assets. Nothing plays before you tap INITIALISE, and they follow the iPad silent switch. Previews play even when a category is off.</div>
          </div>
        </Panel>

        <Panel title="Visual core & graphics" idx="05">
          <div className="stack">
            <Field label="Graphics quality" group>
              <Seg value={settings.graphicsQuality} onChange={(v) => void patch({ graphicsQuality: v })} options={[{ value: 'cinematic', label: 'Cinematic' }, { value: 'balanced', label: 'Balanced' }, { value: 'performance', label: 'Performance' }]} />
            </Field>
            <div className="tiny muted">{QUALITY_HELP[settings.batterySaver ? 'performance' : settings.graphicsQuality]}</div>
            <Field label="Core renderer" group>
              <Seg value={settings.coreRenderMode} onChange={(v) => { try { localStorage.removeItem('tc.core.fallback2d'); } catch { /* ignore */ } void patch({ coreRenderMode: v }); }} options={[{ value: 'auto', label: 'Auto' }, { value: '3d', label: '3D' }, { value: '2d', label: '2D' }, { value: 'static', label: 'Static' }]} />
            </Field>
            <label className="check"><input type="checkbox" checked={settings.batterySaver} onChange={(e) => void patch({ batterySaver: e.target.checked })} /><span className="small">Battery saver (forces Performance quality: 30 fps cap, fewer particles, lower resolution)</span></label>
            <label className="check"><input type="checkbox" checked={settings.bootSequence} onChange={(e) => void patch({ bootSequence: e.target.checked })} /><span className="small">Cinematic boot sequence <span className="muted">(skippable; never plays with reduced motion)</span></span></label>
            <div className="tiny muted">Auto uses 3D and drops to 2D automatically if the frame rate stays low. Choosing a mode here resets that decision. Reduced motion (iPad Settings → Accessibility → Motion) is always respected.</div>
          </div>
        </Panel>

        <SecurityPanel />
        <DataPanel />
        <Panel title="Install on iPad" idx="08">
          <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
            <li>Open TOURBILLION CORE in Safari (over HTTPS).</li>
            <li>Tap Share → <b>Add to Home Screen</b>.</li>
            <li>Launch it from the Home Screen for full-screen, standalone mode.</li>
          </ol>
          <div className="tiny muted" style={{ marginTop: 6 }}>Standalone: {matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone ? 'yes' : 'no'} · Service worker: {'serviceWorker' in navigator ? 'supported' : 'unsupported'}</div>
        </Panel>
      </div>
      <AuditPanel open={param === 'audit'} />
    </div>
  );
}

function SecurityPanel() {
  const [sessions, setSessions] = useState<{ id: string; createdAt: string; lastSeenAt: string; userAgent: string; ip: string; current: boolean }[]>([]);
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  useEffect(() => {
    api.get<typeof sessions>('/api/auth/sessions').then(setSessions);
  }, []);
  return (
    <Panel title="Security" idx="06">
      <div className="stack">
        <form className="stack" onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.post('/api/auth/passphrase', { current: cur, next });
            setCur('');
            setNext('');
            toast('success', 'Passphrase changed');
          } catch (err) {
            toast('error', 'Passphrase not changed', errMsg(err));
          }
        }}>
          <input className="input" type="password" placeholder="Current passphrase" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" />
          <input className="input" type="password" placeholder="New passphrase (10+ characters)" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={10} />
          <button className="btn sm" disabled={!cur || next.length < 10}>Change passphrase</button>
        </form>
        <div className="tiny muted">Sessions</div>
        {sessions.map((s) => <div key={s.id} className="tiny">{s.current ? '● this device' : '○'} {s.ip} · {s.userAgent.slice(0, 60)} · last seen {dateTime(s.lastSeenAt)}</div>)}
        <div className="row">
          <ActionButton className="btn sm danger" onClick={async () => { if (!confirm('Sign out every device, including this one?')) return; await api.post('/api/auth/sessions/revoke-all', {}); disconnect(); sound.play('shutdown'); setTimeout(() => location.reload(), 900); }}>Sign out everywhere</ActionButton>
          <ActionButton className="btn sm" onClick={async () => { await api.post('/api/auth/logout', {}); disconnect(); sound.play('shutdown'); setTimeout(() => location.reload(), 900); }}>Sign out</ActionButton>
        </div>
      </div>
    </Panel>
  );
}

function DataPanel() {
  const [confirmText, setConfirmText] = useState('');
  const [creds, setCreds] = useState(false);
  return (
    <Panel title="Your data" idx="07">
      <div className="stack">
        <a className="btn sm" href="/api/data/export" download>Export everything (JSON)</a>
        <div className="tiny muted">The export excludes stored credentials by design.</div>
        <hr className="sep" />
        <div className="small">Delete all conversations, memories, missions, reports, history and notifications:</div>
        <input className="input" placeholder="Type DELETE EVERYTHING" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
        <label className="check"><input type="checkbox" checked={creds} onChange={(e) => setCreds(e.target.checked)} /><span className="small">Also delete stored credentials (API keys, OAuth tokens)</span></label>
        <ActionButton className="btn sm danger" disabled={confirmText !== 'DELETE EVERYTHING'} onClick={async () => {
          await api.post('/api/data/wipe', { confirm: confirmText, includeCredentials: creds });
          toast('info', 'Data deleted');
          setConfirmText('');
        }}>Delete my data</ActionButton>
      </div>
    </Panel>
  );
}

function AuditPanel({ open }: { open: boolean }) {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [show, setShow] = useState(open);
  useEffect(() => {
    if (show) api.get<AuditRow[]>('/api/audit?limit=300').then(setRows);
  }, [show]);
  return (
    <Panel title="Audit log" idx="09" actions={<button className="btn sm" onClick={() => setShow(!show)}>{show ? 'Hide' : 'Show'}</button>}>
      {show && (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Outcome</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}><td className="tiny mono">{dateTime(r.at)}</td><td className="tiny">{r.actor}</td><td className="tiny mono">{r.action}</td><td className="tiny">{r.target}</td><td><span className={`badge ${r.outcome === 'ok' ? 'green' : r.outcome === 'error' ? 'red' : r.outcome === 'denied' ? 'amber' : ''}`}>{r.outcome}</span></td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
