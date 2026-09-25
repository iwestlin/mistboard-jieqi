import './style.css';
import { App } from './ui/app.js';
import { newGameState } from './ui/state.js';

const root = document.getElementById('app');
if (!root) throw new Error('#app not found');

if (!window.location.hash) window.location.hash = '#/play';
new App(root, newGameState()).start();
