// 1. Die URL definieren und setzen BEVOR der PrismaClient importiert wird.
// So ist sichergestellt, dass Prisma nie "undefined" liest.
const dbUrl = 'file:./dev.db';
process.env.DATABASE_URL = dbUrl;

const { PrismaClient } = require('@prisma/client');

// Den manuellen Import von @libsql/client (createClient) brauchen wir nicht mehr!

const prismaPromise = (async () => {
  const mod = await import('@prisma/adapter-libsql');
  const PrismaLibSQL = mod.PrismaLibSql || mod.PrismaLibSQL || mod.default?.PrismaLibSql || mod.default;

  // 2. Das Konfigurationsobjekt DIREKT an den Adapter übergeben
  const adapter = new PrismaLibSQL({
    url: dbUrl,
  });

  return new PrismaClient({ adapter });
})();

async function getPrismaClient() {
  return await prismaPromise;
}

module.exports = { getPrismaClient };