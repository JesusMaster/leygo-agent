import { nostrGatewayService } from '../src/services/nostr_gateway.service.js';

const identity = nostrGatewayService.getIdentity();

console.log('===============================================================');
console.log('🤖 IDENTIDAD NOSTR DE YISUS AGENT (PARA BUZZ)');
console.log('===============================================================');
console.log(`🔑 Public Key (Hex):  ${identity.publicKeyHex}`);
console.log(`🏷️  Public Key (Npub): ${identity.publicKeyNpub}`);
console.log(`🔐 Private Key (Nsec): ${identity.secretKeyNsec}`);
console.log('---------------------------------------------------------------');
console.log('📌 COMANDO PARA AGREGAR A YISUS AL CANAL EN BUZZ CLI:');
console.log(`buzz channels add-member --channel <UUID_DEL_CANAL> --pubkey "${identity.publicKeyHex}" --role bot`);
console.log('---------------------------------------------------------------');
console.log('💬 CÓMO MENCIONARLO EN EL CANAL DE BUZZ:');
console.log(`@Yisus  o  nostr:${identity.publicKeyNpub}`);
console.log('===============================================================');
