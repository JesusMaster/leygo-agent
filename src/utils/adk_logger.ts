import { getLogger, setLogger, type Logger } from '@google/adk';

/**
 * Filtro sobre el logger del ADK.
 *
 * "Event from an unknown agent: Coordinator/nami/…" es esperado por diseño: los
 * agentes personalizados en modo directo (@nami) escriben en la MISMA sesión que
 * el Coordinator, y cada Runner ve los eventos del otro como "desconocidos" al
 * decidir qué agente corre (los ignora y sigue con su raíz, que es lo que
 * queremos). Sin este filtro, cada turno imprime una línea por evento del
 * historial y la consola se vuelve ilegible.
 */
const SILENCIAR = [
  /^(Function response|Event) from an unknown agent: /,
];

export function instalarLoggerAdk(): void {
  const base = getLogger();
  const filtrado: Logger = {
    log: (level, ...args) => base.log(level, ...args),
    debug: (...args) => base.debug(...args),
    info: (...args) => base.info(...args),
    warn: (...args) => {
      const texto = typeof args[0] === 'string' ? args[0] : '';
      if (SILENCIAR.some((re) => re.test(texto))) return;
      base.warn(...args);
    },
    error: (...args) => base.error(...args),
    setLogLevel: (level) => base.setLogLevel(level),
  };
  setLogger(filtrado);
}
