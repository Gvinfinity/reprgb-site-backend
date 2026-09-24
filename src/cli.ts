import { readFileSync, writeFileSync } from "node:fs";
import { backupDatabase, restoreDatabase } from "./core/backup.js";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { prisma } from "./PrismaClient.js";
import { z } from "zod";
async function secret(prompt: string): Promise<string> {
  if (!stdin.isTTY)
    throw new Error("Use um terminal interativo para digitar a senha.");
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const listener = (chunk: Buffer) => {
      for (const ch of chunk.toString()) {
        if (ch === "\u0003") {
          finish();
          reject(new Error("Cancelado"));
          return;
        }
        if (ch === "\r" || ch === "\n") {
          finish();
          resolve(value);
          return;
        }
        if (ch === "\u007f") {
          value = value.slice(0, -1);
        } else value += ch;
      }
    };
    const finish = () => {
      stdin.off("data", listener);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
    };
    stdin.on("data", listener);
  });
}
try {
  const command = process.argv[2];
  if (command === "backup") {
    if (!process.argv[3]) throw new Error("Informe o caminho do backup.");
    writeFileSync(
      process.argv[3],
      JSON.stringify(await backupDatabase(prisma)),
      { mode: 0o600, flag: "wx" },
    );
    console.log("Backup criado.");
  } else if (command === "restore") {
    if (!process.argv[3]) throw new Error("Informe o caminho do backup.");
    await restoreDatabase(
      prisma,
      JSON.parse(readFileSync(process.argv[3], "utf8")),
    );
    console.log("Backup restaurado.");
  } else if (command === "seed") {
    console.log(
      "Banco pronto. Nenhuma conta ou dado pessoal fictício será criado.",
    );
  } else if (command === "bootstrap" || command === "reset") {
    const rl = createInterface({ input: stdin, output: stdout });
    const email = z
      .email()
      .parse((await rl.question("E-mail: ")).trim().toLowerCase());
    const name =
      command === "bootstrap" ? (await rl.question("Nome: ")).trim() : "";
    rl.close();
    const password = z
      .string()
      .min(10)
      .max(128)
      .parse(await secret("Senha (oculta): "));
    if (password !== (await secret("Confirme a senha: ")))
      throw new Error("Senhas diferentes.");
    const hashed = await hashPassword(password);
    await prisma.$transaction(async (tx) => {
      if (command === "bootstrap") {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(817263)`;
        if (await tx.user.count({ where: { role: "admin" } }))
          throw new Error("Administrador já existe.");
        const id = randomUUID();
        await tx.user.create({
          data: {
            id,
            name,
            email,
            role: "admin",
            accounts: {
              create: {
                id: randomUUID(),
                providerId: "credential",
                accountId: id,
                password: hashed,
              },
            },
          },
        });
      } else {
        const user = await tx.user.findUniqueOrThrow({ where: { email } });
        await tx.account.updateMany({
          where: { userId: user.id, providerId: "credential" },
          data: { password: hashed },
        });
        await tx.session.deleteMany({ where: { userId: user.id } });
      }
    });
    console.log("Operação concluída.");
  } else throw new Error("Comando: bootstrap, reset ou seed");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Falha");
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
