import { introspectionQuery } from 'graphql'
import { setupE2EContext } from 'nexus-future/dist/utils/e2e-testing'
import { getTmpDir } from 'nexus-future/dist/utils/fs'
import * as Path from 'path'
import stripAnsi from 'strip-ansi'

const tmpDir = getTmpDir()
const ctx = setupE2EContext({
  testProjectDir: Path.join(tmpDir, 'sqlite'),
})

test('e2e with sqlite', async () => {
  console.log(ctx.projectDir)
  // Run npx nexus
  const createAppResult = await ctx.spawnNPXNexus(
    'npm',
    'SQLite',
    'next',
    (data, proc) => {
      if (stripAnsi(data).includes('server:listening')) {
        proc.kill()
      }
    }
  )

  expect(createAppResult.data).toContain('server:listening')
  expect(createAppResult.exitCode).toStrictEqual(0)

  // Run nexus dev and query graphql api
  await ctx.spawnNexus(['dev'], async (data, proc) => {
    if (stripAnsi(data).includes('server:listening')) {
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
