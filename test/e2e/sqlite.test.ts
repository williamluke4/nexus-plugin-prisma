import { setupE2EContext } from 'nexus-future/dist/lib/e2e-testing'
import { getTmpDir } from 'nexus-future/dist/lib/fs'
import * as Path from 'path'
import stripAnsi from 'strip-ansi'
import { e2eTestPlugin } from './helpers'

const tmpDir = getTmpDir()
const ctx = setupE2EContext({
  testProjectDir: Path.join(tmpDir, 'sqlite'),
})

test('e2e with sqlite', async () => {
  console.log(ctx.projectDir)

  let nexusVersion = process.env.NEXUS_VERSION ?? 'latest'

  // Run npx nexus
  const createAppResult = await ctx.spawnNPXNexus(
    'npm',
    'SQLite',
    nexusVersion,
    (data, proc) => {
      if (stripAnsi(data).includes('server:listening')) {
        proc.kill()
      }
    }
  )

  expect(createAppResult.data).toContain('server:listening')
  expect(createAppResult.exitCode).toStrictEqual(0)

  // Do not run migration or seed because `nexus init` does it already for sqlite
  await e2eTestPlugin(ctx, { withoutMigration: true, withoutSeed: true })
})
