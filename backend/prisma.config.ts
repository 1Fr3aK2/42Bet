// Configures the Prisma CLI (Command Line Interface), including the schema,
// migrations, seed command, and database connection.

// Loads environment variables from the .env file into process.env.
import "dotenv/config";

// Imports the helper used to define the Prisma CLI configuration.
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",     // Specifies the location of the Prisma schema (models, relations, etc.).

  migrations: {
    path: "prisma/migrations",        // Directory where Prisma migration files are stored.
    seed: "tsx prisma/seed.ts",       // Command used to execute the database seed script.
  },

  datasource: {
    url: process.env.DATABASE_URL,    // Database connection URL, read from the environment variables.
  },
});
