/**
 * Conversión entre el formato de contenidos de Gemini (el que usa el ADK por
 * dentro: Content/Part con text, functionCall, functionResponse, inlineData) y
 * los formatos de OpenAI Chat Completions y Anthropic Messages.
 */

export interface DeclaracionTool { name: string; description?: string; parameters?: any }

/** Normaliza un JSON Schema al estilo Gemini (tipos en mayúscula) a JSON Schema estándar. */
export function normalizarSchema(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(normalizarSchema);
  const out: any = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'type' && typeof v === 'string') out[k] = v.toLowerCase();
    else if (k === 'properties' && v && typeof v === 'object') {
      out[k] = Object.fromEntries(Object.entries(v as any).map(([pk, pv]) => [pk, normalizarSchema(pv)]));
    } else if (k === 'items' || k === 'anyOf' || k === 'oneOf' || k === 'allOf') out[k] = normalizarSchema(v);
    else if (k === 'nullable' || k === 'format' && v === 'enum') continue;
    else out[k] = v;
  }
  if (out.type === 'object' && !out.properties) out.properties = {};
  return out;
}

/** Saca las declaraciones de herramientas de un LlmRequest del ADK. */
export function declaracionesDe(llmRequest: any): DeclaracionTool[] {
  const tools: any[] = llmRequest?.config?.tools || [];
  const out: DeclaracionTool[] = [];
  for (const t of tools) {
    for (const d of t?.functionDeclarations || []) {
      out.push({ name: d.name, description: d.description, parameters: normalizarSchema(d.parameters || d.parametersJsonSchema || { type: 'object', properties: {} }) });
    }
  }
  return out;
}

export function instruccionSistema(llmRequest: any): string {
  const si = llmRequest?.config?.systemInstruction;
  if (!si) return '';
  if (typeof si === 'string') return si;
  if (Array.isArray(si)) return si.map((p: any) => (typeof p === 'string' ? p : p?.text || '')).join('\n');
  return (si.parts || []).map((p: any) => p?.text || '').filter(Boolean).join('\n');
}

function textoDe(parts: any[]): string {
  return parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).filter(Boolean).join('\n');
}

// ─── OpenAI ────────────────────────────────────────────────────────────────

/** Gemini contents → mensajes de OpenAI. Conserva ids de tool_call para casar respuestas. */
export function aMensajesOpenAI(llmRequest: any): any[] {
  const mensajes: any[] = [];
  const sistema = instruccionSistema(llmRequest);
  if (sistema) mensajes.push({ role: 'system', content: sistema });

  let pendientes: Array<{ id: string; name: string }> = [];
  let contador = 0;

  for (const c of llmRequest?.contents || []) {
    const parts: any[] = c?.parts || [];
    const esModelo = c?.role === 'model' || c?.role === 'assistant';
    const llamadas = parts.filter((p) => p?.functionCall);
    const respuestas = parts.filter((p) => p?.functionResponse);

    if (esModelo) {
      const texto = textoDe(parts);
      const tool_calls = llamadas.map((p) => {
        const id = p.functionCall.id || `call_${++contador}_${p.functionCall.name}`;
        pendientes.push({ id, name: p.functionCall.name });
        return { id, type: 'function', function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) } };
      });
      const m: any = { role: 'assistant', content: texto || (tool_calls.length ? null : '') };
      if (tool_calls.length) m.tool_calls = tool_calls;
      mensajes.push(m);
      continue;
    }

    if (respuestas.length) {
      for (const p of respuestas) {
        const fr = p.functionResponse;
        let id = fr.id;
        if (!id) {
          const i = pendientes.findIndex((x) => x.name === fr.name);
          id = i >= 0 ? pendientes.splice(i, 1)[0].id : `call_${fr.name}`;
        } else {
          pendientes = pendientes.filter((x) => x.id !== id);
        }
        mensajes.push({ role: 'tool', tool_call_id: id, content: JSON.stringify(fr.response ?? {}) });
      }
      const resto = parts.filter((p) => !p?.functionResponse);
      if (textoDe(resto)) mensajes.push({ role: 'user', content: textoDe(resto) });
      continue;
    }

    // usuario: texto y adjuntos (imágenes como data URI)
    const bloques: any[] = [];
    for (const p of parts) {
      if (typeof p?.text === 'string' && p.text) bloques.push({ type: 'text', text: p.text });
      else if (p?.inlineData?.data && String(p.inlineData.mimeType || '').startsWith('image/')) {
        bloques.push({ type: 'image_url', image_url: { url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}` } });
      } else if (p?.inlineData?.data) {
        bloques.push({ type: 'text', text: `[Adjunto ${p.inlineData.mimeType} omitido: este proveedor no lo acepta]` });
      }
    }
    if (bloques.length === 1 && bloques[0].type === 'text') mensajes.push({ role: 'user', content: bloques[0].text });
    else if (bloques.length) mensajes.push({ role: 'user', content: bloques });
  }
  return mensajes;
}

export function toolsOpenAI(llmRequest: any): any[] | undefined {
  const decl = declaracionesDe(llmRequest);
  if (!decl.length) return undefined;
  return decl.map((d) => ({ type: 'function', function: { name: d.name, description: d.description || '', parameters: d.parameters } }));
}

/** Mensaje de respuesta de OpenAI → Content de Gemini. */
export function desdeMensajeOpenAI(message: any): any {
  const parts: any[] = [];
  const texto = typeof message?.content === 'string' ? message.content : Array.isArray(message?.content) ? message.content.map((b: any) => b?.text || '').join('') : '';
  if (texto) parts.push({ text: texto });
  for (const tc of message?.tool_calls || []) {
    let args: any = {};
    try { args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}; } catch { args = { _raw: tc.function?.arguments }; }
    parts.push({ functionCall: { id: tc.id, name: tc.function?.name, args } });
  }
  if (!parts.length) parts.push({ text: '' });
  return { role: 'model', parts };
}

// ─── Anthropic ─────────────────────────────────────────────────────────────

export function aMensajesAnthropic(llmRequest: any): { system: string; messages: any[] } {
  const messages: any[] = [];
  let pendientes: Array<{ id: string; name: string }> = [];
  let contador = 0;

  for (const c of llmRequest?.contents || []) {
    const parts: any[] = c?.parts || [];
    const esModelo = c?.role === 'model' || c?.role === 'assistant';

    if (esModelo) {
      const content: any[] = [];
      for (const p of parts) {
        if (typeof p?.text === 'string' && p.text) content.push({ type: 'text', text: p.text });
        else if (p?.functionCall) {
          const id = p.functionCall.id || `toolu_${++contador}_${p.functionCall.name}`;
          pendientes.push({ id, name: p.functionCall.name });
          content.push({ type: 'tool_use', id, name: p.functionCall.name, input: p.functionCall.args || {} });
        }
      }
      if (content.length) messages.push({ role: 'assistant', content });
      continue;
    }

    const content: any[] = [];
    for (const p of parts) {
      if (p?.functionResponse) {
        const fr = p.functionResponse;
        let id = fr.id;
        if (!id) { const i = pendientes.findIndex((x) => x.name === fr.name); id = i >= 0 ? pendientes.splice(i, 1)[0].id : `toolu_${fr.name}`; }
        content.push({ type: 'tool_result', tool_use_id: id, content: JSON.stringify(fr.response ?? {}) });
      } else if (typeof p?.text === 'string' && p.text) content.push({ type: 'text', text: p.text });
      else if (p?.inlineData?.data && /^(image\/|application\/pdf)/.test(String(p.inlineData.mimeType || ''))) {
        const tipo = p.inlineData.mimeType === 'application/pdf' ? 'document' : 'image';
        content.push({ type: tipo, source: { type: 'base64', media_type: p.inlineData.mimeType, data: p.inlineData.data } });
      }
    }
    if (content.length) messages.push({ role: 'user', content });
  }

  // Anthropic exige alternancia estricta: se fusionan consecutivos del mismo rol
  const fusionados: any[] = [];
  for (const m of messages) {
    const ult = fusionados[fusionados.length - 1];
    if (ult && ult.role === m.role) ult.content = [...ult.content, ...m.content];
    else fusionados.push({ ...m, content: [...m.content] });
  }
  return { system: instruccionSistema(llmRequest), messages: fusionados };
}

export function toolsAnthropic(llmRequest: any): any[] | undefined {
  const decl = declaracionesDe(llmRequest);
  if (!decl.length) return undefined;
  return decl.map((d) => ({ name: d.name, description: d.description || '', input_schema: d.parameters || { type: 'object', properties: {} } }));
}

export function desdeRespuestaAnthropic(data: any): any {
  const parts: any[] = [];
  for (const b of data?.content || []) {
    if (b.type === 'text' && b.text) parts.push({ text: b.text });
    else if (b.type === 'tool_use') parts.push({ functionCall: { id: b.id, name: b.name, args: b.input || {} } });
  }
  if (!parts.length) parts.push({ text: '' });
  return { role: 'model', parts };
}

/**
 * Respuesta de error visible: el ADK convierte `errorCode` en un evento sin
 * texto, y los canales (GUI, Telegram, Buzz, A2A) mostraban "(sin respuesta)".
 * Se deja el mensaje también como texto, y se loguea, para que quede claro
 * qué proveedor falló y por qué.
 */
export function respuestaError(agentName: string | undefined, model: string, errorCode: string, errorMessage: string) {
  console.error(`❌ [LLM] ${agentName || 'agente'} · ${model}: ${errorMessage}`);
  let detalle = errorMessage;
  // Si el proveedor devolvió JSON, mostramos solo su mensaje.
  const m = errorMessage.match(/\{.*\}$/s);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      const msg = j?.error?.message || j?.message || j?.error;
      if (typeof msg === 'string') detalle = `${errorMessage.slice(0, errorMessage.indexOf(m[0])).trim()} ${msg}`;
    } catch { /* se deja como venía */ }
  }
  return {
    errorCode,
    errorMessage,
    content: { role: 'model', parts: [{ text: `⚠️ El modelo ${model} no pudo responder. ${detalle}` }] },
    turnComplete: true,
  };
}

/**
 * fetch con reintentos ante 429 (límite de RPM) y 5xx transitorios: espera lo
 * que pida Retry-After o 2s/4s/8s. Devuelve la última respuesta si se agotan.
 */
export async function fetchConReintentos(url: string, init: RequestInit, intentos = 3, agentName?: string): Promise<Response> {
  let res: Response | undefined;
  for (let i = 0; i < intentos; i++) {
    res = await fetch(url, init);
    if (res.ok || ![429, 500, 502, 503, 529].includes(res.status) || i === intentos - 1) return res;
    const retryAfter = Number(res.headers.get('retry-after')) || 0;
    const espera = Math.min(15_000, retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** i);
    console.warn(`⏳ [LLM] ${agentName || 'agente'}: ${res.status} de ${new URL(url).host}, reintento ${i + 1}/${intentos - 1} en ${espera / 1000}s`);
    await res.text().catch(() => {});
    await new Promise((r) => setTimeout(r, espera));
    if ((init.signal as AbortSignal | undefined)?.aborted) return res;
  }
  return res!;
}
