import { sqliteReminderService } from '../database/sqlite.service.js';

/**
 * Cierra el círculo de un escalamiento: cuando Jesús resuelve, la respuesta
 * tiene que volver a quien preguntó.
 *
 * Por Buzz se puede empujar: publicamos en el canal mencionando a la persona.
 * Por A2A no hay push (el cliente es otro agente que ya cerró su tarea), así
 * que la resolución queda "pendiente de entrega" y se le inyecta al agente la
 * próxima vez que ese mismo contexto escriba. Lo mismo sirve de respaldo para
 * Buzz si el relay estaba caído al resolver.
 */
export class EscalationDeliveryService {
  /** Intenta entregar de inmediato. Devuelve una nota legible de qué pasó. */
  public async notifyResolution(id: string): Promise<{ delivered: boolean; note: string }> {
    const e = sqliteReminderService.getEscalation(id);
    if (!e) return { delivered: false, note: 'Escalamiento no encontrado.' };
    if (!e.resolution) return { delivered: false, note: 'Sin texto de resolución: no hay nada que comunicar.' };

    if (e.status === 'descartado') {
      const note = 'Descartado: no se comunica nada al interlocutor.';
      sqliteReminderService.markEscalationDelivered(id, note);
      return { delivered: true, note };
    }

    switch (e.channel) {
      case 'buzz': {
        const m = /^nostr:([^:]+):([0-9a-f]{64})$/.exec(e.thread_id || '');
        if (!m) return this.dejarPendiente(id, 'Buzz: sin canal o pubkey del interlocutor; se entregará cuando vuelva a escribir.');
        const [, channelId, pubkey] = m;
        try {
          const { nostrGatewayService } = await import('./nostr_gateway.service.js');
          const texto = `Sobre tu consulta (${e.topic}): ${e.resolution}`;
          const r = await nostrGatewayService.publishToChannel(texto, channelId === 'nostr-global' ? undefined : channelId, pubkey);
          if (r.status === 'success') {
            const note = `Publicado en Buzz mencionando a ${pubkey.slice(0, 8)}… (evento ${r.eventId?.slice(0, 8)}).`;
            sqliteReminderService.markEscalationDelivered(id, note);
            return { delivered: true, note };
          }
          return this.dejarPendiente(id, `Buzz: ${r.message}. Se entregará cuando vuelva a escribir.`);
        } catch (err: any) {
          return this.dejarPendiente(id, `Buzz: ${err.message}. Se entregará cuando vuelva a escribir.`);
        }
      }
      case 'a2a': {
        // Si el token con el que nos escribió está asociado a un peer, se le empuja por A2A saliente.
        const { a2aPeersService } = await import('./a2a_peers.service.js');
        const peer = e.a2a_token ? a2aPeersService.list().find((p) => p.token_name === e.a2a_token && p.enabled) : undefined;
        if (!peer) return this.dejarPendiente(id, 'A2A: ese agente no tiene configurado un canal de vuelta (Agentes remotos); se le comunicará la próxima vez que escriba.');
        try {
          const texto = `Jesús respondió a lo que escalaste sobre "${e.topic}": ${e.resolution}`;
          await a2aPeersService.send(peer.name, texto, { contextId: e.thread_id || undefined });
          const note = `Enviado por A2A al agente "${peer.name}".`;
          sqliteReminderService.markEscalationDelivered(id, note);
          return { delivered: true, note };
        } catch (err: any) {
          return this.dejarPendiente(id, `A2A (${peer.name}): ${err.message}. Se le comunicará cuando vuelva a escribir.`);
        }
      }
      case 'telegram':
      case 'api': {
        // Quien preguntó eres tú: la resolución en la GUI es suficiente.
        const note = 'Consulta propia (Telegram/GUI): no requiere aviso.';
        sqliteReminderService.markEscalationDelivered(id, note);
        return { delivered: true, note };
      }
      default:
        return this.dejarPendiente(id, `Canal "${e.channel}": se entregará cuando el interlocutor vuelva a escribir.`);
    }
  }

  private dejarPendiente(id: string, note: string) {
    // No se marca delivered: queda para inyectarse en el próximo turno de ese hilo
    return { delivered: false, note };
  }

  /**
   * Para el arranque de un turno: si en esta conversación hay resoluciones sin
   * entregar, devuelve un bloque para anteponer al mensaje del usuario y las
   * marca como entregadas. Devuelve '' si no hay nada.
   */
  public consumePendingFor(threadId: string | undefined | null): string {
    if (!threadId) return '';
    const pendientes = sqliteReminderService.listResolvedUndelivered(threadId);
    if (!pendientes.length) return '';

    const lineas = pendientes.map((e) => {
      sqliteReminderService.markEscalationDelivered(e.id, 'Comunicado por el agente al retomar la conversación.');
      return `- Sobre "${e.topic}": ${e.resolution}`;
    });

    return (
      `[NOTA INTERNA — Jesús ya respondió lo que habías escalado en esta conversación. ` +
      `Comunícaselo al interlocutor de forma natural ANTES de atender su mensaje nuevo, sin decir que es una nota interna:\n` +
      `${lineas.join('\n')}]\n\n`
    );
  }
}

export const escalationDeliveryService = new EscalationDeliveryService();
