/**
 * Backfill de compromisos desde la memoria episódica (Meet, Chat, Gmail).
 * Idempotente: relanzarlo no duplica. También se puede lanzar desde la GUI.
 *
 *   npm run commitments:backfill            # todo
 *   npm run commitments:backfill -- 2026-06-01   # solo desde esa fecha
 */
import 'dotenv/config';
import { commitmentsBackfillService } from '../src/services/commitments_backfill.service.js';

const desde = process.argv[2];
commitmentsBackfillService.iniciar({ desde });
const timer = setInterval(() => {
  const e = commitmentsBackfillService.estado;
  process.stdout.write(`\r  puntos ${e.puntos} · procesados ${e.procesados} · saltados ${e.saltados} · nuevos ${e.nuevos} · repetidos ${e.repetidos}   `);
  if (!e.corriendo) {
    clearInterval(timer);
    console.log(e.error ? `\n❌ ${e.error}` : `\n✅ Listo: ${e.nuevos} compromiso(s) propuesto(s).`);
    process.exit(e.error ? 1 : 0);
  }
}, 1000);
