import { createAuth } from '@keystone-6/auth'
import { statelessSessions } from '@keystone-6/core/session'

// No initFirstItem: the first admin user is created by script/bootstrap.ts
// from ADMIN_EMAIL/ADMIN_PASSWORD env vars before the service goes live,
// so a public first-user enrollment page is never exposed.
const { withAuth } = createAuth({
  listKey: 'User',
  identityField: 'email',
  sessionData: 'id name email',
  secretField: 'password',
})

const sessionMaxAge = 60 * 60 * 24 * 30 // 30 days

// Hosted instances fail closed if the signing key is absent. Local build-only
// SQLite instances have no admin users and are not publicly served.
if (process.env.DATABASE_URL && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET is required for hosted Postgres instances')
}
const sessionSecret = process.env.SESSION_SECRET ||
  'local-build-only-insecure-secret-not-for-hosted-use-0123456789abcdef'

const session = statelessSessions({
  maxAge: sessionMaxAge,
  secret: sessionSecret,
})

export { withAuth, session }
