import { render } from 'preact';
import { App } from './ui/App';
import './styles.css';
import { registerSW } from './pwa';

registerSW();
render(<App />, document.getElementById('app')!);
