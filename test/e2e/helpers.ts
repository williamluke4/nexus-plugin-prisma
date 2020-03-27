import { introspectionQuery } from 'graphql'
import { ptySpawn, setupE2EContext } from 'nexus-future/dist/lib/e2e-testing'
import stripAnsi from 'strip-ansi'

export async function e2eTestPlugin(
  ctx: ReturnType<typeof setupE2EContext>,
  opts?: { withoutMigration?: boolean; withoutSeed?: boolean }
) {
  if (!opts?.withoutMigration) {
    console.log('Create migration file...')
    const dbMigrateSaveResult = await ctx.spawn([
      'yarn',
      'prisma2',
      'migrate',
      'save',
      '--create-db',
      '--name="init"',
      '--experimental',
    ])

    expect(stripAnsi(dbMigrateSaveResult.data)).toContain(
      'Prisma Migrate just created your migration'
    )
    expect(dbMigrateSaveResult.exitCode).toStrictEqual(0)

    console.log('Apply migration...')
    const dbMigrateUpResult = await ctx.spawn([
      'yarn',
      'prisma2',
      'migrate',
      'up',
      '--auto-approve',
      '--experimental',
    ])

    expect(stripAnsi(dbMigrateUpResult.data)).toContain('Done with 1 migration')
    expect(dbMigrateUpResult.exitCode).toStrictEqual(0)
  }

  await ctx.spawn(['yarn', 'prisma2', 'generate'])

  if (!opts?.withoutSeed) {
    const seedResult = await ptySpawn(
      'yarn',
      ['-s', 'ts-node', 'prisma/seed.ts'],
      { cwd: ctx.projectDir },
      () => {}
    )

    expect(seedResult.data).toContain('Seeded: ')
    expect(seedResult.exitCode).toStrictEqual(0)
  }

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
}
