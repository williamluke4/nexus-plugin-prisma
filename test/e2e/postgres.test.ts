import { setupE2EContext } from 'nexus-future/dist/lib/e2e-testing'
import { getTmpDir } from 'nexus-future/dist/lib/fs'
import * as Path from 'path'
import stripAnsi from 'strip-ansi'
import { e2eTestPlugin } from './helpers'

const tmpDir = getTmpDir()
const ctx = setupE2EContext({
  testProjectDir: Path.join(tmpDir, 'postgres'),
})

test('e2e with postgres', async () => {
  console.log(ctx.projectDir)

  let nexusVersion = process.env.NEXUS_VERSION ?? 'latest'

  // Run npx nexus from local path
  const initResult = await ctx.spawnNPXNexus(
    'npm',
    'PostgreSQL',
    nexusVersion,
    () => {}
  )

  expect(stripAnsi(initResult.data)).toContain(
    'Run `npm run -s dev` to start working'
  )
  expect(initResult.exitCode).toStrictEqual(0)

  await e2eTestPlugin(ctx)
})
