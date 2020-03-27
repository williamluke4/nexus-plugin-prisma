import chalk from 'chalk'
import { RuntimeContributions } from 'nexus-future/dist/lib/plugin'
import { getProjectRoot } from 'nexus-future/dist/lib/project-root'
import { shouldGenerateArtifacts } from 'nexus-future/dist/runtime/schema/config'
import * as NexusPlugin from 'nexus-future/plugin'
import { nexusPrismaPlugin, Options as NexusPrismaOptions } from 'nexus-prisma'
import * as Path from 'path'
import { suggestionList } from './lib/levenstein'
import { printStack } from './lib/print-stack'
import { getPrismaClientDir, getPrismaClientInstance } from './lib/prisma-client'

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

type OptionsWithHook = NexusPrismaOptions & {
  onUnknownFieldName: (params: UnknownFieldName) => void
  onUnknownFieldType: (params: UnknownFieldType) => void
}

export function runtimePlugin(_project: NexusPlugin.Lens) {
  const plugin = (): RuntimeContributions => {
    const prismaClientInstance = getPrismaClientInstance()
    const prismaClientDir = getPrismaClientDir()
    const nexusPrismaTypegenOutput = Path.join(
      getProjectRoot(),
      'node_modules',
      '@types',
      'typegen-nexus-prisma',
      'index.d.ts'
    )

    return {
      context: {
        create: _req => {
          return { db: prismaClientInstance }
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
              source: Path.join(prismaClientDir, '/index.d.ts'),
              alias: 'Prisma',
            },
          ],
        },
        plugins: [
          nexusPrismaPlugin({
            inputs: {
              prismaClient: prismaClientDir,
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
  }

  return plugin
}

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
