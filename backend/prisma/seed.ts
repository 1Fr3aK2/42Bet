import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { loadSecretsFromVault } from '../src/vault/vault-bootstrap';

const prisma = new PrismaClient();

async function main() {

  await loadSecretsFromVault();

  const username = process.env.ADMIN_USERNAME;
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;

  if (!username || !email || !password) {
    throw new Error(
      'ADMIN_USERNAME, ADMIN_EMAIL and ADMIN_PASSWORD must be defined',
    );
  }

  const existingAdmin = await prisma.user.findFirst({
    where: {
      role: Role.ADMIN,
    },
  });

  if (existingAdmin) {
    console.log(`Admin already exists: ${existingAdmin.username}`);
    return;
  }

  // bcrypt: Library for securely hashing passwords.
  // Hash: A one-way transformation that allows password verification
  //       without storing the original password.
  // Salt: A random value generated for each password, ensuring that
  //       identical passwords produce different hashes.
  //       bcrypt automatically generates and stores the salt within the hash.
  // 10: Cost factor (salt rounds), meaning 2^10 = 1024 iterations of bcrypt's
  //     key setup process. Higher values increase security but also processing time.
  const hashedPassword = await bcrypt.hash(password, 10);

  const admin = await prisma.user.create({
    data: {
      username,
      email,
      password: hashedPassword,
      role: Role.ADMIN,
    },
  });

  console.log(`Admin created: ${admin.username}`);
}

// Executes the main seed function (which returns a Promise).
main()
  .catch((error) => {
    // Runs if main() fails: logs the error and terminates the process with exit code 1 (failure).
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    // Runs after main() succeeds or fails, closing the Prisma database connection.
    await prisma.$disconnect();
  });
