import { SignJWT } from 'jose'

const role = process.argv[2] ?? 'viewer'
const secret = new TextEncoder().encode(process.env.JWT_SECRET ?? 'dev-secret')

console.log(
  await new SignJWT({ role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(`demo-${role}`)
    .setIssuer(process.env.JWT_ISSUER ?? 'demo-issuer')
    .setAudience(process.env.JWT_AUDIENCE ?? 'mcp-gateway')
    .setIssuedAt()
    .setExpirationTime('8h')
    .sign(secret),
)
