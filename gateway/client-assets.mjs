import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export function clientAssets(directory, version, tools) {
  const digest = value => crypto.createHash('sha256').update(value).digest('hex')
  const skill = 'skills/codex-gateway-image/SKILL.md'
  const roots = [path.join(directory,'../docs/lan-kit'),path.join(directory,'../lan-kit'),path.join(directory,'lan-kit')]
  const root = roots.find(root => fs.existsSync(path.join(root,skill)))
  if (!root) throw new Error('client_skill_missing')
  return {
    schemaVersion: 1, gatewayVersion: version,
    skill: { url:'/lan-kit/' + skill, sha256:digest(fs.readFileSync(path.join(root,skill))) },
    mcp: { url:'/mcp', sha256:digest(JSON.stringify(tools)) },
    prompt: { url:'/client-setup.js', sha256:digest(fs.readFileSync(path.join(directory,'client-setup.js'))) }
  }
}
