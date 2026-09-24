/**
 * Genera un refresh token de Google con TODOS los scopes que usa Yisus.
 *
 * Úsalo cuando aparezca "Request had insufficient authentication scopes":
 * significa que el token actual se emitió con menos permisos de los que el
 * código necesita hoy (p. ej. participantes de Chat o estado de lectura).
 *
 *   npx tsx scripts/google_oauth.ts
 *
 * 1. Abre la URL que imprime, autoriza con tu cuenta y copia el código.
 * 2. Pégalo cuando lo pida. Imprime el GOOGLE_REFRESH_TOKEN nuevo.
 * 3. Reemplázalo en .env y reinicia.
 */
import 'dotenv/config';
import { OAuth2Client } from 'google-auth-library';
import readline from 'node:readline';

export const SCOPES = [
  // Totales por producto: cubren todo lo que el proyecto usa hoy y lo que agregue después
  'https://mail.google.com/',                              // Gmail completo
  'https://www.googleapis.com/auth/calendar',              // Calendar completo
  'https://www.googleapis.com/auth/drive',                 // Drive completo
  // Chat no tiene scope total: hay que pedir los cuatro
  'https://www.googleapis.com/auth/chat.spaces',           // listar y encontrar espacios/DMs
  'https://www.googleapis.com/auth/chat.messages',         // leer y enviar mensajes
  'https://www.googleapis.com/auth/chat.memberships.readonly',   // participantes de los DMs (chat_find_dm, nombres en la lista)
  'https://www.googleapis.com/auth/chat.users.readstate.readonly', // "hasta dónde leí" (mensajes sin leer)
];

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'https://developers.google.com/oauthplayground';

if (!clientId || !clientSecret) {
  console.error('Faltan GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET en .env');
  process.exit(1);
}

const oauth2 = new OAuth2Client(clientId, clientSecret, redirectUri);
const url = oauth2.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });

console.log('\n1) Abre esta URL, autoriza y copia el código:\n');
console.log(url);
console.log('\n   (Si el redirect es OAuth Playground, el código aparece en la URL como ?code=…)\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('2) Pega el código acá: ', async (code) => {
  rl.close();
  try {
    const { tokens } = await oauth2.getToken(decodeURIComponent(code.trim()));
    if (!tokens.refresh_token) {
      console.error('\nGoogle no devolvió refresh_token. Revoca el acceso de la app en https://myaccount.google.com/permissions y vuelve a intentar.');
      process.exit(1);
    }
    console.log('\n3) Pega esto en .env y reinicia el servicio:\n');
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
    console.log('Scopes concedidos:', (tokens.scope || '').split(' ').length);
  } catch (e: any) {
    console.error('\nError intercambiando el código:', e.message);
    process.exit(1);
  }
});
