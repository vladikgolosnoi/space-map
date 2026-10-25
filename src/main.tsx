import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import Portal from './Portal';
import { offline } from './offline';
import './styles.css';
import './product-map.css';
import './mobile.css';
import './portal.css';
import './workspace.css';

const path = location.pathname;
const application = offline || /^\/(?:map|editor|embed)\/[^/]+$/.test(path) ? <App /> : <Portal />;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {application}
  </StrictMode>,
);
