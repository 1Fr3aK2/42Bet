import { readFileSync } from 'fs';

const APPROLE_DIR = '/vault/approle';           // Directory containing the AppRole credentials used to authenticate with Vault

// Defines the expected structure of a Vault KV v2 secret response
interface VaultKvResponse {
  data: { data: Record<string, string> };       // Record<string, string>: object with string keys and string values
}

// Retrieves secrets from Vault and loads them into the Node.js process environment
export async function loadSecretsFromVault(): Promise<void> {

  const vaultAddr = process.env.VAULT_ADDR;        // Reads the Vault address from an existing environment variable
  if (!vaultAddr) {
    throw new Error('VAULT_ADDR not defined');
  }

  // Reads the AppRole credentials from files; trim() removes surrounding whitespace and newlines
  const roleId = readFileSync(`${APPROLE_DIR}/role_id`, 'utf-8').trim();
  const secretId = readFileSync(`${APPROLE_DIR}/secret_id`, 'utf-8').trim();

  // Authenticates the backend with Vault using AppRole credentials
  const loginRes = await fetch(`${vaultAddr}/v1/auth/approle/login`, {
    method: 'POST',
    body: JSON.stringify({ role_id: roleId, secret_id: secretId }),     // Converts the credentials object into a JSON string
  });

  if (!loginRes.ok) {     // Checks whether the HTTP response indicates success (status 200–299)
    throw new Error(
      `Error logging AppRole to Vault: ${loginRes.status} ${await loginRes.text()}`,
    );
  }

  const loginBody = await loginRes.json();            // Parses the JSON response into a JavaScript object
  const clientToken = loginBody.auth.client_token;    // Extracts the token used to access Vault secrets

  // PostgreSQL credentials
  const pgData = await readVaultSecret(vaultAddr, clientToken, 'postgres');
  const pgUser = pgData.user;
  const pgPassword = pgData.password;
  const pgDb = process.env.POSTGRES_DB || 'appdb';    // Uses POSTGRES_DB, or 'appdb' if no truthy value is defined
  if (!pgUser || !pgPassword) {
    throw new Error('secret/postgres needs the fields "user" and "password" defined');
  }
  // Builds the PostgreSQL connection URL and stores it in the process environment
  process.env.DATABASE_URL = `postgresql://${pgUser}:${pgPassword}@postgres:5432/${pgDb}?schema=public`;

  // Redis credentials
  const redisData = await readVaultSecret(vaultAddr, clientToken, 'redis');
  const redisPassword = redisData.password;
  if (!redisPassword) {
    throw new Error('secret/redis needs the field "password" defined');
  }
  // Builds the Redis connection URL and stores it in the process environment
  process.env.REDIS_URL = `redis://:${redisPassword}@redis:6379`;

  // Public Admin API credentials
  const adminApiData = await readVaultSecret(vaultAddr, clientToken, 'admin-api');
  const adminApiKey = adminApiData.key;
  if (!adminApiKey) {
    throw new Error('secret/admin-api does not have "key" defined');
  }
  // Makes the API key available to the backend (e.g., AdminApiKeyGuard)
  process.env.ADMIN_API_KEY = adminApiKey;

  // Administrative account credentials
  const adminAccountData = await readVaultSecret(vaultAddr, clientToken, 'admin-account');
  const { username, email, password } = adminAccountData;     // Object destructuring: extracts three properties into local variables
  if (!username || !email || !password) {
    throw new Error(
      'secret/admin-account needs the fields "username", "email" and "password" defined',
    );
  }
  // Writes the retrieved values into process.env (does not modify the .env file)
  process.env.ADMIN_USERNAME = username;
  process.env.ADMIN_EMAIL = email;
  process.env.ADMIN_PASSWORD = password;

  // JWT signing secret
  const jwtData = await readVaultSecret(vaultAddr, clientToken, 'jwt');
  const jwtSecret = jwtData.secret;
  if (!jwtSecret) {
    throw new Error('secret/jwt does not have "secret" field defined');
  }
  // Makes the JWT secret available to the authentication system
  process.env.JWT_SECRET = jwtSecret;
}

// Reads a secret from Vault using its path and an authenticated client token
async function readVaultSecret(
  vaultAddr: string,
  clientToken: string,
  path: string,
): Promise<Record<string, string>> {      // Returns a Promise resolving to an object containing string key-value pairs
  const res = await fetch(`${vaultAddr}/v1/secret/data/${path}`, {
    headers: { 'X-Vault-Token': clientToken },    // Sends the authentication token in the HTTP request header
  });

  if (!res.ok) {
    throw new Error(
      `Error reading secret/${path} from Vault: ${res.status} ${await res.text()}`,
    );
  }

  const body = (await res.json()) as VaultKvResponse;     // Type assertion: tells TypeScript the expected response structure (no runtime validation)
  return body.data.data;                                  // Extracts the actual secret values from the nested Vault KV v2 response
}

/*
   HashiCorp Vault: A secrets management system that securely stores and controls
   access to sensitive information (passwords, API keys, tokens, etc.).
  
   AppRole: A Vault authentication method designed for applications.
     - roleId: Identifies the application's role.
     - secretId: Secret credential used to authenticate the application.
     - clientToken: Token issued after authentication, granting access to
       secrets according to the role's permissions (policies).
  
   KV (Key-Value): A Vault secrets engine that stores data as key-value pairs.
     - KV v2: Supports secret versioning and maintains metadata.
     - Secret path: Identifies where a secret is stored (e.g., secret/postgres).
  
   VaultKvResponse: TypeScript interface describing the Vault KV v2 JSON response.
     - data.data: Contains the actual secret key-value pairs.
     - Record<string, string>: Object with string keys and string values.
  
   Vault bootstrap: Authenticates the backend with Vault, retrieves the secrets,
   and loads them into process.env for use by the application.
  
   process.env: Node.js object providing access to environment variables.
   Assigning values to it does not modify the .env file on disk.
 */