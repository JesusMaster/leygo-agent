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
  - **(22-09)** La ventana de gracia es **por canal** (se fija el canal al pedir la aprobación, no al responderla) y hay cooldown tras denegar (5 min) o expirar (60 s) para no inundar Telegram. `chat_find_dm` evita abrir historiales para ubicar a una persona. Test: `npm run check:2fa`.
  - **(22-09)** `chat_read_messages` lee los más recientes primero (`orderBy createTime DESC`), marca los no leídos (`chat.users.readstate`) y acepta `sinceDays`. Script `npm run google:oauth` para regenerar el refresh token con los scopes completos.
- [x] **Telegram Conversacional (Texto y Notas de Voz)**:
  - Bot interactivo bidireccional (`src/services/telegram_bot.service.ts`).
  - Transcripción nativa de notas de voz (`.oga`, `.ogg`, `.mp3`) con Gemini 2.5 Flash directamente sin dependencias de sistema (ffmpeg).
  - Integración fluida con el Runner de ADK (`runner.runAsync`) y formateador de mensajes HTML para Telegram.
  - Filtro de seguridad estricto que solo responde a `TELEGRAM_CHAT_ID`.
- [x] **Background Scheduler & Morning Digest Proactivo**:
  - Servicio cron en background (`src/services/scheduler.service.ts`) configurado en timezone `America/Santiago`.
  - **Morning Digest diario a las 08:30 CLT**: sintetiza Google Calendar del día + correos de Gmail sin leer + escalamientos pendientes y envía un resumen ejecutivo a Telegram.
  - Sincronización nocturna automática de reuniones de Google Meet a las 20:00 CLT.
  - **(22-09)** Digest, sync de Meet y consolidación nocturna ya no son crons fijos: son **rutinas del sistema** registradas como tareas programadas (`autonomous = 2`), editables desde la GUI (hora, canales, pausa, historial, ejecución manual). `MORNING_DIGEST_CRON`, `MEET_SYNC_CRON` y `CONTEXT_SYNC_CRON` solo se usan para sembrarlas la primera vez.
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
- [x] **`triage_agent`** ✅ IMPLEMENTADO (21-09):
  - `src/agents/triage.agent.ts` + `src/agents/tools/triage.tools.ts`, montado como AgentTool del Coordinator.
  - Tabla `escalations` en SQLite (id corto, canal, solicitante, tema, resumen, urgencia, estado, resolución).
  - Herramientas: `escalate_to_jesus` (registra y avisa por Telegram con el contexto completo), `list_escalations` y `resolve_escalation` (solo cuando Jesús indica la decisión).
  - El Morning Digest ahora abre una sección con los escalamientos pendientes de decisión.
  - Regla de ruteo explícita en el Coordinator: sueldos, contrataciones, evaluaciones, opiniones sobre personas, compromisos legales/comerciales y credenciales van al triage, que NO responde el fondo.
  - **(22-09)** Resolución desde la GUI (vista Escalamientos) y la respuesta **vuelve a quien preguntó** (`escalation_delivery.service.ts`): Buzz → mención en el hilo; A2A → push al peer o nota interna en la siguiente conversación del mismo token.
  - Pendiente: botones de resolución rápida en la tarjeta de Telegram (hoy se resuelve por conversación o GUI).
- [x] **A2A bidireccional** ✅ (22-09): Yisus también es *cliente* A2A (`a2a_peers.service.ts`, herramientas `a2a_send_message` / `a2a_list_peers`, tokens A2A de otros agentes guardados en `a2a_peers`). Configurable desde la GUI (Tokens A2A → Agentes remotos, con prueba de conexión).
- [x] **Proveedores LLM y modelo por agente** ✅ (22-09):
  - Adaptadores `BaseLlm` propios para **OpenAI-compatible** (OpenAI, xAI, Moonshot, DeepSeek, Groq, Mistral, OpenRouter, Ollama `/v1`) y **Anthropic**, con function calling, contabilidad de tokens y reintentos ante 429/5xx (`src/agents/llm/`). Sin streaming hacia el chat (solo Gemini lo tiene).
  - `DynamicLlm`: cada agente resuelve proveedor+modelo en cada turno desde `system_config` (`llm.providers`, `llm.assignments`). Cambios sin reiniciar. Override por ejecución (`conModelo`) para tareas programadas y webhooks.
  - GUI Ajustes: Proveedores LLM (presets), Modelos por agente (incluye digest, consolidación e ingesta), Claves y variables (edita el `.env` con secretos enmascarados, reinicio del backend).
  - Los errores del proveedor (sin crédito, RPM, caído) se muestran en el chat/Telegram/Buzz/A2A en vez de "(sin respuesta)".
- [x] **Presupuesto de contexto** ✅ (22-09, `src/agents/llm/context_budget.ts`): las respuestas de herramientas ya no viajan duplicadas (`result` + `data`) y tienen tope por herramienta; el historial se recorta a una ventana por agente cortando en inicio de turno; Conocimiento/FAQ/Triage/Conocimiento público van sin historial entre turnos (compartían sesión con el Coordinator y arrastraban todo). Misma pregunta: $0,198 → $0,016. El tooltip de consumo del chat muestra llamadas por agente.

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

- [x] **GUI de administración (`yisus-gui`, Angular 21)** ✅ (21/22-09), calcada de Leygo:
  - Inicio de sesión (usuario + contraseña scrypt en `.env`, `npm run gui:password`); la GUI ya no necesita la `ADMIN_API_KEY` (la muestra en Ajustes → Conexión para usar el API directo).
  - Chat con markdown, pasos en vivo, tokens + costo por turno, adjuntos, detener; historial local.
  - Consumo con historial paginado y filtros; Canales y tools; Tokens A2A (selector de herramientas en tabla) y Agentes remotos; Escalamientos; Smart Webhooks (proveedor + modelo entre los configurados); Tareas programadas (una vez / cada N min / diaria / cron; recordatorio, acción del agente con su propio modelo, o rutina del sistema; entrega multicanal Telegram / Google Chat / Buzz / Email / A2A; historial de corridas); Ajustes.
  - Responsive (móvil/tablet). Cloudflare cachea el JS del dev server: conviene una regla *Bypass cache* para `gui-yisus`.

### Pendiente ⏳
- [ ] **Fase 5 (AutoCoder Sandbox)**:
  - Capacidad para crear branches, ejecutar scripts en entorno aislado y proponer PRs directamente desde instrucciones del usuario.

---

## 🐞 6. Bugs y Deuda Técnica (Auditoría 21-09-2026)

Hallazgos de la revisión completa del repo, ordenados por severidad. Ninguno corregido aún.

### 🔴 Críticos

- [x] **UUID inválido rompe toda la consolidación de Gmail/Chat** ✅ ARREGLADO (21-09): último grupo a 12 chars + cada hilo aislado en try/catch para que un fallo no aborte el lote. (`src/services/context_consolidation.service.ts:33`):
  - `generateDeterministicUuid` arma el último grupo como `'b' + hash.substring(20,32)` → 13 caracteres. Un UUID requiere 12.
  - Qdrant rechaza el ID, el error sube al `catch` del método y **corta el loop completo**: no se indexa ningún hilo.
  - Además `markThreadConsolidated` se ejecuta DESPUÉS del upsert, por lo que los hilos nunca quedan marcados y se reprocesan (y re-pagan tokens de Gemini) en cada corrida nocturna.
  - La misma función en `meeting_ingest.service.ts:24` está correcta (12 chars) — solo quedó mal la copia.

- [x] **Endpoint A2A abierto y sin aislamiento de canal** ✅ ARREGLADO (21-09): sin `A2A_API_KEY` el endpoint no se monta; A2A corre sobre `publicCoordinator` (solo knowledge + FAQ, sin Google Workspace ni webhooks) con los temas vetados repuestos; la Agent Card declara el requisito de seguridad y ya no publica las skills internas. Buzz queda como estaba, por decisión explícita.
  - Si `A2A_API_KEY` no está definida (hoy no está en `.env`), `/a2a/v1` queda público y cualquiera conversa con el Coordinator completo, que tiene acceso a Gmail, Drive y Google Chat.
  - `securityRequirements: []` en la Agent Card, incluso cuando hay API key configurada.
  - Nostr entra por el mismo Runner y las mismas tools que Telegram.
  - ✅ (21/22-09) Tools por canal en `config/channels.json`; A2A exige Bearer por token, con alcance por token validado al invocar. Buzz ya no tiene `account_agent` (ver §7).

- [~] **Temas vetados recortados en el Coordinator** — repuestos en el agente PÚBLICO (A2A). En el Coordinator interno siguen recortados a propósito, porque ahí el interlocutor es el propio Jesús. Revisar si se quiere endurecer también para Buzz (`src/agents/agent.ts`):
  - Se eliminaron sueldos/compensaciones, contrataciones/despidos/evaluaciones y opiniones sobre personas específicas. Quedaron solo contratos y credenciales.
  - Con A2A y Nostr expuestos, el veto debe reponerse al menos para interlocutores externos.

### 🟠 Calidad de las respuestas

- [x] **Dos espacios vectoriales mezclados en la misma colección** ✅ ARREGLADO (21-09): se eliminó el fallback a Gemini; solo Ollama, con reintentos y error duro si no responde. Cada punto guarda `embeddingModel`. (`src/services/qdrant.service.ts`):
  - El fallback de Ollama (`nomic-embed-text`) a Gemini (`gemini-embedding-001`) genera 768 dims pero de otro espacio semántico. Entra sin error y arruina silenciosamente la similitud.
  - **Fix**: guardar el proveedor del embedding en el payload y, o fallar duro, o usar colección separada por proveedor.
  - Menor asociado: el truncado `safeText` (5000 chars) solo se aplica en la llamada `/api/embed`; el fallback legacy `/api/embeddings` y la rama Gemini usan el `text` completo.

- [x] **`episodic_search` pierde la metadata más útil** ✅ ARREGLADO (21-09): `searchKnowledge` devuelve el payload completo; la tool muestra participantes, decisiones, tareas, sala, asunto y link a la fuente. (`src/services/qdrant.service.ts` + `src/agents/tools/knowledge.tools.ts`):
  - `searchKnowledge` mapea solo score, title, section, filePath, tags, content, source, date y author.
  - La tool formatea `r.participants`, `r.agreements` y los acuerdos, que **siempre vienen `undefined`**. También se pierde el `link` a la minuta de Drive, justo lo que permite verificar la fuente.
  - **Fix**: devolver el payload completo (o al menos participants, decisions/tasks, link, threadId).

- [x] **`sinceHours` ignorado en Gmail** ✅ ARREGLADO (21-09): `searchRecentGmailThreads` acepta la ventana y la traduce a `after:<epoch>`. (`consolidateGmail`):
  - Recibe el parámetro pero llama `searchRecentGmailThreads('', maxThreads)` sin filtro de fecha: siempre los últimos 10 hilos, pidas 24 o 72 horas.

- [x] **`syncMeetRecordings` incompleto** ✅ ARREGLADO (21-09): query bilingüe (Notas de Gemini / Notes by Gemini / transcripciones) + checkpoint incremental en la tabla `sync_state` por fileId y modifiedTime. (`src/services/meeting_ingest.service.ts`):
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

- [x] **Herramientas configurables por canal** ✅ (21-09):
  - `src/agents/tool_catalog.ts`: catálogo único + grupos (`knowledge`, `publico`, `faq`, `workspace`, `triage`, `reminders`, `webhooks`, `usage`, `buzz`).
  - `config/channels.json`: Telegram, Buzz y API declaran su lista; A2A declara **tokens con alcance** (`env:NOMBRE` para no escribir el secreto en el JSON).
  - Un Runner y un Coordinator por canal; en A2A, uno por token (cacheado). Token desconocido = 401; token sin herramientas = conversa pero no ejecuta.
  - `GET /api/channels` muestra catálogo, grupos y lo vigente por canal; `POST /api/channels/reload` relee el archivo.
  - Pendiente: la recarga en caliente solo afecta a los agentes que se construyan después (A2A). Telegram, Buzz y API necesitan reinicio.

- [x] **Permisos de A2A por token, validados al invocar** ✅ (21-09):
  - `config/channels.json → a2a.disponibles` define el TECHO del canal: qué herramientas monta el agente público y qué skills publica la Agent Card (la card ahora se arma desde ahí, no hardcodeada).
  - Cada token concede un subconjunto. El permiso se verifica **al invocar** (`src/agents/a2a_guard.ts`): si el token no la tiene, la herramienta devuelve `sin_permiso` con un mensaje que el agente transmite tal cual, en vez de que el modelo improvise.
  - Un solo Runner público para todos los tokens (antes uno por alcance).
  - Editable desde la GUI: skills públicas en "Canales y tools", alcance por token en "Tokens A2A".
  - ✅ (22-09) `account_agent` fuera de Buzz. Pendiente recortar el resto (ver §7/§8).
  - ✅ (22-09) La ventana de gracia del 2FA ya es por canal (se fija al pedir la aprobación).

### 🟡 Menores / Higiene

- [x] **Instructions inconsistentes con el modo `AgentTool`** ✅ ARREGLADO (21-09).: los subagentes siguen indicando `transfer_to_agent('Coordinator')`, que en ese modo no existe.
- [x] **`fixRootAgentReferences` es código muerto** ✅ ELIMINADO (21-09).: `subAgents` está vacío desde que se pasó a `AgentTool`.
- [x] **Doble arranque de servicios** ✅ ARREGLADO (21-09): adk.ts solo los levanta con `ADK_START_SERVICES=true`.: `src/adk.ts` y `src/index.ts` levantan ambos el bot de Telegram y el scheduler → dos pollers si se corre ADK Web junto al server.
- [x] **`qdrant_storage/` fuera de `.gitignore`** ✅ ARREGLADO (21-09)..
- [x] **Repositorio git** ✅ (ya existía; se agregó commit del estado actual).: no hay historial ni forma de revertir.

---

## 🔐 7. Superficie HTTP expuesta (auditoría 21-09-2026)

### Resuelto ✅
- [x] **`/run` y `/run_sse` estaban públicos**: ejecutaban `buildChannelCoordinator('api')`, que en `config/channels.json` tiene `["*"]` — el coordinator interno completo, con `account_agent` (Gmail, Calendar, Drive). Cualquiera con la URL del dominio podía conversar con el agente personal sin token. Cerrados con `adminGuard` (`src/routes/admin_guard.ts`).
- [x] **`/api/usage`, `/api/usage/budget` y `/api/usage/refresh-pricing` estaban públicos**: exponían el gasto, el desglose por canal/agente/modelo y, en el POST, permitían cambiar los topes de presupuesto. Cerrados.
- [x] **Administración de webhooks pública** (`GET /webhooks/recent`, CRUD de `/api/webhooks`). Cerrada. La *recepción* de webhooks externos sigue pública: la autentica su propio secreto.
- [x] **Guard único compartido** entre `index.routes.ts` y `admin.routes.ts`, con test de regresión (`npm run check:rutas`).
- [x] **Guard de permisos por token en A2A verificado** (`npm run check:permisos`): una herramienta publicada pero no concedida devuelve `sin_permiso` y no se ejecuta.

### Pendiente ⏳
- [~] **Alcance de Buzz**: `account_agent` ya NO está en Buzz (quitado desde la GUI). Siguen habilitadas 17 de 21: `knowledge_agent` (incluye memoria episódica con acuerdos internos), programar tareas/recordatorios, CRUD de webhooks, `set_monthly_budget` y el digest. Buzz es un canal público sin tokens: lo único que frena una acción es el 2FA por Telegram. Propuesta: dejar `knowledge_public`, `faq_agent`, `triage_agent`, `buzz_send_message`, `buzz_status`.
- [x] **`setCurrentA2AScope` usa `AsyncLocalStorage.enterWith`** ✅ (22-09): el middleware ahora envuelve `next()` con `runWithA2AScope` (`.run()`); el alcance muere con la petición. `setCurrentA2AScope` queda solo para `check:permisos`.
- [ ] **`ADMIN_API_KEY` sin definir desactiva el guard** (`return next()`), pensado para desarrollo local. Evaluar exigirla cuando `NODE_ENV=production`. (Hoy el guard acepta también la sesión de la GUI.)
- [ ] **`/api/settings/env` edita el `.env` completo** desde la GUI (secretos enmascarados, pero se pueden sobrescribir). Está detrás del guard; si la GUI se expone fuera de la VPN/tunnel, conviene Cloudflare Access delante.

---

## 🧭 8. Pendientes abiertos (22-09-2026)

Cosas conversadas y no cerradas, en orden de valor:

- [ ] **Alcance de Buzz**: `account_agent` ya está fuera; quedan 17 (conocimiento interno, tareas, webhooks, presupuesto). Propuesta: `knowledge_public`, `faq_agent`, `triage_agent`, `buzz_*`.
- [ ] **Recarga en caliente de tools por canal**: Telegram, Buzz y API construyen su Coordinator al arrancar; un cambio en "Canales y tools" requiere reinicio (A2A no). Podría resolverse igual que los modelos (resolver el set de tools por turno).
- [ ] **Topes de presupuesto que corten** y no solo avisen (`isOverBudget(channel)` ya existe).
- [ ] **Botones de resolución rápida de escalamientos en Telegram**.
- [ ] **Acciones rápidas de Calendar en Telegram** (aceptar / rechazar invitaciones).
- [ ] **Buzz: abrir/continuar hilos por iniciativa propia** (evento raíz en `buzz_send_message`).
- [ ] **2FA: acciones públicas que pregunten siempre** (no acogerse a la ventana de gracia).
- [ ] **Watcher de Obsidian + borrado/renombrado + hashes incrementales + búsqueda híbrida** (§1).
- [ ] **Purga/retención de memoria episódica** (§2).
- [ ] **`apprecio_agent`** (GitHub/GitLab) y **AutoCoder Sandbox** (§4/§5).
- [ ] **Override de modelo de una tarea también para los subagentes** (hoy solo aplica al Coordinator).
- [ ] **Streaming para proveedores no-Gemini** (los adaptadores entregan la respuesta completa por turno).
