import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { sqliteReminderService } from '../database/sqlite.service.js';

/**
 * Inicio de sesión de la GUI.
 *
 * Credenciales en .env: GUI_USER y GUI_PASSWORD_HASH (generado con
 * `npm run gui:password`). Como salida de emergencia se acepta GUI_PASSWORD en
 * claro, con aviso en el log. Al entrar se emite un token de sesión aleatorio
 * (30 días, renovable con el uso); el guard de administración lo acepta igual
 * que a ADMIN_API_KEY, así la GUI nunca necesita conocer la clave.
 *
 * En la base solo se guarda el hash del token: si alguien lee la tabla, no
 * obtiene sesiones válidas.
 */
export class GuiAuthService {
  private readonly duracionMs = 30 * 24 * 3600 * 1000;
  private intentos = new Map<string, { n: number; hasta: number }>();

  public configurado(): boolean {
    return !!(process.env.GUI_USER && (process.env.GUI_PASSWORD_HASH || process.env.GUI_PASSWORD));
  }

  public static hashPassword(password: string): string {
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(password, salt, 64).toString('hex');
    return `scrypt$${salt}$${hash}`;
  }

  private verificarPassword(password: string): boolean {
    const hashCfg = process.env.GUI_PASSWORD_HASH;
    if (hashCfg) {
      const [alg, salt, hash] = hashCfg.split('$');
      if (alg !== 'scrypt' || !salt || !hash) return false;
      const calc = scryptSync(password, salt, 64);
      const esperado = Buffer.from(hash, 'hex');
      return calc.length === esperado.length && timingSafeEqual(calc, esperado);
    }
    const plano = process.env.GUI_PASSWORD;
    if (plano) {
      const a = Buffer.from(password), b = Buffer.from(plano);
      return a.length === b.length && timingSafeEqual(a, b);
    }
    return false;
  }

  /** 5 intentos fallidos por origen → 15 minutos de espera. */
  private bloqueado(origen: string): number {
    const r = this.intentos.get(origen);
    if (!r) return 0;
    if (r.n >= 5 && Date.now() < r.hasta) return Math.ceil((r.hasta - Date.now()) / 1000);
    if (Date.now() >= r.hasta) this.intentos.delete(origen);
    return 0;
  }
  private fallo(origen: string) {
    const r = this.intentos.get(origen) || { n: 0, hasta: 0 };
    r.n++; r.hasta = Date.now() + 15 * 60 * 1000;
    this.intentos.set(origen, r);
  }

  public login(user: string, password: string, origen: string, userAgent: string): { ok: true; token: string; expiresAt: number } | { ok: false; error: string; esperaSeg?: number } {
    if (!this.configurado()) return { ok: false, error: 'El inicio de sesión no está configurado: define GUI_USER y GUI_PASSWORD_HASH en .env (npm run gui:password).' };
    const espera = this.bloqueado(origen);
    if (espera > 0) return { ok: false, error: `Demasiados intentos. Espera ${Math.ceil(espera / 60)} min.`, esperaSeg: espera };

    const userOk = (user || '').trim().toLowerCase() === String(process.env.GUI_USER).trim().toLowerCase();
    if (!userOk || !this.verificarPassword(password || '')) {
      this.fallo(origen);
      console.warn(`🔐 [GUI] Login fallido para "${user}" desde ${origen}`);
      return { ok: false, error: 'Usuario o contraseña incorrectos.' };
    }

    this.intentos.delete(origen);
    const token = `ysess_${randomBytes(32).toString('hex')}`;
    const expiresAt = Date.now() + this.duracionMs;
    sqliteReminderService.createGuiSession(this.hash(token), String(process.env.GUI_USER), expiresAt, userAgent);
    console.log(`🔐 [GUI] Sesión iniciada por ${process.env.GUI_USER} desde ${origen}`);
    return { ok: true, token, expiresAt };
  }

  /** Devuelve el usuario si el token es una sesión válida; renueva la expiración con el uso. */
  public validar(token: string | undefined): { user: string } | null {
    if (!token || !token.startsWith('ysess_')) return null;
    const s = sqliteReminderService.getGuiSession(this.hash(token));
    if (!s || s.expires_at < Date.now()) return null;
    if (s.expires_at - Date.now() < this.duracionMs / 2) sqliteReminderService.touchGuiSession(this.hash(token), Date.now() + this.duracionMs);
    return { user: s.user };
  }

  public logout(token: string | undefined): void {
    if (token) sqliteReminderService.deleteGuiSession(this.hash(token));
  }

  private hash(token: string): string { return createHash('sha256').update(token).digest('hex'); }
}

export const guiAuthService = new GuiAuthService();
