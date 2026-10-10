# Provider-stub TLS fixtures

A throwaway CA and one leaf certificate, used by `src/harness/provider-stub.ts` to answer a
server-under-test's provider calls offline. The stub is an HTTP proxy: the server reaches it
through the documented egress-proxy variables (`HTTPS_PROXY`, read by `catalog/provider-fetch.ts`
via undici's `EnvHttpProxyAgent`), the CONNECT tunnel is terminated with `server.pem`/`server.key`,
and the child trusts `ca.pem` because the harness passes it as `NODE_EXTRA_CA_CERTS`.

**The private key (`server.key`) is a throwaway, test-only key with no other use — and neither
half is a secret.** It was generated for this fixture, protects nothing, signs nothing else and
must never be trusted anywhere. The certificate is scoped to the stubbed provider hostnames
only: its SANs are exactly the provider hosts the stub may have to impersonate — no wildcard,
no `localhost`, nothing else. They exist so a test process can pretend to be
`api.anthropic.com` (and the other provider hosts in the SANs) on its own loopback interface;
the CA is trusted only by a server process the test itself spawns, for the length of one test
file.

| file         | what it is                                                            |
| ------------ | --------------------------------------------------------------------- |
| `ca.pem`     | the CA certificate, handed to the child as `NODE_EXTRA_CA_CERTS`      |
| `server.pem` | the leaf, valid for the provider hosts in its SANs — those hosts only |
| `server.key` | the leaf's private key (throwaway, test-only; see above)              |

Regenerate (the SAN list is the set of provider hosts the stub may have to impersonate):

```bash
openssl req -x509 -newkey rsa:2048 -keyout ca.key -out ca.pem -days 36500 -nodes \
  -subj "/CN=openharness-e2e-test-ca"
cat > leaf.ext <<'EOF'
[v3_req]
subjectAltName = DNS:api.anthropic.com,DNS:api.openai.com,DNS:generativelanguage.googleapis.com,DNS:api.groq.com,DNS:openrouter.ai,DNS:api.deepseek.com,DNS:api.mistral.ai,DNS:api.together.xyz,DNS:api.x.ai,DNS:api.cerebras.ai,DNS:api.fireworks.ai,DNS:oauth2.googleapis.com,DNS:aiplatform.googleapis.com,DNS:europe-west4-aiplatform.googleapis.com,DNS:us-central1-aiplatform.googleapis.com,DNS:bedrock.us-east-1.amazonaws.com,DNS:bedrock-runtime.us-east-1.amazonaws.com
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
EOF
openssl req -newkey rsa:2048 -keyout server.key -out leaf.csr -nodes -subj "/CN=api.anthropic.com"
openssl x509 -req -in leaf.csr -CA ca.pem -CAkey ca.key -CAcreateserial \
  -out server.pem -days 36500 -extfile leaf.ext -extensions v3_req
```

`ca.key` is deliberately **not** committed: nothing needs to sign with the CA at test time.
Keep it somewhere outside the repository if the fixtures ever need regenerating.
