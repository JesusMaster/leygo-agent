/**
 * URL base del backend, única para toda la GUI (ApiService, AuthService, markdown…).
 * 1) La que el usuario guardó en Ajustes.
 * 2) En desarrollo (ng serve :4200 o localhost) → mismo host en :4000.
 * 3) En producción → mismo origen (Caddy enruta /api, /run, /a2a… al backend).
 */
export function apiBaseUrl(): string {
  let guardada: string | null = null;
  try { guardada = localStorage.getItem('yisus_api_url'); } catch {}
  if (guardada) return guardada;
  const { protocol, hostname, port, origin } = window.location;
  if (port === '4200' || hostname === 'localhost' || hostname === '127.0.0.1') return `${protocol}//${hostname}:4000`;
  return origin;
}
