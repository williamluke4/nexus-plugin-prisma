import { setupE2EContext, getTmpDir } from 'nexus-future/dist/utils/e2e-testing'
import stripAnsi from 'strip-ansi'
//import * as FS from 'fs-jetpack'
import * as Path from 'path'

const tmpDir = getTmpDir()
const ctx = setupE2EContext(Path.join(tmpDir, 'postgres'))

test('e2e', async () => {
  try {
    console.log(ctx.tmpDir)
    // Run npx nexus-future and kill process
    const initResult = await ctx.spawnInit(
      'npm',
      'PostgreSQL',
      '@pr.419', // TODO: Change to proper version,
      data => {
        console.log(data)
      }
    )

    expect(stripAnsi(initResult.data)).toContain(
      'Run `npm run -s dev` to start working'
    )
    expect(initResult.exitCode).toStrictEqual(0)

    await ctx.spawnNexus(['nexus', 'db', 'init'])
  } catch (err) {
    console.log(err)
  }
})
