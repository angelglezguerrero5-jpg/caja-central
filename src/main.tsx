import { render } from 'preact';
import { App } from './ui/App';
import { ErrorBoundary } from './ui/ErrorBoundary';
import './styles.css';
import { registerSW } from './pwa';
import { installKeyboardMode } from './ui/keyboard';

registerSW();
installKeyboardMode();
// El HTML trae un «Cargando caja…» estático dentro de #app para el instante antes de que cargue el JS; Preact no lo quita
// por sí solo, así que se vacía el contenedor antes de pintar (si no, el texto se queda arriba para siempre).
const root = document.getElementById('app')!;
root.textContent = '';
render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
  root,
);
