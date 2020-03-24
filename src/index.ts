import * as Prisma from '@prisma/sdk'
import StudioServer from '@prisma/studio-server'
import chalk from 'chalk'
import { stripIndent } from 'common-tags'
import * as fs from 'fs-jetpack'
import getPort from 'get-port'
import { SuccessfulRunResult } from 'nexus-future/dist/lib/process'
import { shouldGenerateArtifacts } from 'nexus-future/dist/runtime/schema/config'
import * as NexusPlugin from 'nexus-future/plugin'
import { nexusPrismaPlugin, Options } from 'nexus-prisma'
import open from 'open'
import * as Path from 'path'
import { suggestionList } from './lib/levenstein'
import { printStack } from './lib/print-stack'
import { simpleDebounce } from './lib/simpleDebounce'
import { getPrismaClientInstance, linkableResolve } from './utils'

if (process.env.LINK) {
  process.env.NEXUS_PRISMA_LINK = process.env.LINK
}

type UnknownFieldName = {
  error: Error
  unknownFieldName: string
  validFieldNames: string[]
  typeName: string
}

export type UnknownFieldType = {
  unknownFieldType: string
  error: Error
  typeName: string
  fieldName: string
}

type OptionsWithHook = Options & {
  onUnknownFieldName: (params: UnknownFieldName) => void
  onUnknownFieldType: (params: UnknownFieldType) => void
}

/**
 * Pinned query-engine version. Calculated at build time and based on `prisma2` version
 */
const PRISMA_QUERY_ENGINE_VERSION = require('../package.json').prisma.version

// HACK
// 1. https://prisma-company.slack.com/archives/C8AKVD5HU/p1574267904197600
// 2. https://prisma-company.slack.com/archives/CEYCG2MCN/p1574267824465700
const GENERATED_PRISMA_CLIENT_OUTPUT_PATH = Path.dirname(
  linkableResolve('@prisma/client')
)

export default NexusPlugin.create(project => {
  const nexusPrismaTypegenOutput = fs.path(
    'node_modules/@types/typegen-nexus-prisma/index.d.ts'
  )

  project.runtime(() => {
    project.utils.log.trace('start')
    const prisma = getPrismaClientInstance()

    return {
      context: {
        create: _req => {
          return { db: prisma }
        },
        typeGen: {
          fields: {
            db: 'Prisma.PrismaClient',
          },
          // import not needed here because it will already be from the
          // typegenAutoConfig below
          // imports: [
          //   {
          //     as: 'Photon',
          //     from: GENERATED_PHOTON_OUTPUT_PATH,
          //   },
          // ],
        },
      },
      nexus: {
        typegenAutoConfig: {
          // https://github.com/prisma-labs/nexus-prisma/blob/master/examples/hello-world/app.ts#L14
          sources: [
            {
              source: Path.join(
                GENERATED_PRISMA_CLIENT_OUTPUT_PATH,
                '/index.d.ts'
              ),
              alias: 'Prisma',
            },
          ],
        },
        plugins: [
          nexusPrismaPlugin({
            inputs: {
              prismaClient: GENERATED_PRISMA_CLIENT_OUTPUT_PATH,
            },
            outputs: {
              typegen: nexusPrismaTypegenOutput,
            },
            prismaClient: ctx => ctx.db,
            shouldGenerateArtifacts: shouldGenerateArtifacts(),
            onUnknownFieldName: params => renderUnknownFieldNameError(params),
            onUnknownFieldType: params => renderUnknownFieldTypeError(params),
          } as OptionsWithHook),
        ] as any, //TODO: REMOVE ME ONCE THE TRANSITION WITH NEXUS IS DONE. Reason: Type conflict between nexus and @nexus/schema
      },
    }
  })

  project.workflow((hooks, { layout, packageManager }) => {
    project.utils.log.trace('start')
    // build

    hooks.build.onStart = async () => {
      await runPrismaGenerators()
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
            packageManager.renderRunBin('nexus db init')
          )}\` to initialize your database.
        `)
        project.utils.log.info(stripIndent`
          3. Run \`${chalk.greenBright(
            packageManager.renderRunBin('ts-node prisma/seed.ts')
          )}\` to seed your database.
        `)
        project.utils.log.info(stripIndent`
          4. Run \`${chalk.greenBright(
            packageManager.renderRunScript('dev')
          )}\` to start working.
        `)
      }
    }

    // generate

    hooks.generate.onStart = async () => {
      await runPrismaGenerators()
    }

    // dev

    hooks.dev.onStart = async () => {
      await runPrismaGenerators()
    }

    const migrateDb = simpleDebounce(async () => {
      project.utils.log.info(`Prisma Schema change detected, migrating...`)
      // Raw code being run is this https://github.com/prisma/lift/blob/dce60fe2c44e8a0d951d961187aec95a50a33c6f/src/cli/commands/LiftTmpPrepare.ts#L33-L45
      project.utils.log.trace('running prisma migrate...')
      const result = await project.utils.run('prisma2 tmp-prepare', {
        require: true,
      })

      project.utils.log.trace('result', result)

      return result
    })

    hooks.dev.onFileWatcherEvent = async (_event, file, _stats, runner) => {
      if (file.match(/.*schema\.prisma$/)) {
        await migrateDb()
        project.utils.log.info('Migration applied')
        runner.restart(file)
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

    hooks.db = {
      init: {
        onStart: async () => {
          const initResponse = await packageManager.runBin(
            'prisma2 migrate save --name init --create-db --experimental',
            { envAdditions: { FORCE_COLOR: 'true' } }
          )

          if (
            handleLiftResponse(
              project,
              initResponse,
              'We could not initialize your database',
              { silentStdout: true }
            )
          ) {
            const migrateResponse = await packageManager.runBin(
              'prisma2 migrate up -c --auto-approve --experimental',
              { envAdditions: { FORCE_COLOR: 'true' } }
            )
            if (
              handleLiftResponse(
                project,
                migrateResponse,
                'We could not initialize your database'
              )
            ) {
              await runPrismaGenerators({ silent: true })
            }
          }
        },
      },
      migrate: {
        apply: {
          onStart: async hctx => {
            if (!hctx.force) {
              const previewResponse = await packageManager.runBin(
                'prisma2 migrate up --preview --auto-approve --experimental',
                { envAdditions: { FORCE_COLOR: 'true' } }
              )

              if (
                !handleLiftResponse(
                  project,
                  previewResponse,
                  'We could not run a dry-run of your migration'
                )
              ) {
                return
              }

              if (
                previewResponse.stdout?.includes(
                  'All migrations are already applied'
                )
              ) {
                return
              }

              const { confirm } = await project.utils.prompt({
                type: 'confirm',
                name: 'confirm',
                message: 'Do you want to apply the above migration?',
              })

              if (!confirm) {
                project.utils.log.info('Migration not applied.')
                return
              }
            }

            console.log()
            const response = await packageManager.runBin(
              'prisma2 migrate up --auto-approve --experimental',
              {
                envAdditions: { FORCE_COLOR: 'true' },
              }
            )

            handleLiftResponse(
              project,
              response,
              'We could not migrate your database'
            )
          },
        },
        plan: {
          onStart: async hctx => {
            let migrationName = hctx.migrationName

            if (!migrationName) {
              const inputMigration = await project.utils.prompt({
                type: 'text',
                name: 'name',
                message: `Name of your migration`,
                validate: (value: string) => {
                  if (value.length === 0) {
                    return 'Migration names needs to have a least one character'
                  }

                  if (value.includes(' ')) {
                    return "Migration names cannot contain spaces. Use '-' instead"
                  }

                  return true
                },
              })

              migrationName = inputMigration.name
            }

            const response = await packageManager.runBin(
              `prisma2 migrate save --experimental --name ${migrationName}`,
              { envAdditions: { FORCE_COLOR: 'true' } }
            )

            handleLiftResponse(
              project,
              response,
              'We could not generate a migration file'
            )
          },
        },
        rollback: {
          onStart: async () => {
            const response = await packageManager.runBin(
              'prisma2 migrate down --experimental',
              {
                envAdditions: { FORCE_COLOR: 'true' },
              }
            )

            handleLiftResponse(
              project,
              response,
              'We could not rollback your migration'
            )
          },
        },
      },
      ui: {
        onStart: async hctx => {
          const studio = await startStudio(hctx.port)

          if (studio) {
            await studio?.instance.start()

            await open(`http://localhost:${studio.port}`)

            project.utils.log.info(`Studio started`, {
              url: `http://localhost:${studio.port}`,
            })
          }
        },
      },
    }
  })

  /**
   * Execute all the generators in the user's PSL file.
   */
  async function runPrismaGenerators(
    options: { silent: boolean } = { silent: false }
  ): Promise<void> {
    const schemaPath = await maybeFindPrismaSchema()

    if (!schemaPath) {
      throw new Error('please create a prisma file')
    }

    // TODO Do not assume that just because prisma client does not need to be regenerated that no other generators do
    if ((await shouldRegeneratePrismaClient(schemaPath)) === false) {
      project.utils.log.trace(
        'Prisma generators were not run because the prisma schema was not updated'
      )
      return
    }

    if (!options.silent) {
      project.utils.log.info('Running Prisma generators ...')
    }

    let generators = await getGenerators(schemaPath)

    if (
      !generators.find(
        g => g.options?.generator.provider === 'prisma-client-js'
      )
    ) {
      await scaffoldPrismaClientGeneratorBlock(schemaPath)
      // TODO: Generate it programmatically instead for performance reason
      generators = await getGenerators(schemaPath)
    }

    for (const g of generators) {
      const resolvedSettings = getGeneratorResolvedSettings(g)
      project.utils.log.trace('generating', resolvedSettings)
      await g.generate()
      g.stop()
    }
  }

  /**
   * Find the PSL file in the project. If multiple are found a warning is logged.
   */
  async function maybeFindPrismaSchema(): Promise<null | string> {
    // TODO ...base ignores from nexus-future... nexus-future.fs.findAsync?
    const schemaPaths = await fs.findAsync({
      matching: [
        'schema.prisma',
        '!prisma/migrations/**/*',
        '!node_modules/**/*',
      ],
    })

    if (schemaPaths.length > 1) {
      project.utils.log.warn(
        `We found multiple "schema.prisma" files in your project.\n${schemaPaths
          .map((p, i) => `- "${p}"${i === 0 ? ' (used by nexus-future)' : ''}`)
          .join('\n')}`
      )
    }

    return schemaPaths[0] ?? null
  }

  /**
   * Regenerate Prisma Client JS only if schema was updated between last generation
   */
  async function shouldRegeneratePrismaClient(
    localSchemaPath: string
  ): Promise<boolean> {
    const prismaClientSchemaPath = Path.join(
      GENERATED_PRISMA_CLIENT_OUTPUT_PATH,
      'schema.prisma'
    )

    project.utils.log.trace(
      "checking if prisma client needs to be regenerated by comparing users PSL to prisma clients' local copy...",
      { prismaClientSchemaPath, localSchemaPath }
    )

    const [clientSchema, localSchema] = await Promise.all([
      fs.readAsync(prismaClientSchemaPath),
      fs.readAsync(localSchemaPath),
    ])

    if (clientSchema !== undefined && localSchema !== undefined) {
      project.utils.log.trace(
        '...found Prisma Client and its local version of PSL'
      )
      if (clientSchema === localSchema) {
        project.utils.log.trace(
          "...found that its local PSL version matches user's current, will NOT regenerate Prisma Client"
        )
        return false
      } else {
        project.utils.log.trace(
          "...found that its local PSL version does not match user's current, WILL regenerate Prisma Client"
        )
        return true
      }
    } else {
      project.utils.log.trace(
        '...did not find generated Prisma Client package or its local copy of PSL'
      )
      return true
    }
  }

  async function scaffoldPrismaClientGeneratorBlock(schemaPath: string) {
    const schemaPathAbs = Path.relative(process.cwd(), schemaPath)
    project.utils.log.warn(
      `A Prisma Client JS generator block is needed in your Prisma Schema at "${schemaPathAbs}".`
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

  async function startStudio(
    port: number | undefined
  ): Promise<{ port: number; instance: StudioServer } | null> {
    try {
      if (!port) {
        port = await getPort({ port: getPort.makeRange(5555, 5600) })
      }

      const schema = await maybeFindPrismaSchema()

      if (!schema) {
        project.utils.log.error('We could not find your schema.prisma file')
        return null
      }

      const instance = new StudioServer({
        port,
        debug: false,
        schemaPath: schema,
        prismaClient: {
          dir: GENERATED_PRISMA_CLIENT_OUTPUT_PATH,
        },
      })

      return { port, instance }
    } catch (e) {
      project.utils.log.error(e)
      return null
    }
  }
})

/**
 * TODO ...
 */
function renderUnknownFieldNameError(params: UnknownFieldName) {
  const { stack, fileLineNumber } = printStack({
    callsite: params.error.stack,
  })
  const suggestions = suggestionList(
    params.unknownFieldName,
    params.validFieldNames
  ).map(s => chalk.green(s))
  const suggestionMessage =
    suggestions.length === 0
      ? ''
      : chalk`{yellow Warning:} Did you mean ${suggestions
          .map(s => `"${s}"`)
          .join(', ')} ?`
  const intro = chalk`{yellow Warning:} ${params.error.message}\n{yellow Warning:} in ${fileLineNumber}\n${suggestionMessage}`

  // todo use logger once "pretty" api done
  console.log(`${intro}${stack}`)
}

/**
 * TODO ...
 */
function renderUnknownFieldTypeError(params: UnknownFieldType) {
  const { stack, fileLineNumber } = printStack({
    callsite: params.error.stack,
  })

  const intro = chalk`{yellow Warning:} ${params.error.message}\n{yellow Warning:} in ${fileLineNumber}`

  // todo use logger once "pretty" api done
  console.log(`${intro}${stack}`)
}

// /**
//  * Check the project to find out if the user intends prisma to be enabled or
//  * not.
//  */
// export async function isPrismaEnabled(): Promise<
//   | {
//       enabled: false;
//     }
//   | {
//       enabled: true;
//       schemaPath: string;
//     }
// > {
//   const schemaPath = await maybeFindPrismaSchema();

//   if (schemaPath === null) {
//     nexus-future.utils.log.trace('detected that this is not prisma framework project');
//     return { enabled: false };
//   }

//   nexus-future.utils.log.trace('detected that this is a prisma framework project');
//   return { enabled: true, schemaPath: fs.path(schemaPath) };
// }

// export function isPrismaEnabledSync():
//   | {
//       enabled: false;
//     }
//   | {
//       enabled: true;
//       schemaPath: string;
//     } {
//   const schemaPaths = fs.find({
//     directories: false,
//     recursive: true,
//     matching: [
//       'schema.prisma',
//       '!node_modules/**/*',
//       '!prisma/migrations/**/*',
//     ],
//   });

//   if (schemaPaths.length > 1) {
//     console.warn(
//       `Warning: we found multiple "schema.prisma" files in your project.\n${schemaPaths
//         .map((p, i) => `- \"${p}\"${i === 0 ? ' (used by nexus-future)' : ''}`)
//         .join('\n')}`
//     );
//   }

//   if (schemaPaths.length === 0) {
//     nexus-future.utils.log.trace('detected that this is not prisma framework project');
//     return { enabled: false };
//   }

//   nexus-future.utils.log.trace('detected that this is a prisma framework project');
//   return { enabled: true, schemaPath: fs.path(schemaPaths[0]) };
// }

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

function handleLiftResponse(
  project: NexusPlugin.Lens,
  response: SuccessfulRunResult,
  message: string,
  options: { silentStdout: boolean } = { silentStdout: false }
): boolean {
  if (response.error || response.stderr) {
    project.utils.log.error(message)

    if (response.stderr) {
      project.utils.log.error(response.stderr)
    } else if (response.error?.stack) {
      project.utils.log.error(response.error.stack)
    }
    return false
  }

  // HACK TODO: replace lift logs with nexus-future logs....
  if (response.stdout && !options.silentStdout) {
    console.log(
      response.stdout
        .replace(/prisma2 migrate up --experimental/g, 'nexus db migrate apply')
        .replace(
          /To apply the migrations, run \[92mprisma2 migrate up --experimental/g,
          ''
        )
        .replace(
          /To apply the migrations, run \[92mnexus db migrate apply\[39m/g,
          ''
        )
        .replace(/🏋️‍  migrate up --preview/g, '')
        .replace(/🏋️‍  migrate up/g, '')
    )
  }

  return true
}
