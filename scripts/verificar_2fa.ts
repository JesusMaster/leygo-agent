/**
 * Verifica la ventana de gracia del 2FA por canal y el enfriamiento tras un "no".
 *
 * No toca Telegram: se reemplaza axios.post. Reproduce el caso real en que el
 * callback del botón llega por el webhook de Telegram (otro contexto async) y
 * no por el canal que pidió la acción.
 *
 *   npx tsx scripts/verificar_2fa.ts
 */
process.env.TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '1';
process.env.TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || 'x';

import axios from 'axios';
import { AsyncLocalStorage } from 'node:async_hooks';
import { telegramAuthService } from '../src/services/telegram_auth.service.js';
import { beginUsageScope } from '../src/utils/usage_collector.js';

let tarjetasEnviadas = 0;
let ultimoCallbackData = '';
(axios as any).post = async (url: string, body: any) => {
  if (url.endsWith('/sendMessage')) {
    tarjetasEnviadas++;
    ultimoCallbackData = body.reply_markup.inline_keyboard[0][0].callback_data; // auth_ok_<id>
    return { data: { result: { message_id: tarjetasEnviadas } } };
  }
  return { data: {} };
};

const als = new AsyncLocalStorage<string>();
const enCanal = <T>(canal: any, fn: () => Promise<T>) =>
  als.run(canal, async () => { beginUsageScope(canal, 'hilo', 'test'); return fn(); });

const contestar = (aprobar: boolean) =>
  // El callback llega desde el webhook de Telegram: contexto del canal "telegram"
  enCanal('telegram', () => telegramAuthService.handleCallbackQuery({
    id: 'cq', data: ultimoCallbackData.replace('auth_ok_', aprobar ? 'auth_ok_' : 'auth_no_'),
    message: { message_id: tarjetasEnviadas },
  }));

let fallos = 0;
const check = (ok: boolean, msg: string) => { console.log(`  ${ok ? 'ok' : 'XX'} ${msg}`); if (!ok) fallos++; };

async function main() {
  console.log('1) Aprobar desde el webhook de Telegram abre la ventana del canal que PIDIÓ (api)\n');
  const p1 = enCanal('api', () => telegramAuthService.requestApproval('leer chat A'));
  await new Promise((r) => setTimeout(r, 20));
  check(tarjetasEnviadas === 1, 'se envió una tarjeta');
  await contestar(true);
  check(await p1 === true, 'la primera acción quedó autorizada');
  const r2 = await enCanal('api', () => telegramAuthService.requestApproval('leer chat B'));
  check(r2 === true && tarjetasEnviadas === 1, 'la segunda acción del mismo canal pasó SIN nueva tarjeta');
  const p3 = enCanal('buzz', () => telegramAuthService.requestApproval('leer chat C'));
  await new Promise((r) => setTimeout(r, 20));
  check(tarjetasEnviadas === 2, 'otro canal (buzz) no hereda la ventana: pide su propia tarjeta');
  await contestar(false); // denegamos la de buzz para limpiar
  check(await p3 === false, 'buzz quedó denegado');

  console.log('\n2) Denegar bloquea el canal: los siguientes intentos no generan tarjetas\n');
  const antes = tarjetasEnviadas;
  const p4 = enCanal('a2a', () => telegramAuthService.requestApproval('enviar mensaje'));
  await new Promise((r) => setTimeout(r, 20));
  check(tarjetasEnviadas === antes + 1, 'primera petición de a2a envía tarjeta');
  await contestar(false);
  check(await p4 === false, 'quedó denegada');
  const r5 = await enCanal('a2a', () => telegramAuthService.requestApproval('enviar mensaje a otro'));
  const r6 = await enCanal('a2a', () => telegramAuthService.requestApproval('leer historial'));
  check(r5 === false && r6 === false && tarjetasEnviadas === antes + 1, 'dos intentos más: rechazados sin enviar NINGUNA tarjeta');
  const r7 = await enCanal('api', () => telegramAuthService.requestApproval('algo en api'));
  check(r7 === true, 'el canal api sigue con su ventana abierta (el bloqueo de a2a no lo afecta)');

  console.log('');
  console.log(fallos === 0 ? 'OK ventana por canal y enfriamiento funcionan.' : `FALLO ${fallos}.`);
  process.exit(fallos === 0 ? 0 : 1);
}
main();
