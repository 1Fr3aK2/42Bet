import { readFileSync } from 'fs';

const APPROLE_DIR = '/vault/approle';

interface VaultKvResponse {
  data: { data: Record<string, string> };
}

export async function loadSecretsFromVault(): Promise<void> {
  const vaultAddr = process.env.VAULT_ADDR;

  if (!vaultAddr) {
    throw new Error('VAULT_ADDR not defined');
  }

  const roleId = readFileSync(`${APPROLE_DIR}/role_id`, 'utf-8').trim();
  const secretId = readFileSync(`${APPROLE_DIR}/secret_id`, 'utf-8').trim();


  const loginRes = await fetch(`${vaultAddr}/v1/auth/approle/login`, {
    method: 'POST',
    body: JSON.stringify({ role_id: roleId, secret_id: secretId }),
  });

  if (!loginRes.ok) {
    throw new Error(
      `Error logging AppRole to Vault: ${loginRes.status} ${await loginRes.text()}`,
    );
  }

  const loginBody = await loginRes.json();
  const clientToken = loginBody.auth.client_token;


  const pgData = await readVaultSecret(vaultAddr, clientToken, 'postgres');
  const pgUser = pgData.user;
  const pgPassword = pgData.password;
  const pgDb = process.env.POSTGRES_DB || 'appdb';
  if (!pgUser || !pgPassword) {
    throw new Error('secret/postgres needs the fields "user" and "password" defined');
  }
  process.env.DATABASE_URL = `postgresql://${pgUser}:${pgPassword}@postgres:5432/${pgDb}?schema=public`;

  const redisData = await readVaultSecret(vaultAddr, clientToken, 'redis');
  const redisPassword = redisData.password;
  if (!redisPassword) {
    throw new Error('secret/redis needs the field "password" defined');
  }
  process.env.REDIS_URL = `redis://:${redisPassword}@redis:6379`;

  const adminApiData = await readVaultSecret(vaultAddr, clientToken, 'admin-api');
  const adminApiKey = adminApiData.key;
  if (!adminApiKey) {
    throw new Error('secret/admin-api does not have "key" defined');
  }
  process.env.ADMIN_API_KEY = adminApiKey;

  const adminAccountData = await readVaultSecret(vaultAddr, clientToken, 'admin-account');
  const { username, email, password } = adminAccountData;
  if (!username || !email || !password) {
    throw new Error(
      'secret/admin-account needs the fields "username", "email" and "password" defined',
    );
  }
  process.env.ADMIN_USERNAME = username;
  process.env.ADMIN_EMAIL = email;
  process.env.ADMIN_PASSWORD = password;

  const jwtData = await readVaultSecret(vaultAddr, clientToken, 'jwt');
  const jwtSecret = jwtData.secret;
  if (!jwtSecret) {
    throw new Error('secret/jwt does not have "secret" field defined');
  }
  process.env.JWT_SECRET = jwtSecret;
}

async function readVaultSecret(
  vaultAddr: string,
  clientToken: string,
  path: string,
): Promise<Record<string, string>> {
  const res = await fetch(`${vaultAddr}/v1/secret/data/${path}`, {
    headers: { 'X-Vault-Token': clientToken },
  });

  if (!res.ok) {
    throw new Error(
      `Error reading secret/${path} from Vault: ${res.status} ${await res.text()}`,
    );
  }

  const body = (await res.json()) as VaultKvResponse;
  return body.data.data;
}