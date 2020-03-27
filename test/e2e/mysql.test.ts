import * as FS from 'fs-jetpack'
import { setupE2EContext } from 'nexus-future/dist/lib/e2e-testing'
import { getTmpDir } from 'nexus-future/dist/lib/fs'
import * as Path from 'path'
import stripAnsi from 'strip-ansi'
import { e2eTestPlugin } from './helpers'

const tmpDir = getTmpDir()
const testProjectDir = Path.join(tmpDir, 'mysql')
const prismaSchemaPath = Path.join(testProjectDir, 'prisma', 'schema.prisma')
const ctx = setupE2EContext({
  testProjectDir,
})

test('e2e with mysql', async () => {
  console.log(ctx.projectDir)

  let nexusVersion = process.env.NEXUS_VERSION ?? 'latest'
  // Run npx nexus from local path
  const initResult = await ctx.spawnNPXNexus(
    'npm',
    'MySQL',
    nexusVersion,
    () => {}
  )

  expect(stripAnsi(initResult.data)).toContain(
    'Run `npm run -s dev` to start working'
  )
  expect(initResult.exitCode).toStrictEqual(0)

  // Update database credentials
  const prismaSchemaContent = FS.read(prismaSchemaPath)!.replace(
    'mysql://root:<password>@localhost:3306/mysql',
    'mysql://root:mysql@localhost:4567/mysql'
  )

  FS.write(prismaSchemaPath, prismaSchemaContent)

  await e2eTestPlugin(ctx)
})
