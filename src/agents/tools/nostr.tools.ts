import { FunctionTool } from '@google/adk';
import { z } from 'zod';

/**
 * Publica un mensaje en el canal de Buzz (Nostr) firmado con la identidad de Yisus.
 * Es la pata de SALIDA del NostrGateway: sin esto el agente solo puede responder
 * a mensajes entrantes, y confunde "enviar al canal" con Google Chat.
 */
export const buzzSendMessage = new FunctionTool({
  name: 'buzz_send_message',
  description: 'Publica un mensaje nuevo en el canal de Buzz (Nostr) firmado como Yisus. Úsala cuando pidan enviar, publicar o avisar algo "en Buzz", "en el canal de Buzz", "por Nostr" o "en la comunidad". NO es Google Chat.',
  parameters: z.object({
    message: z.string().describe('Texto del mensaje a publicar en el canal.'),
    channelId: z.string().optional().describe('ID del canal de Buzz. Si se omite, usa el canal configurado por defecto.'),
  }) as any,
  execute: async (args: any) => {
    const { message, channelId } = args;
    try {
      const { telegramAuthService } = await import('../../services/telegram_auth.service.js');
      const isAuthorized = await telegramAuthService.requestApproval(
        `Publicar en el canal de Buzz como Yisus: "${String(message).slice(0, 200)}"`,
        45000,
        {
          title: 'PUBLICACIÓN EN BUZZ (Yisus Agent)',
          subtitle: 'Se va a publicar un mensaje visible para todo el canal:',
          question: '¿Confirmas la publicación?',
        }
      );
      if (!isAuthorized) {
        return { status: 'error', message: 'Publicación cancelada: no se autorizó desde Telegram.' };
      }

      const { nostrGatewayService } = await import('../../services/nostr_gateway.service.js');
      const result = await nostrGatewayService.publishToChannel(message, channelId);

      if (result.status === 'error') {
        return { status: 'error', message: result.message };
      }

      return {
        status: 'success',
        result: `✅ Mensaje publicado en el canal de Buzz [${result.channel}] (EventID: ${result.eventId?.slice(0, 8)}).`,
        data: result,
      };
    } catch (error: any) {
      return { status: 'error', message: `Error publicando en Buzz: ${error.message}` };
    }
  },
});

/**
 * Estado del bridge Nostr (diagnóstico)
 */
export const buzzStatus = new FunctionTool({
  name: 'buzz_status',
  description: 'Informa el estado del bridge de Buzz/Nostr: si está conectado al relay, con qué identidad (npub) y a qué canales está suscrito.',
  parameters: z.object({}) as any,
  execute: async () => {
    try {
      const { nostrGatewayService } = await import('../../services/nostr_gateway.service.js');
      const st = nostrGatewayService.getStatus();
      return {
        status: 'success',
        result: `Bridge Buzz/Nostr — ${st.connected ? 'conectado ✅' : 'desconectado ❌'}\n` +
                `- Relay: ${st.relay}\n- Identidad: ${st.npub}\n- Canales: ${st.channels.join(', ')}`,
        data: st,
      };
    } catch (error: any) {
      return { status: 'error', message: `Error consultando el estado del bridge: ${error.message}` };
    }
  },
});
