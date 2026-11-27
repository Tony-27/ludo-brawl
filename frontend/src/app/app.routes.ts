import { Routes } from '@angular/router';
import { HomePage } from './pages/home';
import { RoomPage } from './pages/room';

export const routes: Routes = [
  { path: '', component: HomePage, title: 'Ludo Brawl' },
  { path: 'room/:code', component: RoomPage, title: 'Ludo Brawl – Room' },
  { path: '**', redirectTo: '' },
];
