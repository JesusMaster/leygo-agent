---
name: yisus-remoto
description: Consultar a Yisus (el agente de Jesús Leiva) por A2A — conocimiento de Apprecio, agentes especialistas como banano (imágenes) y nami (vuelo). Usar cuando el usuario pida algo que Yisus o uno de sus agentes sabe hacer.
---

# Yisus Remoto (A2A 1.0, JSON-RPC)

Endpoint: `https://yisus.openip.cl/a2a/v1` · token en la variable `YISUS_A2A_TOKEN` (nunca lo imprimas).

## Cómo llamar

Un solo comando por petición. Reutiliza el MISMO `contextId` durante toda la conversación
con el usuario (guárdalo la primera vez) para que Yisus recuerde lo anterior.

```bash
curl -sS https://yisus.openip.cl/a2a/v1 \
  -H "Content-Type: application/json" \
  -H "A2A-Version: 1.0" \
  -H "Authorization: Bearer $YISUS_A2A_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{"message":{
        "messageId":"'"$(uuidgen)"'",
        "contextId":"'"$CONTEXT_ID"'",
        "role":"ROLE_USER",
        "parts":[{"text":"<petición en lenguaje natural>"}]}}}'
```

Para pedirle algo a un agente especialista, dilo en el texto: "Usa banano para generar
una imagen de …" o "Pregúntale a nami cuántas millas náuticas son 150 km".

## Cómo leer la respuesta

`result.task.status.state`:
- `TASK_STATE_COMPLETED` → la tarea TERMINÓ. La respuesta está en
  `result.task.status.message.parts` (y repetida en `result.task.artifacts[0].parts`).
  No preguntes "estado", no pidas "la URL completa", no vuelvas a pedir lo mismo.
- `TASK_STATE_INPUT_REQUIRED` → Yisus te hizo una pregunta; contéstala en el siguiente
  mensaje con el mismo `contextId`.
- `TASK_STATE_FAILED` → el texto trae el motivo; repórtalo al usuario tal cual.

Partes posibles:
- `{ "text": "…" }` → la respuesta en texto (markdown simple).
- `{ "url": "https://yisus.openip.cl/api/adjuntos/<id>", "filename": "…jpg", "mediaType": "image/jpeg" }`
  → un archivo generado (imagen, PDF). **No aparece solo en tu carpeta `media/`**:
  descárgalo tú y muéstralo:

```bash
curl -sSL "<url>" -o "/home/node/.openclaw/media/tool-image-generation/<filename>"
```

El mismo enlace viene también dentro del texto (`Imagen <nombre>:\n<url>`); si por
alguna razón no ves la parte `url`, sácalo de ahí. Los enlaces caducan a los 7 días.

## Reglas

- Una petición = un comando. Si `COMPLETED` y la respuesta trae texto o archivo, ya está:
  entrégalo al usuario. Solo vuelve a llamar si el usuario pide otra cosa.
- Pide "genera otra" / "hazlo de nuevo" ÚNICAMENTE si el usuario lo pide: cada generación
  cuesta y produce una imagen distinta.
- No generes la imagen con tu propia herramienta cuando el usuario pidió a Yisus/banano:
  si Yisus falló, di qué respondió y pregunta al usuario cómo seguir.
- Si la respuesta dice "por este canal no tengo acceso", es un límite de permisos del token:
  informa al usuario, no insistas.
