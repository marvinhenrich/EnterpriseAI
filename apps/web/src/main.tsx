import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/index.css';
import App from './App';
import { ladeBranding, ladeModule } from './lib/branding';

// Erscheinungsbild und aktive Module VOR dem ersten Rendern laden, damit die
// Oberfläche nicht kurz mit neutralen Vorgaben aufblitzt. Schlägt es fehl,
// wird trotzdem gestartet — mit den Vorgaben, nicht mit einer Fehlerseite.
await ladeBranding().catch(() => {});
void ladeModule();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
