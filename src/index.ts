import { getPlatform } from '@prisma/get-platform'
import * as Prisma from '@prisma/sdk'
import chalk from 'chalk'
import { stripIndent } from 'common-tags'
import * as fs from 'fs-jetpack'
import getPort from 'get-port'
import { shouldGenerateArtifacts } from 'graphql-santa/dist/framework/nexus'
import * as GraphQLSantaPlugin from 'graphql-santa/dist/framework/plugin'
import { SuccessfulRunResult } from 'graphql-santa/dist/utils'
import { nexusPrismaPlugin, Options } from 'nexus-prisma'
import open from 'open'
import * as path from 'path'
import { suggestionList } from './lib/levenstein'
import { printStack } from './lib/print-stack'

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

// HACK
// 1. https://prisma-company.slack.com/archives/C8AKVD5HU/p1574267904197600
// 2. https://prisma-company.slack.com/archives/CEYCG2MCN/p1574267824465700
const GENERATED_PHOTON_OUTPUT_PATH = fs.path('node_modules/@prisma/photon')
const PROVIDER_ALIASES: Prisma.ProviderAliases = {
  photonjs: {
    // HACK (see var declaration LOC)
    outputPath: GENERATED_PHOTON_OUTPUT_PATH,
    generatorPath: require.resolve('@prisma/photon/generator-build'),
  },
}

export const create = GraphQLSantaPlugin.create(gqlSanta => {
  const nexusPrismaTypegenOutput = fs.path(
    'node_modules/@types/typegen-nexus-prisma/index.d.ts'
  )

  gqlSanta.workflow((hooks, { layout, packageManager }) => {
    gqlSanta.utils.debug('Running workflow...')
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
        fs.writeAsync(
          'prisma/schema.prisma',
          datasource +
            '\n' +
            stripIndent`
    
            generator photon {
              provider = "photonjs"
            }
    
            model World {
              id         Int     @id @default(autoincrement())
              name       String  @unique
              population Float
            }
          `
        ),
        fs.writeAsync(
          'prisma/seed.ts',
          stripIndent`
            import { Photon } from "@prisma/photon"
    
            const photon = new Photon()
            
            main()
            
            async function main() {
              const result = await photon.worlds.create({
                data: {
                  name: "Earth",
                  population: 6_000_000_000
                }
              })
            
              console.log("Seeded: %j", result)
            
              photon.disconnect()
            }
          `
        ),
        fs.writeAsync(
          layout.sourcePath('schema.ts'),
          stripIndent`
            import { app } from "graphql-santa"
    
            app.objectType({
              name: "World",
              definition(t) {
                t.model.id()
                t.model.name()
                t.model.population()
              }
            })
    
            app.queryType({
              definition(t) {
                t.field("hello", {
                  type: "World",
                  args: {
                    world: app.stringArg({ required: false })
                  },
                  async resolve(_root, args, ctx) {
                    const worldToFindByName = args.world ?? 'Earth'
                    const world = await ctx.photon.worlds.findOne({
                      where: {
                        name: worldToFindByName
                      }
                    })
    
                    if (!world) throw new Error(\`No such world named "\${args.world}"\`)
    
                    return world
                  }
                })
              }
            })
          `
        ),
      ])

      if (hctx.connectionURI || hctx.database === 'SQLite') {
        gqlSanta.utils.log.successBold('Initializing development database...')
        // TODO expose run on graphql-santa
        await packageManager.runBin(
          'prisma2 lift save --create-db --name init',
          {
            require: true,
          }
        )
        await packageManager.runBin('prisma2 lift up', { require: true })

        gqlSanta.utils.log.info('Generating photon...')
        await packageManager.runBin('prisma2 generate', { require: true })

        gqlSanta.utils.log.info('Seeding development database...')
        await packageManager.runBin('ts-node prisma/seed', {
          require: true,
        })
      } else {
        gqlSanta.utils.log.info(stripIndent`
          1. Please setup your ${
            hctx.database
          } and fill in the connection uri in your \`${chalk.greenBright(
          'prisma/schema.prisma'
        )}\` file.
        `)
        gqlSanta.utils.log.info(stripIndent`
          2. Run \`${chalk.greenBright(
            packageManager.renderRunBin('santa db init')
          )}\` to initialize your database.
        `)
        gqlSanta.utils.log.info(stripIndent`
          3. Run \`${chalk.greenBright(
            packageManager.renderRunBin('ts-node prisma/seed.ts')
          )}\` to seed your database.
        `)
        gqlSanta.utils.log.info(stripIndent`
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

    hooks.dev.onFileWatcherEvent = (_event, file) => {
      if (file.match(/.*schema\.prisma$/)) {
        gqlSanta.utils.log.info(
          chalk`Prisma Schema change detected, lifting...`
        )
        // Raw code being run is this https://github.com/prisma/lift/blob/dce60fe2c44e8a0d951d961187aec95a50a33c6f/src/cli/commands/LiftTmpPrepare.ts#L33-L45
        gqlSanta.utils.debug('running lift...')
        const result = gqlSanta.utils.run('prisma2 tmp-prepare', {
          require: true,
        })
        gqlSanta.utils.debug('done %O', result)
      }
    }

    hooks.dev.addToSettings = {
      // TODO preferably we allow schema.prisma to be anywhere but they show up in
      // migrations folder too and we don't know how to achieve semantic "anywhere
      // but migrations folder"
      watchFilePatterns: ['./schema.prisma', './prisma/schema.prisma'],
    }

    hooks.db = {
      init: {
        onStart: async () => {
          const initResponse = await packageManager.runBin(
            'prisma2 lift save --name init --create-db',
            { envAdditions: { FORCE_COLOR: 'true' } }
          )

          if (
            handleLiftResponse(
              gqlSanta,
              initResponse,
              'We could not initialize your database',
              { silentStdout: true }
            )
          ) {
            const migrateResponse = await packageManager.runBin(
              'prisma2 lift up --auto-approve',
              { envAdditions: { FORCE_COLOR: 'true' } }
            )
            if (
              handleLiftResponse(
                gqlSanta,
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
                'prisma2 lift up --preview',
                { envAdditions: { FORCE_COLOR: 'true' } }
              )

              if (
                !handleLiftResponse(
                  gqlSanta,
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

              const { confirm } = await gqlSanta.utils.prompt({
                type: 'confirm',
                name: 'confirm',
                message: 'Do you want to apply the above migration?',
              })

              if (!confirm) {
                gqlSanta.utils.log.info('Migration not applied.')
                return
              }
            }

            console.log()
            const response = await packageManager.runBin('prisma2 lift up', {
              envAdditions: { FORCE_COLOR: 'true' },
            })

            handleLiftResponse(
              gqlSanta,
              response,
              'We could not migrate your database'
            )
          },
        },
        plan: {
          onStart: async hctx => {
            let migrationName = hctx.migrationName

            if (!migrationName) {
              const inputMigration = await gqlSanta.utils.prompt({
                type: 'text',
                name: 'name',
                message: `Name of your migration`,
                validate: (value: string) =>
                  value.length > 0
                    ? true
                    : 'Your migration needs to have a least one character',
              })

              migrationName = inputMigration.name
            }

            const response = await packageManager.runBin(
              `prisma2 lift save --name=${migrationName}`,
              { envAdditions: { FORCE_COLOR: 'true' } }
            )

            handleLiftResponse(
              gqlSanta,
              response,
              'We could not generate a migration file'
            )
          },
        },
        rollback: {
          onStart: async () => {
            const response = await packageManager.runBin('prisma2 lift down', {
              envAdditions: { FORCE_COLOR: 'true' },
            })

            handleLiftResponse(
              gqlSanta,
              response,
              'We could not rollback your migration'
            )
          },
        },
      },
      ui: {
        onStart: async hctx => {
          const port = hctx.port ?? 5555
          const studio = await startStudio(port)

          if (studio?.port) {
            await open(`http://localhost:${studio.port}`)
            gqlSanta.utils.log.info(
              `Studio started at http://localhost:${studio.port}`
            )
          }
        },
      },
    }
  })

  gqlSanta.runtime(() => {
    gqlSanta.utils.debug('Running runtime...')
    const { Photon } = require('@prisma/photon')
    const photon = new Photon()

    return {
      context: {
        create: _req => {
          return { photon }
        },
        typeGen: {
          imports: [{ as: 'Photon', from: GENERATED_PHOTON_OUTPUT_PATH }],
          fields: {
            photon: 'Photon.Photon',
          },
        },
      },
      nexus: {
        plugins: [
          nexusPrismaPlugin({
            inputs: {
              photon: GENERATED_PHOTON_OUTPUT_PATH,
            },
            outputs: {
              typegen: nexusPrismaTypegenOutput,
            },
            shouldGenerateArtifacts: shouldGenerateArtifacts(),
            onUnknownFieldName: params => renderUnknownFieldNameError(params),
            onUnknownFieldType: params => renderUnknownFieldTypeError(params),
          } as OptionsWithHook),
        ],
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

    // TODO Do not assume that just because photon does not need to be regenerated that no other generators do
    if ((await shouldRegeneratePhoton(schemaPath)) === false) {
      gqlSanta.utils.debug(
        'Prisma generators were not run because the prisma schema was not updated'
      )
      return
    }

    if (!options.silent) {
      gqlSanta.utils.log.info('Running Prisma generators ...')
    }

    let generators = await getGenerators(schemaPath)

    if (!generators.find(g => g.options?.generator.provider === 'photonjs')) {
      await scaffoldPhotonGeneratorBlock(schemaPath)
      // TODO: Generate it programmatically instead for performance reason
      generators = await getGenerators(schemaPath)
    }

    for (const g of generators) {
      const resolvedSettings = getGeneratorResolvedSettings(g)

      gqlSanta.utils.debug(
        'generating %s instance %s to %s',
        resolvedSettings.name,
        resolvedSettings.instanceName,
        resolvedSettings.output
      )

      await g.generate()
      g.stop()
    }
  }

  /**
   * Find the PSL file in the project. If multiple are found a warning is logged.
   */
  async function maybeFindPrismaSchema(): Promise<null | string> {
    // TODO ...base ignores from graphql-santa... graphql-santa.fs.findAsync?
    const schemaPaths = await fs.findAsync({
      matching: [
        'schema.prisma',
        '!prisma/migrations/**/*',
        '!node_modules/**/*',
      ],
    })

    if (schemaPaths.length > 1) {
      gqlSanta.utils.log.warn(
        `We found multiple "schema.prisma" files in your project.\n${schemaPaths
          .map((p, i) => `- "${p}"${i === 0 ? ' (used by graphql-santa)' : ''}`)
          .join('\n')}`
      )
    }

    return schemaPaths[0] ?? null
  }

  /**
   * Regenerate photon only if schema was updated between last generation
   */
  async function shouldRegeneratePhoton(
    localSchemaPath: string
  ): Promise<boolean> {
    const photonSchemaPath = path.join(
      GENERATED_PHOTON_OUTPUT_PATH,
      'schema.prisma'
    )

    gqlSanta.utils.debug(
      "checking if photon needs to be regenerated by comparing users PSL to photon's local copy...\n%s\n%s",
      photonSchemaPath,
      localSchemaPath
    )

    const [photonSchema, localSchema] = await Promise.all([
      fs.readAsync(photonSchemaPath),
      fs.readAsync(localSchemaPath),
    ])

    if (photonSchema !== undefined && localSchema !== undefined) {
      gqlSanta.utils.debug('...found photon and its local version of PSL')
      if (photonSchema === localSchema) {
        gqlSanta.utils.debug(
          "...found that its local PSL version matches user's current, will NOT regenerate photon"
        )
        return false
      } else {
        gqlSanta.utils.debug(
          "...found that its local PSL version does not match user's current, WILL regenerate photon"
        )
        return true
      }
    } else {
      gqlSanta.utils.debug(
        '...did not find generated photon package or its local copy of PSL'
      )
      return true
    }
  }

  async function scaffoldPhotonGeneratorBlock(schemaPath: string) {
    const schemaPathAbs = path.relative(process.cwd(), schemaPath)
    gqlSanta.utils.log.warn(
      `A PhotonJS generator block is needed in your Prisma Schema at "${schemaPathAbs}".`
    )
    gqlSanta.utils.log.warn('We scaffolded one for you.')
    const schemaContent = await fs.readAsync(schemaPath)!
    const generatorBlock = stripIndent`
      generator photon {
        provider = "photonjs"
      }
    `
    await fs.writeAsync(schemaPath, `${generatorBlock}\n${schemaContent}`)
  }

  async function startStudio(
    port: number | undefined
  ): Promise<{ port: number } | null> {
    try {
      const platform = await getPlatform()
      const extension = platform === 'windows' ? '.exe' : ''

      const pathCandidates = [
        // ncc go home
        // tslint:disable-next-line
        path.join(
          __dirname,
          `../../@prisma/sdk/query-engine-${platform}${extension}`
        ),
      ]

      const pathsExist = await Promise.all(
        pathCandidates.map(async candidate => ({
          exists: fs.exists(candidate),
          path: candidate,
        }))
      )

      const firstExistingPath = pathsExist.find(p => p.exists)

      if (!firstExistingPath) {
        throw new Error(
          `Could not find any Prisma2 query-engine binary for Studio. Looked in ${pathCandidates.join(
            ', '
          )}`
        )
      }

      const StudioServer = (await import('@prisma/studio-server')).default

      let photonWorkerPath: string | undefined
      try {
        const studioTransport = require.resolve('@prisma/studio-transports')
        photonWorkerPath = path.join(
          path.dirname(studioTransport),
          'photon-worker.js'
        )
      } catch (e) {
        gqlSanta.utils.log.error(e)
        return null
      }

      if (!port) {
        port = await getPort({ port: getPort.makeRange(5555, 5600) })
      }

      const schema = await maybeFindPrismaSchema()

      if (!schema) {
        gqlSanta.utils.log.error('We could not find your schema.prisma file')
        return null
      }

      const instance = new StudioServer({
        port,
        debug: false,
        binaryPath: firstExistingPath.path,
        photonWorkerPath,
        photonGenerator: {
          providerAliases: PROVIDER_ALIASES,
          // TODO this version should stay in sync with what the yarn lock file
          // contains for entry @prisma/photo
          // version: '2.0.0-preview018.2',
          version: '2.0.0-alpha.467',
        },
        schemaPath: schema,
        reactAppDir: path.join(
          path.dirname(require.resolve('@prisma/studio/package.json')),
          'build'
        ),
      })

      await instance.start()

      return { port }
    } catch (e) {
      gqlSanta.utils.log.error(e)
    }

    return null
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
//     graphql-santa.utils.debug('detected that this is not prisma framework project');
//     return { enabled: false };
//   }

//   graphql-santa.utils.debug('detected that this is a prisma framework project');
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
//         .map((p, i) => `- \"${p}\"${i === 0 ? ' (used by graphql-santa)' : ''}`)
//         .join('\n')}`
//     );
//   }

//   if (schemaPaths.length === 0) {
//     graphql-santa.utils.debug('detected that this is not prisma framework project');
//     return { enabled: false };
//   }

//   graphql-santa.utils.debug('detected that this is a prisma framework project');
//   return { enabled: true, schemaPath: fs.path(schemaPaths[0]) };
// }

/**
 * Get the declared generator blocks in the user's PSL file
 */
async function getGenerators(schemaPath: string) {
  return await Prisma.getGenerators({
    schemaPath,
    printDownloadProgress: false,
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

type Database = Exclude<
  GraphQLSantaPlugin.OnAfterBaseSetupLens['database'],
  undefined
>
type ConnectionURI = GraphQLSantaPlugin.OnAfterBaseSetupLens['connectionURI']

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

  return stripIndent`
    datasource db {
      provider = "${provider}"
      url      = "${renderConnectionURI(db, projectName)}"
    }`
}

const DATABASE_TO_CONNECTION_URI: Record<
  Database,
  (projectName: string) => string
> = {
  SQLite: _ => 'file://dev.db',
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
  gqlSanta: GraphQLSantaPlugin.Lens,
  response: SuccessfulRunResult,
  message: string,
  options: { silentStdout: boolean } = { silentStdout: false }
): boolean {
  if (response.error || response.stderr) {
    gqlSanta.utils.log.error(message)

    if (response.stderr) {
      gqlSanta.utils.log.error(response.stderr)
    } else if (response.error?.stack) {
      gqlSanta.utils.log.error(response.error.stack)
    }
    return false
  }

  // HACK TODO: replace lift logs with graphql-santa logs....
  if (response.stdout && !options.silentStdout) {
    console.log(
      response.stdout
        .replace(/Lift/g, 'graphql-santa')
        .replace(/prisma2 lift up/g, 'santa db migrate apply')
        .replace(/🏋️‍ lift up --preview/g, '')
        .replace(/🏋️‍ lift up/g, '')
        .replace(/📼 {2}lift save --name init/, '')
        .replace(/To apply the migrations, run santa db migrate apply/g, '')
    )
  }

  return true
}
