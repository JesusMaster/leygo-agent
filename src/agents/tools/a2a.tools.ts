import { FunctionTool } from '@google/adk';
import { z } from 'zod';
import { a2aPeersService } from '../../services/a2a_peers.service.js';

/** Escribirle a otro agente por A2A (OpenClaw u otro peer configurado en la GUI). */
export const a2aSendMessageTool = new FunctionTool({
  name: 'a2a_send_message',
  description: 'Envía un mensaje a otro agente por el protocolo A2A (por ejemplo OpenClaw) y devuelve su respuesta. Usa a2a_list_peers para ver los agentes disponibles. Continúa la última conversación con ese agente salvo que pidas una nueva.',
  parameters: z.object({
    peer: z.string().describe('Nombre del agente remoto tal como está configurado (ej: "openclaw").'),
    text: z.string().describe('Mensaje o instrucción para el otro agente.'),
    newConversation: z.boolean().optional().describe('true para abrir una conversación nueva en vez de continuar la anterior.'),
  }) as any,
  execute: async (args: any) => {
    try {
      const r = await a2aPeersService.send(args.peer, args.text, { nuevaConversacion: !!args.newConversation });
      return { status: 'success', result: r.texto, data: { contextId: r.contextId, estado: r.estado } };
    } catch (err: any) {
      return { status: 'error', message: err.message };
    }
  },
});

export const a2aListPeersTool = new FunctionTool({
  name: 'a2a_list_peers',
  description: 'Lista los agentes remotos A2A configurados a los que Yisus puede escribir.',
  parameters: z.object({}) as any,
  execute: async () => {
    const peers = a2aPeersService.list();
    if (!peers.length) return { status: 'success', result: 'No hay agentes remotos configurados. Se agregan desde la GUI (Tokens A2A → Agentes remotos).' };
    return {
      status: 'success',
      result: peers.map((p) => `• ${p.name}${p.enabled ? '' : ' (deshabilitado)'} — ${p.card_url}${p.last_used_at ? ` · último uso ${new Date(p.last_used_at).toLocaleString('es-CL')}` : ''}`).join('\n'),
      data: peers,
    };
  },
});
