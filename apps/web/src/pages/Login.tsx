import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useAuth } from '../lib/auth';
import { ApiError } from '../lib/api';
import { Spinner } from '../components/Spinner';
import { Logo } from '../components/Logo';
import { branding } from '../lib/branding';
import { useT } from '../i18n';

export function Login() {
  const t = useT();
  const { login } = useAuth();
  const nav = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      await login(username.trim(), password);
      nav('/', { replace: true });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Anmeldung fehlgeschlagen. Bitte erneut versuchen.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="grid h-full place-items-center p-6"
      style={{ background: 'radial-gradient(900px 480px at 50% -10%, var(--color-accent-soft), transparent 60%), var(--color-bg)' }}
    >
      <motion.form
        onSubmit={submit}
        initial={{ opacity: 0, y: 14, scale: 0.99 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        className="w-[min(92vw,384px)] rounded-card border border-border bg-surface p-9 shadow-soft"
        noValidate
      >
        <div className="mb-6 flex items-center gap-2.5">
          <Logo size={32} />
          <span className="text-[17px] font-semibold tracking-tight">{branding().appName}</span>
        </div>

        <h1 className="mb-1 text-[19px] font-semibold">{t('anmeldung.titel')}</h1>
        <p className="mb-6 text-[13.5px] leading-relaxed text-muted">
          {t('anmeldung.hinweis')}
        </p>

        <label className="mb-1.5 block text-[12.5px] font-medium text-fg/80">{t('anmeldung.benutzer')}</label>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          autoFocus
          placeholder="m.mustermann"
          className="mb-4 w-full rounded-[10px] border border-border-strong bg-white px-3.5 py-2.5 text-[14.5px] outline-none transition focus:border-accent"
        />

        <label className="mb-1.5 block text-[12.5px] font-medium text-fg/80">{t('anmeldung.passwort')}</label>
        <div className="relative mb-1">
          <input
            type={show ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            placeholder="••••••••"
            className="w-full rounded-[10px] border border-border-strong bg-white px-3.5 py-2.5 pr-16 text-[14.5px] outline-none transition focus:border-accent"
          />
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg px-2 py-1.5 text-[12px] text-muted transition hover:bg-surface-2 hover:text-accent"
          >
            {show ? t('anmeldung.verbergen') : t('anmeldung.zeigen')}
          </button>
        </div>

        {err && (
          <motion.div
            initial={{ opacity: 0, y: -3 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-3 text-[13px] leading-snug text-danger"
          >
            {err}
          </motion.div>
        )}

        <motion.button
          type="submit"
          disabled={busy}
          whileTap={{ scale: 0.99 }}
          className="mt-5 flex w-full items-center justify-center gap-2.5 rounded-[10px] bg-accent py-3 text-[14.5px] font-semibold text-white transition hover:bg-accent-hover disabled:opacity-70"
          style={{ boxShadow: '0 6px 16px var(--color-ring)' }}
        >
          {busy && <Spinner size={15} />}
          {busy ? `${t('anmeldung.absenden')} …` : t('anmeldung.absenden')}
        </motion.button>

        <div className="mt-6 text-center text-[11.5px] text-faint">{t('anmeldung.fuss')}</div>
      </motion.form>
    </div>
  );
}
