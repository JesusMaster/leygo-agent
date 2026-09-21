# yisus-gui

Interfaz de administración de **Yisus Agent**. Angular 21 standalone, zoneless,
con el mismo sistema de diseño de `leygo-gui` (tokens de color, Space Grotesk,
Phosphor icons, tema claro/oscuro).

## Correr en desarrollo

```bash
npm install
npm start          # http://localhost:4200
```

`ng serve` proxea `/api`, `/run` y `/run_sse` al backend en `http://localhost:4000`,
así que en desarrollo no hay CORS de por medio. Si apuntas a otro host, configúralo
en **Ajustes** dentro de la app.

## Vistas

| Vista | Qué hace | Backend |
|---|---|---|
| **Chat** | Conversar con el agente por streaming | `POST /run_sse` |
| **Consumo** | Gasto del mes por canal, agente y modelo; edición de presupuestos | `/api/usage`, `/api/budgets`, `/api/usage/budget` |
| **Canales y tools** | Qué herramientas ve cada canal (Telegram, Buzz, API) | `/api/channels` |
| **Tokens A2A** | Crear, editar alcance y revocar tokens del canal entre agentes | `/api/a2a/tokens` |
| **Escalamientos** | Lo que el triage dejó pendiente de tu decisión | `/api/escalations` |
| **Webhooks** | Webhooks con IA: crear, pausar, eliminar | `/api/webhooks` |
| **Recordatorios** | Recordatorios agendados pendientes | `/api/reminders` |
| **Ajustes** | URL del backend y clave de administración | `/api/admin/me` |

## Seguridad

Los endpoints de administración exigen `X-Admin-Key` cuando el backend tiene
`ADMIN_API_KEY` definida. La GUI la guarda en `localStorage` y la adjunta con un
interceptor. **Define esa variable antes de exponer el puerto**: desde acá se crean
y revocan los tokens de A2A.

El backend solo acepta CORS desde los orígenes de `GUI_ORIGIN`
(por defecto `http://localhost:4200`).

## Exponerla fuera de localhost

`ng serve` bloquea hosts desconocidos. El dominio ya está declarado en
`angular.json` → `serve.options.allowedHosts`; agrega ahí cualquier otro.

Dos advertencias que van juntas:

1. **`ng serve` es un servidor de desarrollo**: sin compresión, con source maps y
   recarga en caliente. Para algo que quede publicado, usa `npm run build` y sirve
   `dist/yisus-gui/browser` con nginx o similar (`nginx.conf` de ejemplo en el repo
   de Leygo sirve como base).
2. El backend solo acepta CORS desde los orígenes de `GUI_ORIGIN`. Si publicas la
   GUI en otro dominio, agrégalo ahí.

Si la GUI vive en un dominio distinto al backend (por ejemplo `gui-yisus` y
`yisus`), configura la URL del backend en **Ajustes**: por defecto asume el mismo
host en el puerto 4000.

## Notas

- El cambio de herramientas de Telegram, Buzz y API se escribe en
  `config/channels.json`, pero esos agentes se construyen al arrancar: **aplica al
  reiniciar el servicio**. Los tokens de A2A sí aplican en caliente.
- La inlinización de Google Fonts está desactivada en el build para no depender de
  la red al compilar.
