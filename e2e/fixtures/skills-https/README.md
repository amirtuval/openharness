# Skills-import TLS fixtures

A throwaway CA and one leaf certificate, used by the skills QA specs
(`e2e/qa/skills-fixture.ts`, the repository both `qa/w30-skills.spec.ts` and
`qa/cli-skills.spec.ts` import from) to put an **https** front in front of
`@openharness/hands/testing`'s plain-HTTP git fixture.

The import route takes an `https://` URL and nothing else (epic #349, K3) while the git fixture
serves smart HTTP on loopback, so the pass terminates TLS itself and points the server's import
at `https://127.0.0.1:<port>/org/skills.git`. The front reads `server.pem`/`server.key`, and the
stack under test trusts `ca.pem` because it is started with it as `NODE_EXTRA_CA_CERTS`.

**The private key (`server.key`) is a throwaway, test-only key with no other use — and neither
half is a secret.** It was generated for this fixture, protects nothing, signs nothing else and
must never be trusted anywhere. The leaf is scoped to `IP:127.0.0.1` and `DNS:localhost` —
nothing else — because a loopback listener is the only thing it ever has to be. The CA is
trusted only by a QA stack the reader started for the pass, for the length of the pass.

| file         | what it is                                                       |
| ------------ | ---------------------------------------------------------------- |
| `ca.pem`     | the CA certificate, handed to the stack as `NODE_EXTRA_CA_CERTS` |
| `server.pem` | the leaf, valid for `127.0.0.1` and `localhost` — those only     |
| `server.key` | the leaf's private key (throwaway, test-only; see above)         |

Regenerate (keep `ca.key` outside the repository, as `e2e/fixtures/provider-stub/README.md`
says for its own CA — nothing needs to sign with it at test time):

```bash
openssl req -x509 -newkey rsa:2048 -keyout ca.key -out ca.pem -days 36500 -nodes \
  -subj "/CN=openharness-qa-skills-ca"
cat > leaf.ext <<'EOF'
[v3_req]
subjectAltName = IP:127.0.0.1,DNS:localhost
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
EOF
openssl req -newkey rsa:2048 -keyout server.key -out leaf.csr -nodes -subj "/CN=127.0.0.1"
openssl x509 -req -in leaf.csr -CA ca.pem -CAkey ca.key -CAcreateserial \
  -out server.pem -days 36500 -extfile leaf.ext -extensions v3_req
```

A stack that runs the skills pass starts with this certificate trusted and the self-host
setting on:

```bash
NODE_EXTRA_CA_CERTS=$PWD/e2e/fixtures/skills-https/ca.pem \
  OPENHARNESS_ALLOW_PRIVATE_PROVIDER_URLS=1 OPENHARNESS_TEST_MODEL=mock \
  docker compose up --build
```
