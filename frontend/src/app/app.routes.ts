import { Routes } from '@angular/router';
import { HomePage } from './pages/home';

export const routes: Routes = [
  { path: '', component: HomePage, title: 'Ludo Brawl' },
  // The room (and the 3D engine it pulls in) loads on demand, so the start page stays light.
  { path: 'room/:code', loadComponent: () => import('./pages/room').then((m) => m.RoomPage), title: 'Ludo Brawl – Room' },
  { path: '**', redirectTo: '' },
];
