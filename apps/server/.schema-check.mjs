import { betterAuth } from 'better-auth'
import { bearer, deviceAuthorization } from 'better-auth/plugins'
import { google, github, microsoft } from 'better-auth/social-providers'

export const auth = betterAuth({
  secret: 'a-test-secret-that-is-long-enough-for-better-auth',
  baseURL: 'http://localhost:3000',
  database: { db: null, type: 'postgres' },
  socialProviders: {
    google: google({ clientId: 'g', clientSecret: 'gs' }),
    github: github({ clientId: 'gh', clientSecret: 'ghs' }),
    microsoft: microsoft({ clientId: 'm', clientSecret: 'ms', tenantId: 'common' }),
  },
  emailAndPassword: { enabled: true, disableSignUp: true },
  session: { expiresIn: 7 * 24 * 60 * 60, updateAge: 24 * 60 * 60, freshAge: 24 * 60 * 60 },
  rateLimit: { enabled: true },
  plugins: [
    deviceAuthorization({ verificationUri: 'http://localhost:3000/device', expiresIn: '10m', validateClient: () => true }),
    bearer(),
  ],
})
