import { createAuditHarness } from './audit-harness.mjs'
const harness = await createAuditHarness()
try {
  harness.reset()
  await harness.start()
  const result = await harness.audit()
  process.stdout.write(result.out)
  process.exitCode = result.code
} finally { await harness.close() }
