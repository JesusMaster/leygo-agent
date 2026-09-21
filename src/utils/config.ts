import * as dotenv from 'dotenv';
dotenv.config();

export function getEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`❌ Variable de entorno requerida no definida: ${name}`);
    }
    return value;
}
