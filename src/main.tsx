import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { useUI } from './store';
import { App } from './ui/App';
import { ErrorReporter, installErrorHandlers, showErrorDialog } from './ui/errors';
import './ui/styles.css';

// Installed before anything else runs, so a failure during start-up is caught too.
export const errors = new ErrorReporter({
  notify: (record) => {
    // stop the simulation so a fault cannot quietly run the company into the ground
    try { useUI.getState().set({ speed: 0 }); } catch { /* the store may be what failed */ }
    showErrorDialog(record, () => { /* the player resumes with the speed controls */ });
  },
});
installErrorHandlers(window, errors);
(window as unknown as { __mlErrors: typeof errors.records }).__mlErrors = errors.records;
(window as unknown as { __mlReport: (e: Error) => void }).__mlReport = (e) => { errors.report('render', e, undefined, true); };

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
