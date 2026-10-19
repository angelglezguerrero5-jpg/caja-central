import { Component, type ComponentChildren } from 'preact';
import { EmergencyDump } from './Emergency';

/**
 * Si una pantalla falla al dibujarse, en vez de dejar la app en blanco se muestra una salida: recargar o bajar una copia
 * de emergencia de los datos (que no depende de la pantalla que falló).
 */
export class ErrorBoundary extends Component<{ children: ComponentChildren }, { error: unknown }> {
  state = { error: null as unknown };
  componentDidCatch(error: unknown) {
    console.error('Error de pantalla', error);
    this.setState({ error: error ?? new Error('Error desconocido') });
  }
  render() {
    if (!this.state.error) return this.props.children;
    const detail = this.state.error instanceof Error ? this.state.error.message : String(this.state.error);
    return (
      <div class="fatal" role="alert" data-testid="crash">
        <h1>Algo falló al dibujar la pantalla</h1>
        <p>Cierra la app y ábrela otra vez. No borres los datos de la app ni la desinstales: primero descarga la copia de emergencia.</p>
        <button class="primary" data-testid="crash-reload" onClick={() => location.reload()}>
          Recargar
        </button>
        <EmergencyDump />
        <details>
          <summary>Detalle técnico</summary>
          <p class="hint">{detail}</p>
        </details>
      </div>
    );
  }
}
