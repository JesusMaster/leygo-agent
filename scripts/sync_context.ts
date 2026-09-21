import dotenv from 'dotenv';
import { contextConsolidationService } from '../src/services/context_consolidation.service.js';
import { QdrantKnowledgeService } from '../src/services/qdrant.service.js';

dotenv.config();

async function main() {
  const args = process.argv.slice(2);
  let hours = 24;

  for (const arg of args) {
    if (arg.startsWith('--hours=')) {
      hours = parseInt(arg.split('=')[1], 10) || 24;
    }
  }

  console.log(`\n🧠 Iniciando Consolidación de Contexto (Google Chat & Gmail)`);
  console.log(`⏱️  Ventana temporal: últimas ${hours} horas`);
  console.log(`🎯 Destino: Qdrant colección "${QdrantKnowledgeService.EPISODIC_COLLECTION}"\n`);

  try {
    const result = await contextConsolidationService.consolidateAll(hours);

    console.log(`\n========================================`);
    console.log(`✅ ¡Consolidación de Contexto Finalizada!`);
    console.log(`========================================`);
    console.log(`💬 Google Chat:`);
    console.log(`   - Hilos nuevos analizados: ${result.chat.processed}`);
    console.log(`   - Hilos omitidos (ya procesados): ${result.chat.threadsSkipped}`);
    console.log(`   - Decisiones indexadas: ${result.chat.indexed}`);
    console.log(`📧 Gmail:`);
    console.log(`   - Hilos nuevos analizados: ${result.gmail.processed}`);
    console.log(`   - Hilos omitidos (ya procesados): ${result.gmail.threadsSkipped}`);
    console.log(`   - Decisiones indexadas: ${result.gmail.indexed}`);
    console.log(`\n🏆 Total de nuevos registros en memoria episódica: ${result.totalIndexed}`);
    console.log(`========================================\n`);
  } catch (error: any) {
    console.error(`\n❌ Error en la consolidación de contexto:`, error.message);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\n❌ Error fatal no capturado:', err);
  process.exit(1);
});
