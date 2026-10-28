import { createRoot } from 'react-dom/client';
import React from 'react';

function ConfigurationApp() {
  return (
    <main>
      <h1>系统参数配置</h1>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigurationApp />
  </React.StrictMode>,
);
