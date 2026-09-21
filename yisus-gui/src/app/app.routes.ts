import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', redirectTo: 'chat', pathMatch: 'full' },
  { path: 'chat',         loadComponent: () => import('./components/chat/chat').then(m => m.ChatComponent) },
  { path: 'usage',        loadComponent: () => import('./components/usage/usage').then(m => m.UsageComponent) },
  { path: 'channels',     loadComponent: () => import('./components/channels/channels').then(m => m.ChannelsComponent) },
  { path: 'tokens',       loadComponent: () => import('./components/tokens/tokens').then(m => m.TokensComponent) },
  { path: 'escalations',  loadComponent: () => import('./components/escalations/escalations').then(m => m.EscalationsComponent) },
  { path: 'webhooks',     loadComponent: () => import('./components/webhooks/webhooks').then(m => m.WebhooksComponent) },
  { path: 'reminders',    loadComponent: () => import('./components/reminders/reminders').then(m => m.RemindersComponent) },
  { path: 'settings',     loadComponent: () => import('./components/settings/settings').then(m => m.SettingsComponent) },
  { path: '**', redirectTo: 'chat' },
];
