/**
 * Genera el hash de la contraseña de la GUI para el .env.
 *
 *   npm run gui:password
 *
 * Pide la contraseña sin mostrarla e imprime la línea GUI_PASSWORD_HASH=…
 */
import { GuiAuthService } from '../src/services/gui_auth.service.js';
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
process.stdout.write('Contraseña para la GUI: ');
(rl as any)._writeToOutput = () => {}; // no eco
rl.question('', (pw) => {
  rl.close();
  process.stdout.write('\n');
  if (!pw || pw.length < 8) { console.error('Mínimo 8 caracteres.'); process.exit(1); }
  console.log('\nPega estas dos líneas en tu .env y reinicia:\n');
  console.log(`GUI_USER=${process.env.GUI_USER || 'jleiva@dcanje.com'}`);
  console.log(`GUI_PASSWORD_HASH=${GuiAuthService.hashPassword(pw)}\n`);
  process.exit(0);
});
