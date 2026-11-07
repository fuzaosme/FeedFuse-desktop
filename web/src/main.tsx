import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ConfirmDialog } from './components/ConfirmDialog';
import './styles/index.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(
  <StrictMode>
    <>
      <App />
      {/* 确认框挂在 App 之外：整页视图（生词本）会整体替换 App 的内容，挂在里面就会被卸载掉。 */}
      <ConfirmDialog />
    </>
  </StrictMode>,
);
