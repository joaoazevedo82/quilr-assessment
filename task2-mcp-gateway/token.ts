import { SignJWT } from 'jose'

const role = process.argv[2] ?? 'viewer'
const secret = new TextEncoder().encode(process.env.JWT_SECRET ?? 'dev-secret')

console.log(await new SignJWT({ role }).setProtectedHeader({ alg: 'HS256' }).setSubject(`demo-${role}`).setIssuedAt().setExpirationTime('8h').sign(secret))
