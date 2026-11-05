import { randomBytes } from 'node:crypto'
import { addTenant } from './limiter.ts'

const [name = 'demo', max = '50000'] = process.argv.slice(2)
const key = `sk-${randomBytes(24).toString('base64url')}`
addTenant(key, name, Number(max))
console.log(key)
