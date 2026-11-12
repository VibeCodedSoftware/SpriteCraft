import { createRoot } from 'react-dom/client';
import { ed } from './editor/editor';
import './editor/tools';
import { App } from './ui/App';
import './styles.css';

createRoot(document.getElementById('root')!).render(<App />);

// A small handle for automated checks in the running app. It gives no access beyond what the interface already has.
(window as any).__spritecraft = ed;
