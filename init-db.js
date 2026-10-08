// (Re)cria o banco chamando a mesma logica de init do server (via db.js)
// Uso: npm run init-db  (apaga nexora.db atual e recria com seeds)
const fs = require('fs');
const DatabaseSync = require('node:sqlite').DatabaseSync;
const { DB_PATH, initDatabase, ensureCompat } = require('./db');

try {
  if (fs.existsSync(DB_PATH)) {
    fs.unlinkSync(DB_PATH);
    console.log(`[nexora] DB antigo removido: ${DB_PATH}`);
  }
} catch (e) {
  console.error('[nexora] Falha ao remover DB antigo:', e.message);
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH);
ensureCompat(db);
initDatabase(db);
console.log(`[nexora] DB recriado com sucesso: ${DB_PATH}`);
console.log('[nexora] Seed admin: username=admin email=admin@nexora.local senha=Admin123!');
db.close();
