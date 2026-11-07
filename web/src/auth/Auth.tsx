import { useState } from 'react';
import { api, errMsg } from '../lib/api';
import { setState } from '../lib/store';
import { Logo } from '../components/icons';

/** First-run setup (needs the server's one-time setup code) and sign-in. */
export function AuthScreen({ setupRequired }: { setupRequired: boolean }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('Keenan');
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    if (setupRequired && pass !== pass2) return setError('The passphrases do not match.');
    setBusy(true);
    try {
      if (setupRequired) await api.post('/api/auth/setup', { setupCode: code, passphrase: pass, ownerName: name });
      else await api.post('/api/auth/login', { passphrase: pass });
      setState({ auth: { checked: true, setupRequired: false, authenticated: true } });
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="boot">
      <Logo size={88} />
      <div className="title">TOURBILLION CORE</div>
      <form
        className="panel stack"
        style={{ width: 'min(420px, 100%)', textAlign: 'left' }}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="panel-head">
          <h2>{setupRequired ? 'First-run setup' : 'Owner sign-in'}</h2>
        </div>
        {setupRequired && (
          <>
            <div className="small muted">Enter the one-time setup code shown in the server console (also in <span className="mono">data/setup-code.txt</span>), then choose a passphrase. This stops anyone else claiming your system first.</div>
            <label className="field">
              <span>Setup code</span>
              <input className="input mono" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="XXXXX-XXXXX" autoCapitalize="characters" autoComplete="one-time-code" required />
            </label>
            <label className="field">
              <span>Your name</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
            </label>
          </>
        )}
        <label className="field">
          <span>Passphrase</span>
          <input className="input" type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete={setupRequired ? 'new-password' : 'current-password'} minLength={setupRequired ? 10 : 1} required autoFocus={!setupRequired} />
        </label>
        {setupRequired && (
          <label className="field">
            <span>Confirm passphrase</span>
            <input className="input" type="password" value={pass2} onChange={(e) => setPass2(e.target.value)} autoComplete="new-password" required />
          </label>
        )}
        {error && <div className="small" style={{ color: 'var(--red)' }} role="alert">{error}</div>}
        <button className="btn primary" disabled={busy} type="submit">
          {setupRequired ? 'Create owner and enter' : 'Enter'}
        </button>
      </form>
    </div>
  );
}
