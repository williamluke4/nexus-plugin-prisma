import { introspectionQuery } from 'graphql'
import { ptySpawn, setupE2EContext } from 'nexus-future/dist/utils/e2e-testing'
import { getTmpDir } from 'nexus-future/dist/utils/fs'
import * as Path from 'path'
import stripAnsi from 'strip-ansi'
import * as FS from 'fs-jetpack'

const tmpDir = getTmpDir()
const testProjectDir = Path.join(tmpDir, 'mysql')
const prismaSchemaPath = Path.join(testProjectDir, 'prisma', 'schema.prisma')
const ctx = setupE2EContext({
  testProjectDir,
})

test('e2e with mysql', async () => {
  console.log(ctx.projectDir)

  let nexusVersion = process.env.NEXUS_VERSION ?? 'stable'
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

  console.log('Running MySQL migration...')
  const dbInitResult = await ctx.spawnNexus(['db', 'init'])

  expect(stripAnsi(dbInitResult.data)).toContain('Done with 1 migration')
  expect(dbInitResult.exitCode).toStrictEqual(0)

  const seedResult = await ptySpawn(
    'yarn',
    ['-s', 'ts-node', 'prisma/seed.ts'],
    { cwd: ctx.projectDir },
    () => {}
  )

  expect(seedResult.data).toContain('Seeded: ')
  expect(seedResult.exitCode).toStrictEqual(0)

  // Run nexus dev and query graphql api
  await ctx.spawnNexus(['dev'], async (data, proc) => {
    if (data.includes('server:listening')) {
      const queryResult: { worlds: any[] } = await ctx.client.request(`{
        worlds {
          id
          name
          population
        }
      }`)
      const introspectionResult = await ctx.client.request(introspectionQuery)

      expect(queryResult.worlds.length).toStrictEqual(2)
      queryResult.worlds.forEach(r => {
        expect(r).toHaveProperty('id')
        expect(r).toHaveProperty('name')
        expect(r).toHaveProperty('population')
      })

      expect(introspectionResult).toMatchSnapshot('introspection')
      proc.kill()
    }
  })

  // Run nexus build
  const res = await ctx.spawnNexus(['build'], () => {})

  expect(res.data).toContain('success')
  expect(res.exitCode).toStrictEqual(0)
})
