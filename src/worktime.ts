import * as Prisma from '@prisma/sdk'
import chalk from 'chalk'
import { stripIndent } from 'common-tags'
import * as fs from 'fs-jetpack'
import { Layout } from 'nexus-future/dist/lib/layout'
import { PackageManager } from 'nexus-future/dist/lib/package-manager'
import { WorkflowDefiner } from 'nexus-future/dist/lib/plugin'
import * as NexusPlugin from 'nexus-future/plugin'
import * as Path from 'path'

/**
 * Pinned query-engine version. Calculated at build time and based on `prisma2` version
 */
export const PRISMA_QUERY_ENGINE_VERSION: string = require('prisma2/package.json')
  .prisma.version

export function worktimePlugin(project: NexusPlugin.Lens): WorkflowDefiner {
  let elapsedMsSinceRestart = Date.now()

  const plugin: WorkflowDefiner = (hooks, { layout, packageManager }) => {
    project.utils.log.trace('start')
    // build
    hooks.build.onStart = async () => {
      await runPrismaGenerators(project, layout)
    }
    // create
    hooks.create.onAfterBaseSetup = async hctx => {
      if (hctx.database === undefined) {
        throw new Error(
          'Should never happen. Prisma plugin should not be installed if no database were chosen in the create workflow'
        )
      }
      const datasource = renderDatasource(
        {
          database: hctx.database,
          connectionURI: hctx.connectionURI,
        },
        layout.project.name
      )
      await Promise.all([
        fs.appendAsync(
          '.gitignore',
          '\n' +
            stripIndent`
                # Prisma
                failed-inferMigrationSteps*
              `
        ),
        fs.writeAsync(
          'prisma/schema.prisma',
          datasource +
            '\n' +
            stripIndent`
              generator prisma_client {
                provider = "prisma-client-js"
              }
     
              model World {
                id         Int    @id @default(autoincrement())
                name       String @unique
                population Float
              }
            `
        ),
        fs.writeAsync(
          'prisma/seed.ts',
          stripIndent`
              import { PrismaClient } from '@prisma/client'
  
              const db = new PrismaClient()
              
              main()
              
              async function main() {
                const results = await Promise.all(
                  [
                    {
                      name: 'Earth',
                      population: 6_000_000_000,
                    },
                    {
                      name: 'Mars',
                      population: 0,
                    },
                  ].map(data => db.world.create({ data })),
                )
              
                console.log('Seeded: %j', results)
              
                db.disconnect()
              }
            `
        ),
        fs.writeAsync(
          layout.sourcePath('graphql.ts'),
          stripIndent`
              import { schema } from "nexus-future"
      
              schema.objectType({
                name: "World",
                definition(t) {
                  t.model.id()
                  t.model.name()
                  t.model.population()
                }
              })
      
              schema.queryType({
                definition(t) {
                  t.field("hello", {
                    type: "World",
                    args: {
                      world: schema.stringArg({ required: false })
                    },
                    async resolve(_root, args, ctx) {
                      const worldToFindByName = args.world ?? 'Earth'
                      const world = await ctx.db.world.findOne({
                        where: {
                          name: worldToFindByName
                        }
                      })
      
                      if (!world) throw new Error(\`No such world named "\${args.world}"\`)
      
                      return world
                    }
                  })
  
                  t.list.field('worlds', {
                    type: 'World',
                    resolve(_root, _args, ctx) { 
                      return ctx.db.world.findMany()
                    }
                  })
                }
              })
            `
        ),
      ])
      if (hctx.connectionURI || hctx.database === 'SQLite') {
        project.utils.log.info('Initializing development database...')
        // TODO expose run on nexus-future
        await packageManager.runBin(
          'prisma2 migrate save --create-db --name init --experimental',
          {
            require: true,
          }
        )
        await packageManager.runBin('prisma2 migrate up -c --experimental', {
          require: true,
        })
        project.utils.log.info('Generating Prisma Client JS...')
        await packageManager.runBin('prisma2 generate', { require: true })
        project.utils.log.info('Seeding development database...')
        await packageManager.runBin('ts-node prisma/seed', {
          require: true,
        })
      } else {
        project.utils.log.info(stripIndent`
            1. Please setup your ${
              hctx.database
            } and fill in the connection uri in your \`${chalk.greenBright(
          'prisma/schema.prisma'
        )}\` file.
          `)
        project.utils.log.info(stripIndent`
              2. Run \`${chalk.greenBright(
                packageManager.renderRunBin(
                  'prisma2 migrate save --experimental'
                )
              )}\` to create your first migration file.
          `)
        project.utils.log.info(stripIndent`
            3. Run \`${chalk.greenBright(
              packageManager.renderRunBin('prisma2 migrate up --experimental')
            )}\` to migrate your database.
          `)
        project.utils.log.info(stripIndent`
          4. Run \`${chalk.greenBright(
            packageManager.renderRunBin('prisma2 generate')
          )}\` to generate the Prisma Client.
        `)
        project.utils.log.info(stripIndent`
            5. Run \`${chalk.greenBright(
              packageManager.renderRunBin('ts-node prisma/seed.ts')
            )}\` to seed your database.
          `)
        project.utils.log.info(stripIndent`
            6. Run \`${chalk.greenBright(
              packageManager.renderRunScript('dev')
            )}\` to start working.
          `)
      }
    }
    // generate
    hooks.generate.onStart = async () => {
      await runPrismaGenerators(project, layout)
    }
    // dev
    hooks.dev.onStart = async () => {
      await runPrismaGenerators(project, layout)
    }

    hooks.dev.onAfterWatcherRestart = () => {
      elapsedMsSinceRestart = Date.now()
    }

    hooks.dev.onFileWatcherEvent = async (_event, file, _stats, watcher) => {
      if (file.match(/.*schema\.prisma$/)) {
        // Prevent from prompting twice when some updates to the schema are queued while the prompt is shown
        const elapsed = Date.now() - elapsedMsSinceRestart
        if (elapsed < 50) {
          return
        }

        await promptForMigration(project, layout, packageManager, watcher, file)
      }
    }
    hooks.dev.addToWatcherSettings = {
      // TODO preferably we allow schema.prisma to be anywhere but they show up in
      // migrations folder too and we don't know how to achieve semantic "anywhere
      // but migrations folder"
      watchFilePatterns: ['./schema.prisma', './prisma/schema.prisma'],
      listeners: {
        app: {
          ignoreFilePatterns: ['./prisma/**', './schema.prisma'],
        },
        plugin: {
          allowFilePatterns: ['./schema.prisma', './prisma/schema.prisma'],
        },
      },
    }
  }

  return plugin
}

/**
 * Get the declared generator blocks in the user's PSL file
 */
async function getGenerators(schemaPath: string) {
  return await Prisma.getGenerators({
    schemaPath,
    printDownloadProgress: false,
    version: PRISMA_QUERY_ENGINE_VERSION,
  })
}

/**
 * Compute the resolved settings of a generator which has its baked in manifest
 * but also user-provided overrides. This computes the merger of the two.
 */
function getGeneratorResolvedSettings(
  g: Prisma.Generator
): {
  name: string
  instanceName: string
  output: string
} {
  return {
    name: g.manifest?.prettyName ?? '',
    instanceName: g.options?.generator.name ?? '',
    output: g.options?.generator.output ?? g.manifest?.defaultOutput ?? '',
  }
}

type Database = 'SQLite' | 'MySQL' | 'PostgreSQL'
type ConnectionURI = string | undefined

const DATABASE_TO_PRISMA_PROVIDER: Record<
  Database,
  'sqlite' | 'postgresql' | 'mysql'
> = {
  SQLite: 'sqlite',
  MySQL: 'mysql',
  PostgreSQL: 'postgresql',
}

function renderDatasource(
  db: {
    database: Database
    connectionURI: ConnectionURI
  },
  projectName: string
): string {
  const provider = DATABASE_TO_PRISMA_PROVIDER[db.database]

  return (
    stripIndent`
      datasource db {
        provider = "${provider}"
        url      = "${renderConnectionURI(db, projectName)}"
      }
    ` + '\n'
  )
}

const DATABASE_TO_CONNECTION_URI: Record<
  Database,
  (projectName: string) => string
> = {
  SQLite: _ => 'file:./dev.db',
  PostgreSQL: projectName =>
    `postgresql://postgres:postgres@localhost:5432/${projectName}`,
  MySQL: projectName => `mysql://root:<password>@localhost:3306/${projectName}`,
}

function renderConnectionURI(
  db: {
    database: Database
    connectionURI: ConnectionURI
  },
  projectName: string
): string {
  if (db.connectionURI) {
    return db.connectionURI
  }

  return DATABASE_TO_CONNECTION_URI[db.database](projectName)
}

/**
 * Execute all the generators in the user's PSL file.
 */
async function runPrismaGenerators(
  project: NexusPlugin.Lens,
  layout: Layout,
  options: { silent: boolean } = { silent: false }
): Promise<void> {
  if (!options.silent) {
    project.utils.log.info('Running Prisma generators ...')
  }

  const schemaPath = maybeFindPrismaSchema(layout)

  if (!schemaPath) {
    project.utils.log.error(stripIndent`
      We could not find any \`schema.prisma\` file. Please create one or check out the docs to get started here: http://nxs.li/nexus-plugin-prisma
      `)
    process.exit(1)
  }

  project.utils.log.trace('loading generators...')
  let generators = await getGenerators(schemaPath)
  project.utils.log.trace('generators loaded.')

  if (
    !generators.find(g => g.options?.generator.provider === 'prisma-client-js')
  ) {
    await scaffoldPrismaClientGeneratorBlock(project, schemaPath)
    // TODO: Generate it programmatically instead for performance reason
    generators = await getGenerators(schemaPath)
  }

  for (const g of generators) {
    const resolvedSettings = getGeneratorResolvedSettings(g)
    project.utils.log.trace('generating', resolvedSettings)
    await g.generate()
    g.stop()
    project.utils.log.trace('done generating', resolvedSettings)
  }
}

/**
 * Find the PSL file in the project. If multiple are found a warning is logged.
 */
function maybeFindPrismaSchema(layout: Layout): string | null {
  const projectRoot = layout.projectRoot
  let schemaPath = Path.join(projectRoot, 'schema.prisma')

  if (fs.exists(schemaPath)) {
    return schemaPath
  }

  schemaPath = Path.join(projectRoot, 'prisma', 'schema.prisma')

  if (fs.exists(schemaPath)) {
    return schemaPath
  }

  return null
}

async function scaffoldPrismaClientGeneratorBlock(
  project: NexusPlugin.Lens,
  schemaPath: string
) {
  const relativeSchemaPath = Path.relative(process.cwd(), schemaPath)
  project.utils.log.warn(
    `A Prisma Client JS generator block is needed in your Prisma Schema at "${relativeSchemaPath}".`
  )
  project.utils.log.warn('We scaffolded one for you.')
  const schemaContent = await fs.readAsync(schemaPath)!
  const generatorBlock = stripIndent`
      generator prisma_client {
        provider = "prisma-client-js"
      }
    `
  await fs.writeAsync(schemaPath, `${generatorBlock}\n${schemaContent}`)
}

async function promptForMigration(
  project: NexusPlugin.Lens,
  layout: Layout,
  packageManager: PackageManager,
  watcher: {
    restart: (file: string) => void
    pause: () => void
    resume: () => void
  },
  file: string
) {
  watcher.pause()
  project.utils.log.info('We detected a change in your Prisma Schema file.')
  project.utils.log.info(
    "If you're using Prisma Migrate, follow the step below:"
  )
  project.utils.log.info(
    `1. Run ${chalk.greenBright(
      packageManager.renderRunBin('prisma2 migrate save --experimental')
    )} to create a migration file.`
  )
  project.utils.log.info(
    `2. Run ${chalk.greenBright(
      packageManager.renderRunBin('prisma2 migrate up --experimental')
    )} to apply your migration.`
  )
  await project.utils.prompt({
    type: 'confirm',
    name: 'confirm',
    message: 'Press Y to restart once your migration is applied',
    initial: true,
    yesOption: '(Y)',
    noOption: '(Y)',
    yes: 'Restarting...',
    no: 'Restarting...',
  } as any)

  await runPrismaGenerators(project, layout)
  watcher.restart(file)
}
