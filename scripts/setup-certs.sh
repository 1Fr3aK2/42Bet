#!/bin/bash
set -e

if [ -f "nginx/certs/nginx.cert" ] && [ -f "vault/certs/vault.cert" ] && [ -f "vault/certs/ca.pem" ]; then
    echo "[+] Certificates already exist in nginx/certs/ and vault/certs/ — skipping."
    exit 0
fi

mkdir -p nginx/certs vault/certs

if command -v mkcert &>/dev/null; then
    echo "[*] Using mkcert to generate certificates..."
    mkcert -install >/dev/null 2>&1 || true

    cd nginx/certs
    mkcert localhost 127.0.0.1 ::1
    mv localhost+2.pem nginx.cert
    mv localhost+2-key.pem nginx.key
    chmod 644 nginx.key
    cd ../..

    cd vault/certs
    mkcert vault localhost 127.0.0.1 ::1
    mv vault+3.pem vault.cert
    mv vault+3-key.pem vault.key
    chmod 644 vault.key
    cd ../..

    cp "$(mkcert -CAROOT)/rootCA.pem" vault/certs/ca.pem
else
    echo "[*] mkcert not found. Generating local self-signed SAN certificates using OpenSSL..."

    # 1. Gerar CA interna
    openssl req -x509 -nodes -new -sha256 -days 365 -newkey rsa:2048 \
        -keyout vault/certs/ca.key -out vault/certs/ca.pem \
        -subj "/CN=TranscendenceCA"

    # 2. Gerar Certificado do Nginx com SAN
    openssl req -new -nodes -newkey rsa:2048 \
        -keyout nginx/certs/nginx.key -out nginx/certs/nginx.csr \
        -subj "/CN=localhost" \
        -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1"

    openssl x509 -req -sha256 -days 365 -in nginx/certs/nginx.csr \
        -CA vault/certs/ca.pem -CAkey vault/certs/ca.key -CAcreateserial \
        -out nginx/certs/nginx.cert \
        -copy_extensions copy

    # 3. Gerar Certificado do Vault com SAN
    openssl req -new -nodes -newkey rsa:2048 \
        -keyout vault/certs/vault.key -out vault/certs/vault.csr \
        -subj "/CN=vault" \
        -addext "subjectAltName=DNS:vault,DNS:localhost,IP:127.0.0.1,IP:::1"

    openssl x509 -req -sha256 -days 365 -in vault/certs/vault.csr \
        -CA vault/certs/ca.pem -CAkey vault/certs/ca.key -CAcreateserial \
        -out vault/certs/vault.cert \
        -copy_extensions copy

    rm -f nginx/certs/nginx.csr vault/certs/vault.csr vault/certs/ca.key vault/certs/ca.srl
fi

chmod 644 nginx/certs/nginx.key vault/certs/vault.key
echo "[+] All TLS certificates successfully generated."