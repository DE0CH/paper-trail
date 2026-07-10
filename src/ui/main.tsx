import { createRoot } from 'react-dom/client';
import App from './App';
import './globals.css';

// No StrictMode: the app centers on an imperative pdf.js controller that
// attaches once to real DOM nodes; dev double-mounting would double-attach.
createRoot(document.getElementById('root')!).render(<App />);
