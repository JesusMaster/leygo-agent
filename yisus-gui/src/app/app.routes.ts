import { Routes } from '@angular/router';

import { authGuard } from './guards/auth.guard';

export const routes: Routes = [
  { path: 'login',        loadComponent: () => import('./components/login/login').then(m => m.LoginComponent) },
  { path: '', redirectTo: 'chat', pathMatch: 'full' },
  { path: 'chat',         loadComponent: () => import('./components/chat/chat').then(m => m.ChatComponent), canActivate: [authGuard] },
  { path: 'usage',        loadComponent: () => import('./components/usage/usage').then(m => m.UsageComponent), canActivate: [authGuard] },
  { path: 'channels',     loadComponent: () => import('./components/channels/channels').then(m => m.ChannelsComponent), canActivate: [authGuard] },
  { path: 'tokens',       loadComponent: () => import('./components/tokens/tokens').then(m => m.TokensComponent), canActivate: [authGuard] },
  { path: 'escalations',  loadComponent: () => import('./components/escalations/escalations').then(m => m.EscalationsComponent), canActivate: [authGuard] },
  { path: 'webhooks',     loadComponent: () => import('./components/webhooks/webhooks').then(m => m.WebhooksComponent), canActivate: [authGuard] },
  { path: 'tasks',        loadComponent: () => import('./components/tasks/tasks').then(m => m.TasksComponent), canActivate: [authGuard] },
  { path: 'reminders',    redirectTo: 'tasks' },
  { path: 'settings',     loadComponent: () => import('./components/settings/settings').then(m => m.SettingsComponent) },
  { path: '**', redirectTo: 'chat' },
];
