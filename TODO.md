# 🧠 Yisus Agent — Roadmap & TODO Backlog

Archivo de seguimiento y control para el desarrollo evolutivo de **Yisus Agent** (asistente ejecutivo y clon digital de Jesús Leiva, CTO de Apprecio).

---

## 🏛️ 1. Cerebro Digital (Obsidian & Qdrant)

### Implementado ✅
- [x] **Infraestructura Qdrant**: Cliente y conexión configurada en `src/services/qdrant.service.ts`.
- [x] **Colecciones Vectoriales**: Creación automática de `core_knowledge` (arquitectura) y `episodic_memory` (reuniones y contexto temporal) con métrica Coseno y dimensión 768.
- [x] **Embeddings con Ollama**: Integración con `https://ollama.openip.cl` (`nomic-embed-text:latest`) y fallback a Gemini.
- [x] **Pipeline de Ingesta Batch**: Script `scripts/sync_obsidian.ts` con chunking por encabezados `#`, `##`, `###`, sub-chunking inteligente para secciones grandes (>3500 chars) y extracción de wikilinks y tags.
- [x] **Subagente `knowledge_agent`**: Herramienta `knowledge_search` conectada al coordinador para responder consultas técnicas sobre la arquitectura de Apprecio.

### Pendiente ⏳
- [ ] **Watcher en tiempo real para Obsidian**:
  - Implementar un daemon/watcher con `chokidar` (`scripts/watch_obsidian.ts` o servicio en segundo plano).
  - Detectar eventos `add`, `change` y `unlink` de archivos `.md` en el vault.
  - Sincronizar automáticamente en Qdrant al guardar (`Cmd + S`) en Obsidian sin intervención manual.
- [ ] **Manejo de borrado y renombrado de notas**:
  - Eliminar puntos en Qdrant cuando una nota se borra o se renombra en Obsidian.
- [ ] **Control de Hashes Incrementales**:
  - Almacenar un hash SHA256 o timestamp por archivo en SQLite o archivo `.sync_state.json` para no re-procesar notas sin cambios durante las sincronizaciones completas.
- [ ] **Búsqueda Híbrida (Hybrid Search)**:
  - Combinar búsqueda vectorial densa con búsqueda por texto léxico (BM25 o Sparse Vectors de Qdrant) y filtros por tags/links.

---

## 📅 2. Memoria Episódica & Contextual (`episodic_memory`)

### Implementado ✅
- [x] **Ingesta de Google Meet (Reuniones)**:
  - Script `scripts/sync_meet_recordings.ts` (`npm run sync:meet`).
  - Lector directo a Google Drive que detecta y descarga automáticamente las minutas de Gemini y transcripciones de Google Meet.
  - Extracción de metadata: Título, Fecha, Participantes, Resumen Ejecutivo y Acuerdos.
  - Chunking inteligente e indexación en la colección `episodic_memory` de Qdrant.
- [x] **Herramienta `episodic_search` / `meeting_search`**:
  - Conectada a `knowledge_agent` y `account_agent` para buscar acuerdos, fechas, compromisos y transcripciones de reuniones pasadas, conversaciones de Google Chat y correos de Gmail con badges de origen (`[GOOGLE MEET]`, `[GOOGLE CHAT]`, `[CORREO GMAIL]`).
- [x] **Herramienta bajo demanda `meeting_ingest`**:
  - Permite procesar e indexar una reunión individual pasando su URL de Google Drive/Docs (ej: `https://docs.google.com/document/d/...`), ID de archivo, nombre o ruta a un archivo local en disco.
  - Extracción automática de fecha, título, participantes, resumen ejecutivo y acuerdos principales usando Gemini Flash para minutas y transcripciones no estructuradas.
  - Vectorización con Ollama (`nomic-embed-text:latest` en `https://ollama.openip.cl`) y almacenamiento en la colección `episodic_memory` de Qdrant.
  - Disponible en `knowledge_agent` y `account_agent`.
- [x] **Fase 3: Consolidación de Chats y Correos en la Memoria Episódica**:
  - Servicio `ContextConsolidationService` (`src/services/context_consolidation.service.ts`).
  - Extracción y filtrado inteligente con Gemini 2.5 Flash: descarta ruido (notificaciones, confirmaciones vacías, conversaciones casuales) y preserva decisiones, acuerdos técnicos, tareas y fechas límite.
  - Idempotencia y control de duplicados mediante SQLite (`consolidated_threads` en `data/reminders.db`).
  - Cron nocturno programado en `SchedulerService` a las 21:00 CLT (Lunes a Viernes) con reporte a Telegram.
  - Script CLI `npm run sync:context` (`scripts/sync_context.ts`).
  - Herramienta para agentes `consolidate_context`.

### Pendiente ⏳
- [ ] **Métricas y Purga de Contexto Antiguo**:
  - Reglas opcionales de retención y limpieza de acuerdos obsoletos en `episodic_memory`.

---

## 📬 3. Google Workspace & Seguridad 2FA

### Implementado ✅
- [x] **Gmail**:
  - Búsqueda de correos (`gmail_search_emails`).
  - Lectura completa de mensajes e hilos (`gmail_read_email`).
  - Creación de borradores insertados en el mismo hilo con headers `In-Reply-To` y `References` (`gmail_create_draft`).
  - Marcar correos como leídos (`gmail_mark_as_read`).
  - Creación y asignación de etiquetas con colores (`gmail_add_label`).
- [x] **Google Calendar**:
  - Consulta de disponibilidad y reuniones (`calendar_list_events`).
  - Creación y agendamiento de eventos con invitados (`calendar_create_event`).
- [x] **Google Drive**:
  - Búsqueda y lectura de documentos y Google Docs (`drive_search_files`, `drive_read_file`).
- [x] **Google Chat**:
  - Listar salas y DMs (`chat_list_spaces`).
  - Lectura en bulk masiva con paginación y orden cronológico (`chat_read_messages`).
  - Envío y respuesta a hilos de mensajes (`chat_send_message`).
- [x] **2FA Man-in-the-Middle vía Telegram**:
  - Bot `@Leygo_bot` con teclado interactivo de botones (`Autorizar 5 min` / `Denegar`).
  - Ventana de gracia de 5 minutos para llamadas encadenadas sin repetición de alertas.
- [x] **Telegram Conversacional (Texto y Notas de Voz)**:
  - Bot interactivo bidireccional (`src/services/telegram_bot.service.ts`).
  - Transcripción nativa de notas de voz (`.oga`, `.ogg`, `.mp3`) con Gemini 2.5 Flash directamente sin dependencias de sistema (ffmpeg).
  - Integración fluida con el Runner de ADK (`runner.runAsync`) y formateador de mensajes HTML para Telegram.
  - Filtro de seguridad estricto que solo responde a `TELEGRAM_CHAT_ID`.
- [x] **Background Scheduler & Morning Digest Proactivo**:
  - Servicio cron en background (`src/services/scheduler.service.ts`) configurado en timezone `America/Santiago`.
  - **Morning Digest diario a las 08:30 CLT**: sintetiza Google Calendar del día + correos de Gmail sin leer y envía un resumen ejecutivo estructurado a Telegram.
  - Sincronización nocturna automática de reuniones de Google Meet a las 20:00 CLT.
  - **Persistencia en SQLite (`data/reminders.db`)**: los recordatorios se guardan localmente en SQLite mediante el soporte nativo de Node.js (`node:sqlite`). Al reiniciar el servidor, recupera automáticamente los recordatorios pendientes para no perder ninguna instrucción programada.
  - Herramientas para el agente: `schedule_reminder`, `list_scheduled_reminders` y `trigger_morning_digest`.

- [x] **Acciones de respuesta rápida por Telegram (Borradores de Correo)**:
  - Servicio `TelegramQuickActionsService` (`src/services/telegram_quick_actions.service.ts`).
  - Al crearse un borrador en Gmail (`gmail_create_draft`), emite automáticamente una tarjeta ejecutiva a Telegram con vista previa (Destinatario, Asunto y cuerpo).
  - Botones interactivos inline:
    - **`[🚀 Enviar ahora]`**: despacha el correo vía Gmail API (`users.drafts.send`), notifica feedback con toast nativo y actualiza el mensaje a estado enviado bloqueando re-intentos.
    - **`[⏳ Enviar después]`**: preserva el borrador intacto en la bandeja de Gmail y actualiza el mensaje a guardado.
  - Herramienta para el agente `gmail_send_draft` para despachar borradores por comando de voz o texto.

### Pendiente ⏳
- [ ] **Acciones de respuesta rápida para Calendar**:
  - Botones para confirmar o rechazar invitaciones a eventos directamente desde Telegram.

---

## 🤖 4. Sistema Multiagente (ADK)

### Implementado ✅
- [x] **Coordinator (`Yisus`)**:
  - Personalidad y tono de Jesús Leiva (directo, ejecutivo, sin modismos de bot).
  - Desbloqueo de vetos para análisis privados de la propia cuenta y comunicación interna.
  - Herramientas integradas para recordatorios y Morning Digest.
- [x] **`account_agent`**: Subagente para Gmail, Calendar, Drive y Google Chat.
- [x] **`faq_agent`**: Subagente para consultas de soporte de Apprecio conectadas a MongoDB.
- [x] **`knowledge_agent`**: Subagente para arquitectura y notas de Obsidian en Qdrant.

### Pendiente ⏳
- [ ] **`apprecio_agent`**:
  - Conectar con repositorios de GitHub/GitLab de Apprecio para consultar el estado del código fuente, PRs pendientes y releases.
- [ ] **`triage_agent`**:
  - Manejo de temas sensibles escalados para consolidar un "Digest de Decisiones" que requieran la atención del Jesús real.

---

## 🚀 5. Nuevas Fases de Infraestructura (Leygo Inspirations)

### Implementado ✅
- [x] **Webhooks Manager Multi-Proveedor (`src/services/webhook.service.ts`)**:
  - Endpoint `POST /webhooks/:provider` para capturar eventos de **GitHub** (Pull Requests, Pushes a main, Releases, Issues), **GitLab** (Pipelines fallidos/exitosos, Merge Requests), **Sentry** (alertas e incidencias críticas) y alertas genéricas.
  - Validación opcional de token/secreto con `WEBHOOK_SECRET`.
  - Persistencia de historial de eventos en tabla SQLite local `webhooks_log`.
  - Notificación ejecutiva e inmediata en Telegram con enlaces directos a las incidencias o PRs.
  - Herramienta para el agente: `get_recent_webhooks` para consultar alertas recientes recibidas.
- [x] **Webhooks Personalizados con IA (Estilo Leygo)** (`src/services/custom_webhook.service.ts`):
  - Endpoints REST para crear, listar, consultar, actualizar, pausar/reanudar y eliminar webhooks dinámicos con ID UUID (`/api/webhooks`).
  - Endpoint de invocación `POST /api/webhook/:id` (y `/webhook/:id`) que retorna URLs en formato `http://localhost:8000/api/webhook/<uuid>`.
  - Soporte de configuración de: **Título**, **Instrucciones de la IA** y **Modelo a utilizar** (Gemini o modelos de Ollama como `gemma4:latest (ollama)`).
  - Al recibir un payload HTTP POST, la IA sintetiza y resume la información siguiendo las instrucciones del webhook y notifica el resultado formateado directamente a Telegram.
  - Historial de logs por webhook en SQLite (`custom_webhook_logs`).
  - Herramientas para el agente: `create_custom_webhook`, `list_custom_webhooks`, `toggle_custom_webhook` y `get_custom_webhook_logs`.

- [x] **Fase 4: Token Tracker & Budget Alerts (`src/services/token_tracker.service.ts`)**:
  - Almacenamiento en SQLite local (`usage_history` y `system_config` en `data/reminders.db`).
  - **Actualizador periódico de precios con LiteLLM**:
    - Catálogo comunitario con más de 2,000 modelos cargados en memoria RAM para consultas instantáneas.
    - Actualización automática en segundo plano desde GitHub si el archivo `data/litellm_cost.json` supera los 7 días.
    - Tarea cron periódica semanal en `scheduler.service.ts` (Domingos 03:00 CLT).
    - Modelos locales/Ollama tarificados automáticamente en **$0.00 USD**.
  - **Hooks automáticos de consumo de tokens**:
    - Turnos conversacionales en Telegram (captura `event.usageMetadata` de ADK Runner).
    - Transcripción de notas de voz con Gemini.
    - Ejecución de Webhooks personalizados con IA.
    - Generación diaria del Morning Digest.
    - Endpoints `/run` y `/run_sse` en la API Express.
  - **Alertas Presupuestarias Proactivas**:
    - Presupuesto mensual configurable en USD (`MONTHLY_BUDGET_USD` y tabla `system_config`).
    - Notificación inmediata y preventiva a Telegram al alcanzar el **80%**.
    - Notificación crítica a Telegram al alcanzar el **100%** del presupuesto.
  - **Endpoints REST**: `GET /api/usage`, `GET /api/usage/budget`, `POST /api/usage/budget`, `POST /api/usage/refresh-pricing` (100% compatibles con `UsageComponent` de Leygo GUI).
  - **Herramientas del Agente**: `get_token_usage`, `set_monthly_budget` y `refresh_pricing_catalog`.

### Pendiente ⏳
- [ ] **Fase 5 (AutoCoder Sandbox)**:
  - Capacidad para crear branches, ejecutar scripts en entorno aislado y proponer PRs directamente desde instrucciones del usuario.

---

## 🐞 6. Bugs y Deuda Técnica (Auditoría 21-09-2026)

Hallazgos de la revisión completa del repo, ordenados por severidad. Ninguno corregido aún.

### 🔴 Críticos

- [ ] **UUID inválido rompe toda la consolidación de Gmail/Chat** (`src/services/context_consolidation.service.ts:33`):
  - `generateDeterministicUuid` arma el último grupo como `'b' + hash.substring(20,32)` → 13 caracteres. Un UUID requiere 12.
  - Qdrant rechaza el ID, el error sube al `catch` del método y **corta el loop completo**: no se indexa ningún hilo.
  - Además `markThreadConsolidated` se ejecuta DESPUÉS del upsert, por lo que los hilos nunca quedan marcados y se reprocesan (y re-pagan tokens de Gemini) en cada corrida nocturna.
  - La misma función en `meeting_ingest.service.ts:24` está correcta (12 chars) — solo quedó mal la copia.

- [ ] **Endpoint A2A abierto y sin aislamiento de canal** (`src/a2a/index.ts`):
  - Si `A2A_API_KEY` no está definida (hoy no está en `.env`), `/a2a/v1` queda público y cualquiera conversa con el Coordinator completo, que tiene acceso a Gmail, Drive y Google Chat.
  - `securityRequirements: []` en la Agent Card, incluso cuando hay API key configurada.
  - Nostr entra por el mismo Runner y las mismas tools que Telegram.
  - **Pendiente**: definir tools permitidas por canal (Telegram = full, A2A/Nostr = solo lectura de conocimiento público) y exigir API key siempre.

- [ ] **Temas vetados recortados en el Coordinator** (`src/agents/agent.ts`):
  - Se eliminaron sueldos/compensaciones, contrataciones/despidos/evaluaciones y opiniones sobre personas específicas. Quedaron solo contratos y credenciales.
  - Con A2A y Nostr expuestos, el veto debe reponerse al menos para interlocutores externos.

### 🟠 Calidad de las respuestas

- [ ] **Dos espacios vectoriales mezclados en la misma colección** (`src/services/qdrant.service.ts`):
  - El fallback de Ollama (`nomic-embed-text`) a Gemini (`gemini-embedding-001`) genera 768 dims pero de otro espacio semántico. Entra sin error y arruina silenciosamente la similitud.
  - **Fix**: guardar el proveedor del embedding en el payload y, o fallar duro, o usar colección separada por proveedor.
  - Menor asociado: el truncado `safeText` (5000 chars) solo se aplica en la llamada `/api/embed`; el fallback legacy `/api/embeddings` y la rama Gemini usan el `text` completo.

- [ ] **`episodic_search` pierde la metadata más útil** (`src/services/qdrant.service.ts` + `src/agents/tools/knowledge.tools.ts`):
  - `searchKnowledge` mapea solo score, title, section, filePath, tags, content, source, date y author.
  - La tool formatea `r.participants`, `r.agreements` y los acuerdos, que **siempre vienen `undefined`**. También se pierde el `link` a la minuta de Drive, justo lo que permite verificar la fuente.
  - **Fix**: devolver el payload completo (o al menos participants, decisions/tasks, link, threadId).

- [ ] **`sinceHours` ignorado en Gmail** (`consolidateGmail`):
  - Recibe el parámetro pero llama `searchRecentGmailThreads('', maxThreads)` sin filtro de fecha: siempre los últimos 10 hilos, pidas 24 o 72 horas.

- [ ] **`syncMeetRecordings` incompleto** (`src/services/meeting_ingest.service.ts`):
  - Busca literalmente `'Notas de Gemini'`: se pierden las reuniones en inglés (`Notes by Gemini`) y las transcripciones.
  - Sin checkpoint incremental: reprocesa y re-embeddea los mismos 20 archivos cada noche (Qdrant sobrescribe por ID, pero el costo y el tiempo se pagan igual).

### ✅ Resuelto (21-09-2026)

- [x] **Bridge Nostr (Buzz) perdía los mensajes en vivo** (`src/services/nostr_gateway.service.ts`):
  - `enablePing: true` + WebSocket nativo de Node hacía que nostr-tools cayera en el "forced-ping" (un REQ falso con un id inexistente cada 29s); el relay no lo respondía y el propio cliente cerraba el socket. **Fix**: usar `ws` como `websocketImplementation` → ping/pong real del protocolo.
  - Reconexión en cadena: `relay.onclose` y `subscription.onclose` programaban reconexiones simultáneas que se mataban entre sí. **Fix**: single-flight con generaciones + backoff exponencial 2s→30s.
  - `relay.connect()` sin timeout podía colgarse indefinidamente dejando `isConnecting=true` para siempre. **Fix**: `connect({ timeout: 15s })`.
  - Conexión zombie: `relay.connected` seguía en `true` con el socket muerto o la suscripción dada de baja por el relay. **Fix**: watchdog con REQ de prueba (EOSE en 10s) + renovación preventiva de la suscripción cada 5 min.
  - Ventana `since` fija de 180s: lo recibido durante una caída larga se perdía. **Fix**: checkpoint en Redis (`nostr:checkpoint`) con recuperación de hasta 1h.
  - Si el socket se caía mientras el agente pensaba, la respuesta se perdía y el evento ya estaba marcado como visto. **Fix**: cola de respuestas pendientes + el evento se marca visto solo tras publicar.
  - Perfil Kind 0 republicado en cada reconexión (riesgo de rate limit). **Fix**: máximo cada 6h.
  - **Comportamiento del relay de Buzz (documentado, no es bug propio)**: los mensajes sueltos del canal llegan por push en vivo (filtro `#h`), pero las **respuestas dentro de un hilo son eventos p-gated**: el relay no las empuja si el bot no está en su tag `p`, aunque sí las entrega como eventos almacenados ante un REQ nuevo. Por eso la suscripción se re-emite cada `NOSTR_RESUBSCRIBE_SECONDS` (30s por defecto): ese intervalo ES la latencia máxima de respuesta dentro de un hilo. Un `#e` no sirve: el relay cierra el REQ completo con `restricted: p-gated events require #p matching your pubkey`.
  - **Identidad**: el bot y la persona no pueden compartir npub — el gateway descarta todo evento firmado con su propia clave, así que los mensajes escritos desde el cliente con la identidad del bot se pierden en silencio (ahora se loguean con `NOSTR_DEBUG_EVENTS=true`).
  - Nuevas variables: `NOSTR_KINDS`, `NOSTR_LISTEN_GLOBAL`, `NOSTR_THREAD_FILTER`, `NOSTR_RESUBSCRIBE_SECONDS`, `NOSTR_WATCHDOG_PROBE`, `NOSTR_DEBUG_EVENTS`, `NOSTR_DEBUG_FIREHOSE` (ver `.env.example`). Backup del archivo original en `nostr_gateway.service.ts.bak`.

- [x] **Pata de salida del bridge Nostr** (`publishToChannel` + `src/agents/tools/nostr.tools.ts`):
  - Antes el gateway era solo de entrada: el agente podía responder menciones pero no publicar por iniciativa propia, así que "envía un mensaje al canal de Buzz" se ruteaba a Google Chat.
  - Nuevas herramientas del coordinator: `buzz_send_message` (publica kind 9 con el tag `h` del canal, firmado como Yisus, con aprobación por Telegram) y `buzz_status` (estado del bridge: conexión, npub y canales).
  - Regla explícita en el ruteo del Coordinator: **Buzz no es Google Chat**.
  - Pendiente opcional: parámetro de evento raíz para que Yisus pueda abrir o continuar hilos por iniciativa propia.
- [x] **Tarjeta de aprobación de Telegram parametrizada** (`telegram_auth.service.ts`):
  - Decía "SOLICITUD DE ACCESO A GMAIL / ¿Autorizas el acceso a tus correos?" para TODAS las acciones, incluidas las de Calendar, Drive, Chat y Buzz.
  - Texto por defecto neutro + `scope` opcional (título, subtítulo, pregunta) por herramienta.
  - La tarjeta ahora advierte que la ventana de gracia de 5 minutos es **global**, no por acción.
  - Pendiente opcional: flag para que acciones públicas (publicar en Buzz) no se acojan a la sesión activa y pregunten siempre.

- [x] **Contabilidad de tokens corregida** (`token_tracker.service.ts` + puntos de captura):
  - **Output subestimado**: se contaba solo `candidatesTokenCount`, que NO incluye `thoughtsTokenCount` (los tokens de razonamiento, que Google factura como salida). Con thinking activo en gemini-3.8-flash eso es la mayor parte del output. Tampoco se sumaba `toolUsePromptTokenCount` al input. Nuevo helper `extractUsage()/accumulateUsage()` centralizado y aplicado en todos los puntos de captura.
  - **Costo sobrestimado**: el fallback de precios evaluaba `includes('gemini-3')` antes que las variantes flash, así que `gemini-3.8-flash` se tarifaba como un Pro (2.50/10.00 en vez de 0.50/3.00). Reordenado + aviso en consola (una vez por modelo) cuando un modelo cae al default.
  - **Consumo de los subagentes invisible**: `AgentTool` crea su PROPIO Runner interno y consume los eventos del subagente en un bucle privado (ver `agent_tool.js` del ADK), así que medir en el stream del Runner padre dejaba fuera todo lo que gastan `faq_agent`, `account_agent` y `knowledge_agent` — en un turno con 26 llamadas al modelo se registraban solo las del Coordinator. **Fix**: la medición bajó a la capa del modelo (`TrackedGemini extends Gemini`), que ve el 100% de las llamadas, con un `AsyncLocalStorage` (`beginUsageScope`/`flushUsageScope`) que aporta canal e hilo sin pasarlos por toda la cadena.
  - **Canales sin contabilizar**: Nostr/Buzz y A2A ejecutaban el Runner sin registrar NADA. Ahora ambos acumulan y registran (`[Buzz]` / `[A2A]` como prefijo del input).
  - Resuelto de paso: la atribución de modelo ya no se hardcodea, sale de `this.model` de cada instancia. (Antes: hardcodeada por canal (`gemini-3.8-flash`), así que el consumo de los subagentes con otro modelo (faq_agent en 3.5-flash-lite, ingestas en 2.5-flash-lite) queda imputado al modelo del coordinator. Los registros históricos ya guardados no se corrigen solos.

- [x] **Atribución por canal y presupuestos separados**:
  - Columna `channel` en `usage_history` (migración idempotente al arrancar) + índice. Canales: `telegram`, `buzz`, `a2a`, `api`, `system`.
  - `UsageCollector(channel)` y todos los puntos de captura etiquetados.
  - Presupuesto por canal en `system_config` (`monthly_budget_usd_<canal>`) con fallback a env (`MONTHLY_BUDGET_USD_<CANAL>`). 0 en un canal = sin tope propio, solo el global.
  - Alertas 80%/100% independientes por canal y global, con flags por mes y por alcance.
  - `get_token_usage` muestra desglose por canal; `set_monthly_budget` acepta canal; `GET/POST /api/usage/budget` aceptan `channel`.
  - Pendiente: los topes solo **avisan**, no cortan. `isOverBudget(channel)` ya existe para cuando se quiera bloquear consumo.
  - Pendiente: no hay presupuestos de grupo (ej. un tope compartido entre buzz y a2a); hoy cada canal tiene el suyo.

### 🟡 Menores / Higiene

- [ ] **Instructions inconsistentes con el modo `AgentTool`**: los subagentes siguen indicando `transfer_to_agent('Coordinator')`, que en ese modo no existe.
- [ ] **`fixRootAgentReferences` es código muerto**: `subAgents` está vacío desde que se pasó a `AgentTool`.
- [ ] **Doble arranque de servicios**: `src/adk.ts` y `src/index.ts` levantan ambos el bot de Telegram y el scheduler → dos pollers si se corre ADK Web junto al server.
- [ ] **`qdrant_storage/` fuera de `.gitignore`**.
- [ ] **La carpeta no es un repositorio git**: no hay historial ni forma de revertir.
